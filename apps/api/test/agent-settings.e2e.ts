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
  db = await testDatabase("motionily-agent-settings-test");
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

describe("agent settings", () => {
  it("lists every agent CLI and keeps the user's choice and models", async () => {
    const login = await http.post("/auth/mock-google").send({ email: "agents@motionily.local" }).expect(201);
    const auth = { Authorization: `Bearer ${login.body.token as string}` };
    const first = await http.get("/settings/agent").set(auth).expect(200);
    assert.deepEqual(
      first.body.clis.map((c: { cli: string }) => c.cli),
      ["claude", "codex", "gemini", "opencode"],
    );
    assert.equal(first.body.cli, first.body.defaultCli);

    const saved = await http.put("/settings/agent").set(auth).send({ cli: "opencode", models: { opus: " openai/gpt-5.5 ", sonnet: "" } }).expect(200);
    assert.equal(saved.body.cli, "opencode");
    assert.deepEqual(saved.body.models, { opus: "openai/gpt-5.5" });
    assert.equal((await http.get("/settings/agent").set(auth).expect(200)).body.cli, "opencode");

    await http.put("/settings/agent").set(auth).send({ cli: "skynet" }).expect(400);
    // Back to the server default.
    assert.equal((await http.put("/settings/agent").set(auth).send({}).expect(200)).body.cli, first.body.defaultCli);
  });
});
