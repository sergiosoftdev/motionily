import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import sharp from "sharp";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { testDatabase } from "./db";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";
import { MEDIA_DIR } from "../src/media";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let db: Awaited<ReturnType<typeof testDatabase>>;
let app: INestApplication;
let http: ReturnType<typeof request>;

/** One second of silence as a 16-bit mono WAV. */
function wav(seconds: number, rate = 8000): Buffer {
  const data = Buffer.alloc(seconds * rate * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

before(async () => {
  db = await testDatabase("motionily-media-pool-test");
  process.env.JWT_SECRET = "test-secret";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app, "http://localhost:5173");
  await app.init();
  http = request(app.getHttpServer());
});

after(async () => {
  await app?.close();
  await db?.stop();
});

describe("media pool", () => {
  it("keeps sounds, pictures and LUTs with their length and size, refuses videos, and removes them", async () => {
    const login = await http.post("/auth/mock-google").send({ email: "pool@motionily.local" }).expect(201);
    const auth = { Authorization: `Bearer ${login.body.token as string}` };
    const project = await http.post("/projects").set(auth).send({ name: "Pool", format: "square_1_1" }).expect(201);
    const base = `/projects/${project.body.id as string}/media`;

    const song = await http.post(base).set(auth).attach("file", wav(2), { filename: "beat.wav", contentType: "audio/wav" }).expect(201);
    assert.equal(song.body.kind, "audio");
    assert.equal(song.body.name, "beat.wav");
    assert.match(song.body.url, /^\/media\/[a-f0-9-]{36}\.wav$/);
    // ffprobe measures it where it is installed (CI and the desktop app have it).
    if (song.body.duration !== null) assert.ok(Math.abs(song.body.duration - 2) < 0.05, String(song.body.duration));

    const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const photo = await http.post(base).set(auth).attach("file", png, { filename: "logo.png", contentType: "image/png" }).expect(201);
    assert.deepEqual([photo.body.kind, photo.body.width, photo.body.height], ["image", 64, 32]);

    await http.post(base).set(auth).attach("file", Buffer.from("x"), { filename: "clip.mp4", contentType: "video/mp4" }).expect(400);

    // LUTs come with no registered type; the extension says it, the contents must be a .cube.
    const cube = "TITLE \"warm\"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
    const lut = await http.post(base).set(auth).attach("file", Buffer.from(cube), { filename: "warm.cube", contentType: "application/octet-stream" }).expect(201);
    assert.deepEqual([lut.body.kind, lut.body.name], ["lut", "warm.cube"]);
    assert.match(lut.body.url, /^\/media\/[a-f0-9-]{36}\.cube$/);
    await http.post(base).set(auth).attach("file", Buffer.from("hello"), { filename: "fake.cube", contentType: "application/octet-stream" }).expect(400);

    const list = await http.get(base).set(auth).expect(200);
    assert.deepEqual(list.body.map((m: { id: string }) => m.id), ["m1", "m2", "m3"]);
    await http.delete(`${base}/m1`).set(auth).expect(200);
    assert.deepEqual((await http.get(base).set(auth).expect(200)).body.map((m: { id: string }) => m.id), ["m2", "m3"]);
    await http.delete(`${base}/m1`).set(auth).expect(404);
  });

  it("cleans a sound into a new one (denoise, voice isolation) and only the video's own sounds", async () => {
    const login = await http.post("/auth/mock-google").send({ email: "clean@motionily.local" }).expect(201);
    const auth = { Authorization: `Bearer ${login.body.token as string}` };
    const project = await http.post("/projects").set(auth).send({ name: "Clean", format: "square_1_1" }).expect(201);
    const base = `/projects/${project.body.id as string}/media`;
    // Noise to clean: a 440 Hz tone under white noise.
    const noisy = wav(2, 16000);
    for (let i = 44; i < noisy.length; i += 2) noisy.writeInt16LE(Math.round(6000 * Math.sin((i / 2) * 0.17) + (Math.random() - 0.5) * 4000), i);
    const sound = await http.post(base).set(auth).attach("file", noisy, { filename: "take.wav", contentType: "audio/wav" }).expect(201);
    for (const mode of ["denoise", "voice"]) {
      const out = await http.post(`${base}/clean`).set(auth).send({ source: sound.body.url, mode }).expect(201);
      assert.equal(out.body.kind, "audio");
      assert.match(out.body.name, mode === "voice" ? /voice isolated/ : /denoised/);
      assert.ok(Math.abs(out.body.duration - 2) < 0.1, `same length: ${out.body.duration}`);
    }
    await http.post(`${base}/clean`).set(auth).send({ source: "/media/not-mine.wav", mode: "voice" }).expect(400);
    await http.post(`${base}/clean`).set(auth).send({ source: "voice", mode: "denoise" }).expect(400);
    await http.post(`${base}/clean`).set(auth).send({ source: sound.body.url, mode: "louder" }).expect(400);
  });

  it("lists missing files and relinks them from a folder by name and size (desktop app)", async () => {
    const login = await http.post("/auth/mock-google").send({ email: "relink@motionily.local" }).expect(201);
    const auth = { Authorization: `Bearer ${login.body.token as string}` };
    const project = await http.post("/projects").set(auth).send({ name: "Relink", format: "square_1_1" }).expect(201);
    const base = `/projects/${project.body.id as string}/media`;
    const bytes = wav(1);
    const sound = await http.post(base).set(auth).attach("file", bytes, { filename: "take 3.wav", contentType: "audio/wav" }).expect(201);
    assert.deepEqual((await http.get(`${base}/missing`).set(auth).expect(200)).body, []);
    // The file goes missing; a copy sits in a folder with its original name.
    await unlink(join(MEDIA_DIR, sound.body.file as string));
    const missing = (await http.get(`${base}/missing`).set(auth).expect(200)).body;
    assert.equal(missing.length, 1);
    assert.equal(missing[0].name, "take 3.wav");
    const folder = await mkdtemp(join(tmpdir(), "relink-"));
    await mkdir(join(folder, "day 2"));
    await writeFile(join(folder, "day 2", "Take 3.wav"), bytes);
    const prev = process.env.MOTIONILY_DESKTOP;
    process.env.MOTIONILY_DESKTOP = "1";
    try {
      const r = await http.post(`${base}/relink`).set(auth).send({ folder }).expect(201);
      assert.equal(r.body.relinked.length, 1);
      assert.deepEqual(r.body.missing, []);
    } finally {
      process.env.MOTIONILY_DESKTOP = prev;
    }
    assert.ok((await readFile(join(MEDIA_DIR, sound.body.file as string))).equals(bytes), "the file is back under its name");
    assert.deepEqual((await http.get(`${base}/missing`).set(auth).expect(200)).body, []);
  });

  it("puts pool items in bins and back at the top", async () => {
    const login = await http.post("/auth/mock-google").send({ email: "bins@motionily.local" }).expect(201);
    const auth = { Authorization: `Bearer ${login.body.token as string}` };
    const project = await http.post("/projects").set(auth).send({ name: "Bins", format: "square_1_1" }).expect(201);
    const base = `/projects/${project.body.id as string}/media`;
    const a = await http.post(base).set(auth).attach("file", wav(1), { filename: "a.wav", contentType: "audio/wav" }).expect(201);
    await http.post(`${base}/bin`).set(auth).send({ ids: [a.body.id], bin: "Room tone" }).expect(201);
    assert.equal((await http.get(base).set(auth).expect(200)).body[0].bin, "Room tone");
    await http.post(`${base}/bin`).set(auth).send({ ids: [a.body.id], bin: null }).expect(201);
    assert.equal((await http.get(base).set(auth).expect(200)).body[0].bin, null);
    await http.post(`${base}/bin`).set(auth).send({ ids: ["m99"], bin: "x" }).expect(400);
  });

  it("lets the video's agent import from a URL, and keeps account tokens out", async () => {
    const login = await http.post("/auth/mock-google").send({ email: "pool-agent@motionily.local" }).expect(201);
    const auth = { Authorization: `Bearer ${login.body.token as string}` };
    const project = await http.post("/projects").set(auth).send({ name: "Agent pool", format: "square_1_1" }).expect(201);
    const pid = project.body.id as string;
    const agent = await http.post(`/projects/${pid}/agent-token`).set(auth).expect(201);
    const asAgent = { Authorization: `Bearer ${agent.body.token as string}` };
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(wav(1));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hit.wav`;
      const item = await http.post(`/projects/${pid}/media/import`).set(asAgent).send({ source: url }).expect(201);
      assert.deepEqual([item.body.kind, item.body.name], ["audio", "hit.wav"]);
      await http.post(`/projects/${pid}/media/import`).set(asAgent).send({ source: "/etc/hosts" }).expect(400);
      await http.post(`/projects/${pid}/media/import`).set(asAgent).send({ source: "ftp://x/y.wav" }).expect(400);
      const account = await http.post("/auth/agent-token").set(auth).expect(201);
      await http.get(`/projects/${pid}/media`).set({ Authorization: `Bearer ${account.body.token as string}` }).expect(403);
    } finally {
      server.close();
    }
  });
});
