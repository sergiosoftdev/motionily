import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";

const MP4 = Buffer.from("fake mp4 bytes");
const HOUR = 3_600_000;

/** Stands in for `claude -p`: echoes the platforms it was asked for, with messy hashtags to clean. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const platforms = /Platforms: (.*)/.exec(prompt)[1].split(", ");
const copy = platforms.map((platform) => ({ platform, caption: "A dead man fooled Hitler. " + platform, hashtags: ["#History", "history", "WW2!", ""] }));
process.stdout.write(JSON.stringify({ result: "Here you go: " + JSON.stringify({ copy }), total_cost_usd: 0 }));
`;

let mongo: MongoMemoryServer;
let app: INestApplication;
let http: ReturnType<typeof request>;

before(async () => {
  const bin = join(mkdtempSync(join(tmpdir(), "motionily-fake-claude-")), "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri("motionily-posts-test");
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
  await mongo?.stop();
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
