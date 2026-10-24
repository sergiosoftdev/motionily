import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { testDatabase } from "./db";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";

const MP4 = Buffer.from("fake mp4 bytes");
const HOUR = 3_600_000;

/** Stands in for `claude -p`: echoes the platforms it was asked for, with messy hashtags to clean. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const prompt = process.argv[process.argv.indexOf("-p") + 1];
if (prompt.includes("Timeline:")) {
  const suno = { title: "Dead Man's Drop", style: "dark cinematic orchestral, tense strings, 90 bpm, instrumental, no vocals", structure: "[Intro: low drone]\\n[Drop: full orchestra hit]", drop_at: 3, notes: prompt.includes("Change: darker") ? "darker" : "Turn Instrumental on." };
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify(suno), total_cost_usd: 0 }));
  process.exit(0);
}
const platforms = /Platforms: (.*)/.exec(prompt)[1].split(", ");
const copy = platforms.map((platform) => ({ platform, caption: "A dead man fooled Hitler. " + platform, hashtags: ["#History", "history", "WW2!", ""] }));
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "Here you go: " + JSON.stringify({ copy }), total_cost_usd: 0 }));
`;

let db: Awaited<ReturnType<typeof testDatabase>>;
let app: INestApplication;
let http: ReturnType<typeof request>;

before(async () => {
  const bin = join(mkdtempSync(join(tmpdir(), "motionily-fake-claude-")), "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  db = await testDatabase("motionily-posts-test");
  process.env.JWT_SECRET = "test-secret";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app, "http://localhost:5173");
  await app.init();
  http = request(app.getHttpServer());
});

after(async () => {
  delete process.env.CLAUDE_BIN;
  await app?.close();
  await db?.stop();
});

async function login(email: string) {
  const res = await http.post("/auth/mock-google").send({ email }).expect(201);
  return { Authorization: `Bearer ${res.body.token as string}` };
}

describe("Posting calendar", () => {
  it("writes a caption and clean hashtags for each platform", async () => {
    const auth = await login("posts@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "Mincemeat", voiceScript: "[intrigued] A dead man fooled Hitler." }).expect(201);
    const res = await http.post("/posts/copy").set(auth).send({ projectId: p.id, platforms: ["instagram", "tiktok"] }).expect(200);
    assert.deepEqual(res.body.copy, [
      { platform: "instagram", caption: "A dead man fooled Hitler. instagram", hashtags: ["history", "WW2"] },
      { platform: "tiktok", caption: "A dead man fooled Hitler. tiktok", hashtags: ["history", "WW2"] },
    ]);
    await http.post("/posts/copy").set(auth).send({ projectId: p.id, platforms: ["myspace"] }).expect(400);
    // The draft stays with the video, and the user's edits replace it.
    const saved = await http.get(`/projects/${p.id}`).set(auth).expect(200);
    assert.deepEqual(saved.body.postCopy.map((c: { platform: string }) => c.platform), ["instagram", "tiktok"]);
    const edited = [{ platform: "instagram", caption: "My own words", hashtags: ["ww2"] }];
    const after = await http.patch(`/projects/${p.id}`).set(auth).send({ postCopy: edited }).expect(200);
    assert.deepEqual(after.body.postCopy, edited);
  });

  it("writes a Suno prompt for the video's music, keeps it, and fits the uploaded song to its drop", async () => {
    const auth = await login("posts@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "Song", voiceScript: "A dead man fooled Hitler." }).expect(201);
    await http.put(`/projects/${p.id}/scene`).set(auth).send({ scene: { version: 1, duration: 6, captions: { words: [{ text: "Hi", start: 0.5, end: 0.9 }] } }, baseRevision: 0 }).expect(200);
    const res = await http.post(`/projects/${p.id}/suno-prompt`).set(auth).send({}).expect(200);
    assert.equal(res.body.dropAt, 3);
    assert.match(res.body.style, /instrumental, no vocals$/);
    assert.equal((await http.get(`/projects/${p.id}`).set(auth).expect(200)).body.sunoPrompt.title, "Dead Man's Drop");
    const darker = await http.post(`/projects/${p.id}/suno-prompt`).set(auth).send({ steer: "darker" }).expect(200);
    assert.equal(darker.body.notes, "darker");

    // A 20 s song: 8 s of near silence, then loud. Its rise (8 s) is near the drop (3 s after the skipped intro): start at 5 s.
    // At the rate songs really come in (44.1 kHz stereo), so the measuring windows stay half a second.
    const song = await http.post(`/projects/${p.id}/music`).set(auth).attach("file", wav(20, 8, 44100, 2), { filename: "song.wav", contentType: "audio/wav" }).expect(201);
    assert.equal(song.body.music.trimIn, 5);
    assert.match(song.body.music.summary, /quiet intro to 8\.0 s.*20 s long/);
    assert.equal(song.body.music.duration, 20);
  });

  it("schedules a video with its text and file, and spots edits made after rendering", async () => {
    const auth = await login("posts@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "Scheduled" }).expect(201);
    const at = new Date(Date.now() + 24 * HOUR).toISOString();
    const instagram = { platform: "instagram", caption: "Hook line", hashtags: ["history"] };
    const { body: post } = await http.post("/posts").set(auth).send({ projectId: p.id, scheduledAt: at, platforms: ["instagram", "tiktok"], copy: [instagram] }).expect(201);
    assert.equal(post.projectName, "Scheduled");
    assert.equal(post.due, false);
    assert.deepEqual(post.copy, [instagram, { platform: "tiktok", caption: "", hashtags: [] }]);

    await http.post("/posts").set(auth).send({ projectId: p.id, scheduledAt: at, platforms: ["tiktok"], copy: [instagram] }).expect(400);
    await http.post("/posts").set(auth).send({ projectId: p.id, scheduledAt: at, platforms: ["instagram"], copy: [{ ...instagram, hashtags: ["two words"] }] }).expect(400);

    const up = await http.post(`/posts/${post.id}/video`).set(auth).field("sceneRevision", "0").attach("file", MP4, { filename: "Scheduled.mp4", contentType: "video/mp4" }).expect(201);
    assert.equal(up.body.video.outdated, false);
    const served = await http.get(up.body.video.url).expect(200);
    assert.equal(Buffer.from(served.body as Buffer).toString(), MP4.toString());

    await http.put(`/projects/${p.id}/scene`).set(auth).send({ scene: { version: 1 }, baseRevision: 0 }).expect(200);
    const [listed, ...rest] = (await http.get("/posts").set(auth).query({ projectId: p.id }).expect(200)).body;
    assert.equal(rest.length, 0);
    assert.equal(listed.id, post.id);
    assert.equal(listed.video.outdated, true);

    // A new render replaces the old file.
    await http.post(`/posts/${post.id}/video`).set(auth).field("sceneRevision", "1").attach("file", MP4, { filename: "Scheduled.mp4", contentType: "video/mp4" }).expect(201);
    await http.get(up.body.video.url).expect(404);
  });

  it("lists what is due until it is marked posted, and only for its owner", async () => {
    const auth = await login("due@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "Due" }).expect(201);
    const past = new Date(Date.now() - HOUR).toISOString();
    const future = new Date(Date.now() + HOUR).toISOString();
    const { body: due } = await http.post("/posts").set(auth).send({ projectId: p.id, scheduledAt: past, platforms: ["tiktok"], copy: [] }).expect(201);
    await http.post("/posts").set(auth).send({ projectId: p.id, scheduledAt: future, platforms: ["tiktok"], copy: [] }).expect(201);
    assert.equal(due.due, true);
    assert.deepEqual((await http.get("/posts?due=1").set(auth).expect(200)).body.map((x: { id: string }) => x.id), [due.id]);

    const other = await login("someone@example.com");
    assert.deepEqual((await http.get("/posts").set(other).expect(200)).body, []);
    await http.patch(`/posts/${due.id}`).set(other).send({ status: "posted" }).expect(404);
    await http.delete(`/posts/${due.id}`).set(other).expect(404);

    const posted = await http.patch(`/posts/${due.id}`).set(auth).send({ status: "posted" }).expect(200);
    assert.equal(posted.body.due, false);
    assert.ok(posted.body.postedAt);
    assert.deepEqual((await http.get("/posts?due=1").set(auth).expect(200)).body, []);

    await http.delete(`/posts/${due.id}`).set(auth).expect(204);
    assert.equal((await http.get("/posts").set(auth).expect(200)).body.length, 1);
  });
});

/** 16-bit WAV: `quiet` seconds of near silence, then a loud tone until `seconds`. */
function wav(seconds: number, quiet: number, rate = 8000, channels = 1) {
  const n = seconds * rate;
  const bytes = n * channels * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round((i < quiet * rate ? 30 : 20000) * Math.sin((2 * Math.PI * 220 * i) / rate));
    for (let c = 0; c < channels; c++) buf.writeInt16LE(v, 44 + (i * channels + c) * 2);
  }
  return buf;
}
