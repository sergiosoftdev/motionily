import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import sharp from "sharp";
import { testDatabase } from "./db";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";

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
  it("keeps sounds and pictures with their length and size, refuses videos, and removes them", async () => {
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

    const list = await http.get(base).set(auth).expect(200);
    assert.deepEqual(list.body.map((m: { id: string }) => m.id), ["m1", "m2"]);
    await http.delete(`${base}/m1`).set(auth).expect(200);
    assert.deepEqual((await http.get(base).set(auth).expect(200)).body.map((m: { id: string }) => m.id), ["m2"]);
    await http.delete(`${base}/m1`).set(auth).expect(404);
  });
});
