import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { testDatabase } from "./db";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";

let db: Awaited<ReturnType<typeof testDatabase>>;
let app: INestApplication;
let http: ReturnType<typeof request>;

before(async () => {
  db = await testDatabase("motionily-versions-test");
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

describe("scene versions", () => {
  it("keeps the replaced scene (once a minute), named snapshots, and gives any back", async () => {
    const login = await http.post("/auth/mock-google").send({ email: "versions@motionily.local" }).expect(201);
    const auth = { Authorization: `Bearer ${login.body.token as string}` };
    const project = await http.post("/projects").set(auth).send({ name: "History", format: "square_1_1" }).expect(201);
    const base = `/projects/${project.body.id as string}`;
    const scene = (n: number) => ({ width: 1080, height: 1080, fps: 30, duration: 4, layers: Array.from({ length: n }, (_, i) => ({ id: `l${i}`, type: "shape", shape: "rect", w: 10, h: 10 })) });
    const initial = (await http.get(base).set(auth).expect(200)).body.sceneRevision as number;
    let rev = (await http.put(`${base}/scene`).set(auth).send({ scene: scene(2), baseRevision: initial }).expect(200)).body.sceneRevision as number;
    rev = (await http.put(`${base}/scene`).set(auth).send({ scene: scene(5), baseRevision: rev }).expect(200)).body.sceneRevision;
    // Within the minute: autosave does not add another one.
    rev = (await http.put(`${base}/scene`).set(auth).send({ scene: scene(1), baseRevision: rev }).expect(200)).body.sceneRevision;
    const auto = (await http.get(`${base}/versions`).set(auth).expect(200)).body as { id: string; layers: number; label: string }[];
    assert.ok(auto.length >= 1 && auto.length <= 2, String(auto.length));
    const snap = await http.post(`${base}/versions`).set(auth).send({ label: "before the color pass" }).expect(201);
    assert.equal(snap.body.label, "before the color pass");
    const list = (await http.get(`${base}/versions`).set(auth).expect(200)).body as { id: string; layers: number; label: string }[];
    assert.equal(list[0]!.label, "before the color pass");
    assert.equal(list[0]!.layers, 1);
    const two = list.find((v) => v.layers === 2)!;
    const back = await http.get(`${base}/versions/${two.id}`).set(auth).expect(200);
    assert.equal(back.body.scene.layers.length, 2);
    await http.get(`${base}/versions/000000000000000000000000`).set(auth).expect(404);
  });
});
