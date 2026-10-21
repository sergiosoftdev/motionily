import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";

/** Not a real video: ffmpeg cannot read it, so the clip has no length or contact sheet (the editor still gets it). */
const CLIP = Buffer.from("not really an mp4");

let mongo: MongoMemoryServer;
let app: INestApplication;
let http: ReturnType<typeof request>;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri("motionily-footage-test");
  process.env.JWT_SECRET = "test-secret";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app, "http://localhost:5173");
  await app.init();
  http = request(app.getHttpServer());
});

after(async () => {
  await app?.close();
  await mongo?.stop();
});

async function login(email: string) {
  const res = await http.post("/auth/mock-google").send({ email }).expect(201);
  return { Authorization: `Bearer ${res.body.token as string}` };
}

describe("Footage: the user's own clips", () => {
  it("uploads clips as c1, c2, keeps their transcript and language, and deletes them", async () => {
    const auth = await login("footage@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "My take" }).expect(201);
    assert.deepEqual(p.footage, []);

    const one = await http.post(`/projects/${p.id}/footage`).set(auth).field("language", "es").attach("file", CLIP, { filename: "take1.mov", contentType: "video/quicktime" }).expect(201);
    const two = await http.post(`/projects/${p.id}/footage`).set(auth).attach("file", CLIP, { filename: "take2.mp4", contentType: "video/mp4" }).expect(201);
    assert.deepEqual(
      two.body.footage.map((c: { id: string; name: string; language: string; words: unknown }) => [c.id, c.name, c.language, c.words]),
      [
        ["c1", "take1.mov", "es", null],
        ["c2", "take2.mp4", "en", null],
      ],
    );
    assert.equal(one.body.footage[0].duration, null);
    await http.get(one.body.footage[0].url).expect(200);

    await http.post(`/projects/${p.id}/footage`).set(auth).attach("file", Buffer.from("x"), { filename: "notes.txt", contentType: "text/plain" }).expect(400);
    await http.post(`/projects/${p.id}/footage`).set(auth).field("language", "klingon").attach("file", CLIP, { filename: "t.mp4", contentType: "video/mp4" }).expect(400);

    const words = [
      { text: "Hola", start: 0.4, end: 0.8 },
      { text: "a", start: 0.85, end: 0.9 },
      { text: "todos.", start: 0.95, end: 1.4 },
    ];
    const saved = await http.put(`/projects/${p.id}/footage/c1/words`).set(auth).send({ words }).expect(200);
    assert.deepEqual(saved.body.footage[0].words, words);
    await http.put(`/projects/${p.id}/footage/c9/words`).set(auth).send({ words }).expect(404);
    await http.put(`/projects/${p.id}/footage/c1/words`).set(auth).send({ words: [{ text: "x", start: -1, end: 1 }] }).expect(400);

    const other = await login("intruder@example.com");
    await http.put(`/projects/${p.id}/footage/c1/words`).set(other).send({ words }).expect(404);
    await http.delete(`/projects/${p.id}/footage/c1`).set(other).expect(404);

    const left = await http.delete(`/projects/${p.id}/footage/c1`).set(auth).expect(200);
    assert.deepEqual(left.body.footage.map((c: { id: string }) => c.id), ["c2"]);
    await http.get(one.body.footage[0].url).expect(404);
    // New clips take the number after the highest one left.
    const three = await http.post(`/projects/${p.id}/footage`).set(auth).attach("file", CLIP, { filename: "take3.mp4", contentType: "video/mp4" }).expect(201);
    assert.deepEqual(three.body.footage.map((c: { id: string }) => c.id), ["c2", "c3"]);

    // Deleting the video deletes its clips.
    await http.delete(`/projects/${p.id}`).set(auth).expect(204);
    await http.get(three.body.footage[1].url).expect(404);
  });
});
