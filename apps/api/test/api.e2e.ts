import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";
import { BrickSlot } from "../src/bricks/brick.enums";
import { CATALOG } from "../src/bricks/seed/catalog";

let mongo: MongoMemoryServer;
let app: INestApplication;
let http: ReturnType<typeof request>;

async function login(email: string) {
  const res = await http.post("/auth/mock-google").send({ email }).expect(201);
  return { Authorization: `Bearer ${res.body.token as string}` };
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri("motionily-test");
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

describe("auth (simulated Google)", () => {
  it("logs in, returns the same user on repeat, and protects routes", async () => {
    const a = await http.post("/auth/mock-google").send({ email: "Ana@Example.com", name: "Ana" }).expect(201);
    const b = await http.post("/auth/mock-google").send({ email: "ana@example.com" }).expect(201);
    assert.equal(a.body.user.id, b.body.user.id);
    assert.equal(a.body.user.provider, "mock");
    await http.get("/projects").expect(401);
    const me = await http.get("/auth/me").set({ Authorization: `Bearer ${b.body.token}` }).expect(200);
    assert.equal(me.body.email, "ana@example.com");
  });
});

describe("brick store", () => {
  it("seeds the whole catalog and is public", async () => {
    const res = await http.get("/bricks").expect(200);
    assert.equal(res.body.length, CATALOG.length);
  });

  it("filters by slot and by what fits a motion style", async () => {
    const styles = await http.get("/bricks").query({ slot: BrickSlot.MotionStyle }).expect(200);
    assert.deepEqual(
      styles.body.map((b: { key: string }) => b.key).sort(),
      ["anime", "apple", "cartoon", "isometric", "paper_cut", "startup"].map((s) => `motion_style/${s}`),
    );
    const anime = await http.get("/bricks").query({ slot: BrickSlot.Palette, fits: "motion_style/anime" }).expect(200);
    const keys = anime.body.map((b: { key: string }) => b.key);
    assert.ok(keys.includes("palette/anime_sky"), "brick made for anime fits");
    assert.ok(keys.includes("palette/sunset"), "brick without fits fits everything");
    assert.ok(!keys.includes("palette/kraft"), "paper-cut-only brick does not fit anime");
  });

  it("gets one brick by key", async () => {
    const res = await http.get("/bricks/animation/pop_in").expect(200);
    assert.equal(res.body.slot, BrickSlot.Animation);
    await http.get("/bricks/animation/nope").expect(404);
  });
});

describe("projects as Lego builds", () => {
  it("opening a box fills every slot with its defaults", async () => {
    const auth = await login("lego@example.com");
    const res = await http
      .post("/projects")
      .set(auth)
      .send({ name: "Lanzamiento", motionStyle: "motion_style/startup", brief: "App de reservas" })
      .expect(201);
    const { build, misfits } = res.body;
    assert.equal(build.motion_style, "motion_style/startup");
    assert.equal(build.palette, "palette/startup_green");
    assert.deepEqual(build.animation, ["animation/pop_in", "animation/slide_in", "animation/fade_up"]);
    assert.equal(build.scenario, null);
    assert.deepEqual(misfits, []);
  });

  it("swaps bricks, flags misfits without blocking, and validates slots", async () => {
    const auth = await login("swap@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "P", motionStyle: "motion_style/startup" });

    const swapped = await http.put(`/projects/${p.id}/build/palette`).set(auth).send({ value: "palette/kraft" }).expect(200);
    assert.equal(swapped.body.build.palette, "palette/kraft");
    assert.deepEqual(swapped.body.misfits, ["palette/kraft"]);

    await http.put(`/projects/${p.id}/build/palette`).set(auth).send({ value: "animation/pop_in" }).expect(400);
    await http.put(`/projects/${p.id}/build/palette`).set(auth).send({ value: ["palette/sunset"] }).expect(400);
    await http.put(`/projects/${p.id}/build/animation`).set(auth).send({ value: "animation/pop_in" }).expect(400);
    await http.put(`/projects/${p.id}/build/scenario`).set(auth).send({ value: null }).expect(200);
    await http.put(`/projects/${p.id}/build/nonsense`).set(auth).send({ value: "x" }).expect(400);
  });

  it("changing the box can re-snap every slot to the new kit", async () => {
    const auth = await login("box@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "P", motionStyle: "motion_style/startup" });
    const res = await http
      .put(`/projects/${p.id}/build/motion_style`)
      .set(auth)
      .send({ value: "motion_style/paper_cut", applyKitDefaults: true })
      .expect(200);
    assert.equal(res.body.build.palette, "palette/kraft");
    assert.equal(res.body.build.render_style, "render_style/paper_cut");
  });

  it("isolates projects between accounts", async () => {
    const owner = await login("owner@example.com");
    const other = await login("other@example.com");
    const { body: p } = await http.post("/projects").set(owner).send({ name: "Mío", motionStyle: "motion_style/apple" });
    await http.get(`/projects/${p.id}`).set(other).expect(404);
    const mine = await http.get("/projects").set(owner).expect(200);
    const theirs = await http.get("/projects").set(other).expect(200);
    assert.equal(mine.body.length, 1);
    assert.equal(theirs.body.length, 0);
  });

  it("saves scenes with optimistic revisions", async () => {
    const auth = await login("scene@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "P", motionStyle: "motion_style/apple" });
    const scene = { width: 1080, height: 1920, fps: 30, duration: 6, layers: [] };
    const r1 = await http.put(`/projects/${p.id}/scene`).set(auth).send({ scene, baseRevision: 0 }).expect(200);
    assert.equal(r1.body.sceneRevision, 1);
    await http.put(`/projects/${p.id}/scene`).set(auth).send({ scene, baseRevision: 0 }).expect(409);
  });
});

describe("agent loop", () => {
  it("creates private bricks for one project only", async () => {
    const auth = await login("agent@example.com");
    const { body: a } = await http.post("/projects").set(auth).send({ name: "A", motionStyle: "motion_style/cartoon" });
    const { body: b } = await http.post("/projects").set(auth).send({ name: "B", motionStyle: "motion_style/cartoon" });
    const brick = {
      slot: BrickSlot.Animation,
      id: "jelly_bounce",
      name: "Jelly bounce",
      payload: { keys: { scale: [[0, 0, "back"], [0.3, 1.2], [0.5, 1]] } },
    };
    const created = await http.post(`/projects/${a.id}/bricks`).set(auth).send(brick).expect(201);
    assert.equal(created.body.visibility, "private");

    await http.post(`/projects/${a.id}/bricks`).set(auth).send({ ...brick, id: "pop_in" }).expect(400);

    const inA = await http.get(`/projects/${a.id}/bricks`).query({ slot: BrickSlot.Animation }).set(auth);
    const inB = await http.get(`/projects/${b.id}/bricks`).query({ slot: BrickSlot.Animation }).set(auth);
    const store = await http.get("/bricks").query({ slot: BrickSlot.Animation });
    const has = (res: { body: { key: string }[] }) => res.body.some((x) => x.key === "animation/jelly_bounce");
    assert.ok(has(inA));
    assert.ok(!has(inB));
    assert.ok(!has(store));

    const used = await http
      .put(`/projects/${a.id}/build/animation`)
      .set(auth)
      .send({ value: ["animation/pop_in", "animation/jelly_bounce"] })
      .expect(200);
    assert.ok(used.body.build.animation.includes("animation/jelly_bounce"));
    await http.put(`/projects/${b.id}/build/animation`).set(auth).send({ value: ["animation/jelly_bounce"] }).expect(404);
  });

  it("queues comments and brick choices until the agent consumes them", async () => {
    const auth = await login("fb@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "P", motionStyle: "motion_style/anime" });
    await http.post(`/projects/${p.id}/feedback`).set(auth).send({ kind: "comment", text: "más rápido", at: 1.5 }).expect(201);
    await http.post(`/projects/${p.id}/feedback`).set(auth).send({ kind: "comment", text: "  " }).expect(400);
    await http.put(`/projects/${p.id}/build/captions`).set(auth).send({ value: "captions/karaoke" }).expect(200);

    const first = await http.post(`/projects/${p.id}/feedback/consume`).set(auth).expect(200);
    assert.deepEqual(
      first.body.map((f: { kind: string }) => f.kind),
      ["comment", "brick_chosen"],
    );
    const second = await http.post(`/projects/${p.id}/feedback/consume`).set(auth).expect(200);
    assert.equal(second.body.length, 0);
  });
});

describe("agent tokens", () => {
  it("reach only their project and can change its options but not delete it", async () => {
    const auth = await login("tokens@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "P", motionStyle: "motion_style/apple" });
    const { body: q } = await http.post("/projects").set(auth).send({ name: "Q", motionStyle: "motion_style/apple" });
    const { body: t } = await http.post(`/projects/${p.id}/agent-token`).set(auth).expect(201);
    const agent = { Authorization: `Bearer ${t.token as string}` };

    await http.get(`/projects/${p.id}`).set(agent).expect(200);
    await http.get(`/projects/${p.id}/bricks`).set(agent).expect(200);
    await http.post(`/projects/${p.id}/feedback/consume`).set(agent).expect(200);
    await http
      .post(`/projects/${p.id}/bricks`)
      .set(agent)
      .send({ slot: "animation", id: "agent_spin", name: "Spin" })
      .expect(201);

    await http.get(`/projects/${q.id}`).set(agent).expect(403);
    await http.get("/projects").set(agent).expect(403);
    await http.put(`/projects/${p.id}/build/palette`).set(agent).send({ value: "palette/sunset" }).expect(200);
    await http.patch(`/projects/${p.id}`).set(agent).send({ format: "square_1_1" }).expect(200);
    const fb = await http.post(`/projects/${p.id}/feedback/consume`).set(agent).expect(200);
    assert.equal(fb.body.length, 0, "agent changes are not echoed back as user feedback");
    await http.delete(`/projects/${p.id}`).set(agent).expect(403);
    await http.post(`/projects/${p.id}/agent-token`).set(agent).expect(403);
  });
});

describe("audio and targeted feedback", () => {
  it("stores one audio file per project and serves it without auth", async () => {
    const auth = await login("audio@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "P", motionStyle: "motion_style/apple" });
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40)]);
    const up = await http.post(`/projects/${p.id}/audio`).set(auth).attach("file", wav, { filename: "voz.wav", contentType: "audio/wav" }).expect(201);
    assert.match(up.body.audio.url, /^\/media\/[a-f0-9-]{36}\.wav$/);
    const served = await http.get(up.body.audio.url).expect(200);
    assert.equal(served.body.length ?? served.text.length, wav.length);
    await http.post(`/projects/${p.id}/audio`).set(auth).attach("file", Buffer.from("x"), { filename: "a.txt", contentType: "text/plain" }).expect(400);
    await http.get("/media/../package.json").expect(404);
    const del = await http.delete(`/projects/${p.id}/audio`).set(auth).expect(200);
    assert.equal(del.body.audio, null);
    await http.get(up.body.audio.url).expect(404);
  });

  it("keeps the layer a comment is about", async () => {
    const auth = await login("target@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "P", motionStyle: "motion_style/cartoon" });
    await http.post(`/projects/${p.id}/feedback`).set(auth).send({ kind: "comment", text: "pelo blanco", at: 2, layerId: "monigote" }).expect(201);
    const [f] = (await http.post(`/projects/${p.id}/feedback/consume`).set(auth).expect(200)).body;
    assert.equal(f.layerId, "monigote");
  });
});

describe("prefab library", () => {
  it("is shared across a user's projects, cloneable, and private to them", async () => {
    const auth = await login("prefabs@example.com");
    const { body: a } = await http.post("/projects").set(auth).send({ name: "A", motionStyle: "motion_style/cartoon" });
    const { body: b } = await http.post("/projects").set(auth).send({ name: "B", motionStyle: "motion_style/apple" });
    const { body: t } = await http.post(`/projects/${a.id}/agent-token`).set(auth).expect(201);
    const agent = { Authorization: `Bearer ${t.token as string}` };
    const node = { children: [{ shape: "box", size: [1.9, 0.12, 0.7], radius: 0.05, position: [0, 0.62, 0] }] };

    await http.put(`/projects/${a.id}/prefabs/camilla`).set(agent).send({ kind: "object", node, description: "Camilla" }).expect(200);
    const fromB = await http.get(`/projects/${b.id}/prefabs`).set(auth).expect(200);
    assert.deepEqual(fromB.body.map((p: { name: string }) => p.name), ["camilla"], "visible from another project");

    await http.post(`/projects/${a.id}/prefabs/camilla/clone`).set(agent).send({ name: "camilla_azul" }).expect(201);
    const clone = await http.get(`/projects/${b.id}/prefabs/camilla_azul`).set(auth).expect(200);
    assert.equal(clone.body.parent, "camilla");
    await http.put(`/projects/${a.id}/prefabs/Bad-Name`).set(agent).send({ kind: "object", node }).expect(400);
    await http.delete(`/projects/${a.id}/prefabs/camilla`).set(agent).expect(403);

    const other = await login("someone@example.com");
    const { body: c } = await http.post("/projects").set(other).send({ name: "C", motionStyle: "motion_style/apple" });
    const theirs = await http.get(`/projects/${c.id}/prefabs`).set(other).expect(200);
    assert.equal(theirs.body.length, 0);
  });
});

describe("projects (brand kits) and their videos", () => {
  it("groups videos, stores described assets and exposes the kit to the video's agent", async () => {
    const auth = await login("brands@example.com");
    const { body: brand } = await http.post("/brands").set(auth).send({ name: "Clinily", notes: "Software para fisios" }).expect(201);
    await http
      .patch(`/brands/${brand.id}`)
      .set(auth)
      .send({ palettes: [{ name: "Marca", background: "#ffffff", surface: "#f3f4f6", primary: "#16a34a", accent: "#22c55e", text: "#111827" }] })
      .expect(200);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex");
    const up = await http
      .post(`/brands/${brand.id}/assets`)
      .set(auth)
      .field("kind", "screenshot")
      .field("description", "Agenda semanal: arrastra citas para moverlas")
      .attach("file", png, { filename: "agenda.png", contentType: "image/png" })
      .expect(201);
    assert.equal(up.body.assets[0].description, "Agenda semanal: arrastra citas para moverlas");
    await http.post(`/brands/${brand.id}/assets`).set(auth).attach("file", Buffer.from("x"), { filename: "a.txt", contentType: "text/plain" }).expect(400);

    const { body: video } = await http.post("/projects").set(auth).send({ name: "Spot agenda", motionStyle: "motion_style/startup", brandId: brand.id }).expect(201);
    assert.equal(video.brandId, brand.id);
    const vids = await http.get(`/brands/${brand.id}/videos`).set(auth).expect(200);
    assert.equal(vids.body.length, 1);

    const { body: t } = await http.post(`/projects/${video.id}/agent-token`).set(auth).expect(201);
    const agent = { Authorization: `Bearer ${t.token as string}` };
    const kit = await http.get(`/projects/${video.id}/brand`).set(agent).expect(200);
    assert.equal(kit.body.name, "Clinily");
    assert.equal(kit.body.palettes[0].primary, "#16a34a");
    assert.match(kit.body.assets[0].url, /^\/media\//);
    await http.patch(`/brands/${brand.id}`).set(agent).send({ name: "x" }).expect(403);

    const other = await login("intruder@example.com");
    await http.get(`/brands/${brand.id}`).set(other).expect(404);
    await http.post("/projects").set(other).send({ name: "x", motionStyle: "motion_style/apple", brandId: brand.id }).expect(404);
  });

  it("adopts old videos into a default project", async () => {
    const auth = await login("legacy@example.com");
    const { body: v } = await http.post("/projects").set(auth).send({ name: "Viejo", motionStyle: "motion_style/apple" }).expect(201);
    const brands = await http.get("/brands").set(auth).expect(200);
    assert.equal(brands.body.length, 1);
    assert.equal(brands.body[0].videos, 1);
    assert.ok(v.brandId);
  });
});
