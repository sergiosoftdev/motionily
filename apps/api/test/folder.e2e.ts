import "reflect-metadata";
import "./desktop-env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { testDatabase } from "./db";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";

let db: Awaited<ReturnType<typeof testDatabase>>;
let app: INestApplication;
let http: ReturnType<typeof request>;
const media = process.env.MEDIA_DIR!;
const out = mkdtempSync(join(tmpdir(), "motionily-folders-"));
const IMAGE = "0f6b7a52-3c1e-4c55-9b7a-0d3f1e2a4b5c.png";

before(async () => {
  db = await testDatabase("motionily-folder-test");
  process.env.JWT_SECRET = "test-secret";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app, "http://localhost:5173");
  await app.init();
  http = request(app.getHttpServer());
});

after(async () => {
  delete process.env.MOTIONILY_DESKTOP;
  await app?.close();
  await db?.stop();
});

describe("project folders (desktop)", () => {
  it("saves a project with its media as a folder and opens it again", async () => {
    const login = await http.post("/auth/mock-google").send({ email: "folders@motionily.local" }).expect(201);
    const auth = { Authorization: `Bearer ${login.body.token as string}` };
    const project = await http.post("/projects").set(auth).send({ name: "Trip / Recap", format: "square_1_1" }).expect(201);
    const scene = { width: 1080, height: 1080, fps: 30, duration: 3, layers: [{ id: "photo", type: "image", src: `/media/${IMAGE}` }] };
    writeFileSync(join(media, IMAGE), "png bytes");
    await http.put(`/projects/${project.body.id as string}/scene`).set(auth).send({ scene, baseRevision: 0 }).expect(200);

    const saved = await http.post(`/projects/${project.body.id as string}/folder`).set(auth).send({ path: out }).expect(201);
    const folder = saved.body.folder as string;
    assert.equal(folder, join(out, "Trip - Recap.motionily"));
    assert.equal(saved.body.media, 1);
    assert.equal(readFileSync(join(folder, "media", IMAGE), "utf8"), "png bytes");
    const manifest = JSON.parse(readFileSync(join(folder, "project.json"), "utf8"));
    assert.equal(manifest.project.scene.layers[0].src, `/media/${IMAGE}`);
    assert.equal(manifest.project.ownerId, undefined, "owners stay local");

    // Another machine: the upload is not there until the folder brings it.
    rmSync(join(media, IMAGE));
    const opened = await http.post("/projects/import-folder").set(auth).send({ path: folder }).expect(201);
    assert.ok(existsSync(join(media, IMAGE)));
    const copy = await http.get(`/projects/${opened.body.id as string}`).set(auth).expect(200);
    assert.equal(copy.body.name, "Trip / Recap");
    assert.deepEqual(copy.body.scene.layers, scene.layers);

    await http.post("/projects/import-folder").set(auth).send({ path: "relative/path" }).expect(400);
    await http.post("/projects/import-folder").set(auth).send({ path: out }).expect(400);
  });
});
