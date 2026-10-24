import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { testDatabase } from "./db";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";
import { alignmentToWords } from "../src/voice/elevenlabs";

const GOOD_KEY = "sk_test_good_key_0123456789abcd";
const VOICE_ID = "Voice123ABCdef";
const SCRIPT = "[excited] Hi there.";
const MP3 = Buffer.from("ID3 fake mp3 bytes");
/** A script the fake account has no credits left for. */
const BROKE = "A script too long for the credits left.";

/** Character timings ElevenLabs would send for `text`: 0.1 s per character. */
function alignmentOf(text: string) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i / 10),
    character_end_times_seconds: characters.map((_, i) => (i + 1) / 10),
  };
}

/** Stands in for api.elevenlabs.io: one valid key, one voice. */
let fake: Server;
const spoken: { text: string; model_id: string }[] = [];

let db: Awaited<ReturnType<typeof testDatabase>>;
let app: INestApplication;
let http: ReturnType<typeof request>;

before(async () => {
  fake = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["xi-api-key"] !== GOOD_KEY) return reply(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } });
    if (req.method === "GET" && req.url?.startsWith("/v2/voices"))
      return reply(200, { voices: [{ voice_id: VOICE_ID, name: "Rachel", category: "premade", labels: { accent: "american" }, preview_url: "https://example.com/rachel.mp3" }], has_more: false });
    if (req.method === "POST" && req.url?.startsWith(`/v1/text-to-speech/${VOICE_ID}/with-timestamps`)) {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as { text: string; model_id: string };
        if (body.text.includes(BROKE))
          return reply(401, { detail: { status: "quota_exceeded", message: `This request exceeds your quota. ${body.text.length} credits are required.` } });
        spoken.push(body);
        reply(200, { audio_base64: MP3.toString("base64"), alignment: alignmentOf(body.text) });
      });
      return;
    }
    reply(404, { detail: "not found" });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  process.env.ELEVENLABS_API_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  db = await testDatabase("motionily-voice-test");
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
  fake?.close();
});

async function login(email: string) {
  const res = await http.post("/auth/mock-google").send({ email }).expect(201);
  return { Authorization: `Bearer ${res.body.token as string}` };
}

describe("ElevenLabs voices with the user's own key", () => {
  it("turns character timings into caption words, leaving audio tags out", () => {
    assert.deepEqual(alignmentToWords(alignmentOf("[whispers] Say it — now.")), [
      { text: "Say", start: 1.1, end: 1.4 },
      { text: "it", start: 1.5, end: 1.7 },
      { text: "now.", start: 2, end: 2.4 },
    ]);
  });

  it("checks and keeps the key without ever sending it back", async () => {
    const auth = await login("voice@example.com");
    assert.deepEqual((await http.get("/voice/elevenlabs").set(auth).expect(200)).body, { connected: false, hint: null });
    await http.get("/voice/voices").set(auth).expect(400);
    const bad = await http.put("/voice/elevenlabs").set(auth).send({ apiKey: "sk_wrong_key_0123456789" }).expect(400);
    assert.match(bad.body.message, /rejected the API key/);
    const ok = await http.put("/voice/elevenlabs").set(auth).send({ apiKey: GOOD_KEY }).expect(200);
    assert.deepEqual(ok.body, { connected: true, hint: "abcd" });
    const me = await http.get("/auth/me").set(auth).expect(200);
    assert.ok(!JSON.stringify(me.body).includes(GOOD_KEY));
    const voices = await http.get("/voice/voices").set(auth).expect(200);
    assert.deepEqual(voices.body[0], { id: VOICE_ID, name: "Rachel", category: "premade", description: null, labels: { accent: "american" }, previewUrl: "https://example.com/rachel.mp3" });
  });

  it("generates the voice-over with its words, and only for the user", async () => {
    const auth = await login("voice@example.com");
    const { body: p } = await http.post("/projects").set(auth).send({ name: "Voiced", voiceScript: SCRIPT }).expect(201);
    const res = await http.post(`/projects/${p.id}/voice`).set(auth).send({ voiceId: VOICE_ID, voiceName: "Rachel" }).expect(201);
    assert.equal(spoken.at(-1)?.text, SCRIPT);
    assert.equal(spoken.at(-1)?.model_id, "eleven_v4");
    assert.equal(res.body.audio.name, "Rachel · ElevenLabs.mp3");
    assert.deepEqual(res.body.audio.words.map((w: { text: string }) => w.text), ["Hi", "there."]);
    const served = await http.get(res.body.audio.url).expect(200);
    assert.equal(Buffer.from(served.body as Buffer).toString(), MP3.toString());

    // A new text becomes the video's script; the old file is replaced.
    const again = await http.post(`/projects/${p.id}/voice`).set(auth).send({ voiceId: VOICE_ID, text: "New line.", modelId: "eleven_v3" }).expect(201);
    assert.equal(again.body.voiceScript, "New line.");
    assert.equal(spoken.at(-1)?.model_id, "eleven_v3");
    await http.get(res.body.audio.url).expect(404);

    const broke = await http.post(`/projects/${p.id}/voice`).set(auth).send({ voiceId: VOICE_ID, text: BROKE }).expect(400);
    assert.match(broke.body.message, /out of credits/);
    await http.post(`/projects/${p.id}/voice`).set(auth).send({ voiceId: "bad id!" }).expect(400);
    const other = await login("other@example.com");
    await http.post(`/projects/${p.id}/voice`).set(other).send({ voiceId: VOICE_ID }).expect(404);
    await http.get("/voice/voices").set(other).expect(400);
  });

  it("forgets the key on disconnect", async () => {
    const auth = await login("voice@example.com");
    await http.delete("/voice/elevenlabs").set(auth).expect(200);
    assert.deepEqual((await http.get("/voice/elevenlabs").set(auth).expect(200)).body, { connected: false, hint: null });
    const { body: p } = await http.post("/projects").set(auth).send({ name: "Silent", voiceScript: SCRIPT }).expect(201);
    const res = await http.post(`/projects/${p.id}/voice`).set(auth).send({ voiceId: VOICE_ID }).expect(400);
    assert.match(res.body.message, /connect ElevenLabs first/);
  });
});
