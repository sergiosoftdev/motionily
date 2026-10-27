import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { testDatabase } from "./db";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";

let db: Awaited<ReturnType<typeof testDatabase>>;
let app: INestApplication;
let http: ReturnType<typeof request>;

before(async () => {
  db = await testDatabase("motionily-series-test");
  process.env.JWT_SECRET = "test-secret";
  process.env.SOCIAL_SYNC_HOURS = "0";
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

async function login(email: string) {
  const res = await http.post("/auth/mock-google").send({ email }).expect(201);
  return { Authorization: `Bearer ${res.body.token as string}` };
}

/** What seriesBlueprint() measures from a scene (the client sends it). */
const blueprint = {
  width: 1080,
  height: 1350,
  fps: 30,
  duration: 12,
  beats: [
    { group: "hook", start: 0, end: 3, texts: ["Bulls don't hate red."], kinds: { text: 1 } },
    { group: "why", start: 3, end: 9, texts: ["They hate the motion."], kinds: { text: 2, image: 1 } },
  ],
  rehooks: [0, 3, 9],
  transitions: [],
  captions: { style: "pop_word", shown: true },
  typography: { family: "Fraunces" },
  palette: { background: "#111111", primary: "#e9573f" },
  sfx: [{ at: 3, sound: "whoosh" }],
  music: true,
  voice: { wordsPerSecond: 2.6, firstWordAt: 0.2 },
  layers: 4,
};

describe("Series templates", () => {
  it("saves a video's structure, makes episodes from it and lets the episode's agent read it", async () => {
    const auth = await login("series@example.com");
    const { body: source } = await http.post("/projects").set(auth).send({ name: "Bulls", format: "portrait_4_5" }).expect(201);

    await http.post(`/projects/${source.id}/series`).set(auth).send({ name: "Myths", blueprint: { beats: "nope" } }).expect(400);
    const { body: series } = await http.post(`/projects/${source.id}/series`).set(auth).send({ name: " Myths busted ", note: "Hook with a myth, payoff by 9 s", blueprint }).expect(201);
    assert.equal(series.name, "Myths busted");
    assert.equal(series.format, "portrait_4_5");
    assert.equal(series.sourceName, "Bulls");
    assert.deepEqual(series.performance, [], "not posted: no numbers");
    assert.equal(series.blueprint.beats.length, 2);

    // An episode takes the series' format and points back to it.
    const { body: episode } = await http.post("/projects").set(auth).send({ name: "Goldfish memory", brief: "Goldfish remember for months", seriesId: series.id }).expect(201);
    assert.equal(episode.format, "portrait_4_5");
    assert.equal(episode.seriesId, series.id);
    const { body: list } = await http.get("/series").set(auth).expect(200);
    assert.equal(list.length, 1);
    assert.equal(list[0].episodes, 1);

    // The episode's agent reads its series; the series list stays the user's.
    const { body: token } = await http.post(`/projects/${episode.id}/agent-token`).set(auth).expect(201);
    const agent = { Authorization: `Bearer ${token.token as string}` };
    const { body: of } = await http.get(`/projects/${episode.id}/series`).set(agent).expect(200);
    assert.equal(of.series.name, "Myths busted");
    assert.equal(of.series.blueprint.captions.style, "pop_word");
    await http.get(`/projects/${source.id}/series`).set(agent).expect(403);
    await http.get("/series").set(agent).expect(403);
    // The agent may save its own video as a series too.
    await http.post(`/projects/${episode.id}/series`).set(agent).send({ name: "From the agent", blueprint }).expect(201);

    // Someone else's series cannot be joined.
    const other = await login("other-series@example.com");
    await http.post("/projects").set(other).send({ name: "Nope", seriesId: series.id }).expect(400);

    const { body: renamed } = await http.patch(`/series/${series.id}`).set(auth).send({ note: "Myth first, payoff at 9 s" }).expect(200);
    assert.equal(renamed.note, "Myth first, payoff at 9 s");
    await http.delete(`/series/${series.id}`).set(auth).expect(204);
    const { body: after } = await http.get(`/projects/${episode.id}`).set(auth).expect(200);
    assert.equal(after.seriesId, null, "its episodes stay as ordinary videos");
  });
});
