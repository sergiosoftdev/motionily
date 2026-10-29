import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { testDatabase } from "./db";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";
import { idFromUrl, matchVideo, setMetrics } from "../src/social/social.service";
import { videoFeatures } from "../src/social/features";
import { rankMatches, sureMatch, type MatchCandidate } from "../src/social/match";
import type { PostDocument } from "../src/posts/post.schema";
import { isoSeconds } from "../src/social/platforms";
import { SocialPlatform } from "../src/social/types";

const IG_TOKEN = "IGQWR_long_lived_token_0123456789";
const HOUR = 3_600_000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

/** What the fake platforms hold: one reel, one TikTok, one Short, all published an hour ago. */
const REEL = { id: "1790001", caption: "A dead man fooled Hitler #history", media_product_type: "REELS", timestamp: iso(now - HOUR), permalink: "https://www.instagram.com/reel/ABCdef123/" };
const TIKTOK = { id: "7300000000000000001", create_time: Math.floor((now - HOUR) / 1000), video_description: "A dead man fooled Hitler", duration: 15, share_url: "https://www.tiktok.com/@me/video/7300000000000000001", view_count: 5400, like_count: 300, comment_count: 12, share_count: 40 };
const SHORT_ID = "dQw4w9WgXcQ";
let igExpired = false;

/** Stands in for graph.instagram.com, open.tiktokapis.com, the YouTube APIs and Google's token endpoint. */
let fake: Server;
const body = (req: IncomingMessage) => new Promise<string>((resolve) => {
  let raw = "";
  req.on("data", (c: Buffer) => (raw += c.toString()));
  req.on("end", () => resolve(raw));
});

let db: Awaited<ReturnType<typeof testDatabase>>;
let app: INestApplication;
let http: ReturnType<typeof request>;

before(async () => {
  fake = createServer(async (req, res) => {
    const reply = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    const url = new URL(req.url ?? "/", "http://fake");
    const bearer = req.headers.authorization?.replace("Bearer ", "");
    // Instagram
    if (url.pathname.startsWith("/v25.0/")) {
      if (url.searchParams.get("access_token") !== IG_TOKEN || igExpired) return reply(400, { error: { message: "Error validating access token", code: 190 } });
      if (url.pathname === "/v25.0/me") return reply(200, { user_id: "17841400000", username: "motionily" });
      if (url.pathname === "/v25.0/me/media") return reply(200, { data: [REEL, { id: "1790002", media_product_type: "FEED", media_type: "IMAGE", timestamp: iso(now - HOUR) }] });
      if (url.pathname === `/v25.0/${REEL.id}/insights`) {
        const asked = url.searchParams.get("metric")!.split(",");
        const values: Record<string, number> = { views: 1200, reach: 900, likes: 80, comments: 4, shares: 9, saved: 15, ig_reels_avg_watch_time: 4200, reels_skip_rate: 38 };
        return reply(200, { data: asked.map((name) => ({ name, period: "lifetime", values: [{ value: values[name] }] })) });
      }
    }
    if (url.pathname === "/refresh_access_token") return reply(200, { access_token: IG_TOKEN, expires_in: 5_184_000 });
    // TikTok
    if (url.pathname === "/v2/oauth/token/") {
      const form = new URLSearchParams(await body(req));
      if (form.get("client_secret") !== "tt-secret") return reply(200, { error: "invalid_client", error_description: "Client secret is wrong" });
      return reply(200, { access_token: "act.tiktok", refresh_token: "rft.tiktok", expires_in: 86_400, open_id: "open-1" });
    }
    if (url.pathname.startsWith("/v2/") && !url.pathname.startsWith("/v2/reports")) {
      if (bearer !== "act.tiktok") return reply(401, { error: { code: "access_token_invalid", message: "The access token is invalid" } });
      const ok = { code: "ok", message: "" };
      if (url.pathname === "/v2/user/info/") return reply(200, { data: { user: { open_id: "open-1", display_name: "Motionily" } }, error: ok });
      if (url.pathname === "/v2/video/list/") return reply(200, { data: { videos: [TIKTOK], has_more: false, cursor: 0 }, error: ok });
      if (url.pathname === "/v2/video/query/") {
        const ids = (JSON.parse(await body(req)) as { filters: { video_ids: string[] } }).filters.video_ids;
        return reply(200, { data: { videos: ids.includes(TIKTOK.id) ? [TIKTOK] : [] }, error: ok });
      }
    }
    // Google
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await body(req));
      if (form.get("code") !== "google-code" && form.get("grant_type") !== "refresh_token") return reply(400, { error: "invalid_grant", error_description: "Bad code" });
      return reply(200, { access_token: "ya29.youtube", refresh_token: "1//refresh", expires_in: 3599 });
    }
    if (url.pathname.startsWith("/youtube/v3/") || url.pathname === "/v2/reports") {
      if (bearer !== "ya29.youtube") return reply(401, { error: { message: "Invalid Credentials", status: "UNAUTHENTICATED" } });
      if (url.pathname === "/youtube/v3/channels") return reply(200, { items: [{ id: "UC1", snippet: { title: "Motionily", customUrl: "@motionily" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] });
      if (url.pathname === "/youtube/v3/playlistItems")
        return reply(200, { items: [{ snippet: { title: "A dead man fooled Hitler", description: "#shorts" }, contentDetails: { videoId: SHORT_ID, videoPublishedAt: iso(now - 2 * HOUR) } }] });
      if (url.pathname === "/youtube/v3/videos") return reply(200, { items: [{ id: SHORT_ID, statistics: { viewCount: "3000", likeCount: "120", commentCount: "7" }, contentDetails: { duration: "PT20S" } }] });
      if (url.pathname === "/v2/reports") {
        if (url.searchParams.get("dimensions") === "elapsedVideoTimeRatio")
          // Holds at 100% until 30%, falls to 50% by 40%, then holds.
          return reply(200, { rows: Array.from({ length: 100 }, (_, i) => [(i + 1) / 100, i < 30 ? 1 : i < 40 ? 1 - (i - 29) * 0.05 : 0.5]) });
        return reply(200, { rows: [[11.5, 14]] });
      }
    }
    reply(404, { error: { message: `no fake for ${url.pathname}` } });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    SOCIAL_INSTAGRAM_API_URL: base,
    SOCIAL_TIKTOK_API_URL: base,
    SOCIAL_YOUTUBE_API_URL: base,
    SOCIAL_YOUTUBE_ANALYTICS_URL: base,
    SOCIAL_GOOGLE_TOKEN_URL: `${base}/token`,
    SOCIAL_SYNC_HOURS: "0",
  });

  db = await testDatabase("motionily-social-test");
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

/** A video with a scene, and a post of it on every platform marked posted now. */
async function postedVideo(auth: Record<string, string>, caption = "A dead man fooled Hitler") {
  const { body: p } = await http.post("/projects").set(auth).send({ name: "Mincemeat" }).expect(201);
  await http.put(`/projects/${p.id}/scene`).set(auth).send({ scene: { version: 1, duration: 20, layers: [] }, baseRevision: 0 }).expect(200);
  const platforms = ["instagram", "tiktok", "youtube"];
  const { body: post } = await http
    .post("/posts")
    .set(auth)
    .send({ projectId: p.id, scheduledAt: iso(now - 2 * HOUR), platforms, copy: platforms.map((platform) => ({ platform, caption, hashtags: [] })) })
    .expect(201);
  await http.patch(`/posts/${post.id}`).set(auth).send({ status: "posted" }).expect(200);
  return { projectId: p.id as string, postId: post.id as string };
}

describe("Social accounts and post performance", () => {
  it("reads ids from pasted links and durations from ISO 8601", () => {
    assert.equal(idFromUrl(SocialPlatform.TikTok, "https://www.tiktok.com/@me/video/7300000000000000001?lang=es"), "7300000000000000001");
    assert.equal(idFromUrl(SocialPlatform.YouTube, "https://youtube.com/shorts/dQw4w9WgXcQ?si=x"), SHORT_ID);
    assert.equal(idFromUrl(SocialPlatform.YouTube, "https://www.youtube.com/watch?v=dQw4w9WgXcQ"), SHORT_ID);
    assert.equal(idFromUrl(SocialPlatform.Instagram, "https://www.instagram.com/reel/ABCdef123/?igsh=1"), "ABCdef123");
    assert.equal(idFromUrl(SocialPlatform.Instagram, "https://example.com/reel/x"), null);
    assert.equal(isoSeconds("PT1M2S"), 62);
    assert.equal(isoSeconds("PT20S"), 20);
  });

  it("reads what a video is like from its scene: the spoken hook, the pace, voice and captions", () => {
    const f = videoFeatures({
      scene: {
        duration: 20,
        layers: [
          { type: "text", text: "Bulls *can't* see red", start: 0 },
          { type: "shape", start: 0 },
          { type: "image", start: 2 },
          { type: "text", text: "It's the motion", start: 5 },
          { type: "shape", start: 5 },
          { type: "image", start: 9.5, visible: false },
        ],
        audio: { start: 0 },
        captions: { words: [{ text: "Bulls", start: 0, end: 0.4 }] },
      },
      audio: { words: [{ text: "Bulls", start: 0.1 }, { text: "can't", start: 0.5 }, { text: "see", start: 0.9 }, { text: "red.", start: 1.2 }, { text: "Really.", start: 4 }] },
      direction: { genre: "editorial_collage" },
      format: "vertical_9_16",
    })!;
    assert.equal(f.hook, "Bulls can't see red.");
    assert.equal(f.beatsPerMin, 6, "two moments after the first frame in 20 s");
    assert.equal(f.voice, true);
    assert.equal(f.captions, true);
    assert.equal(f.music, false);
    assert.equal(f.genre, "editorial_collage");
    assert.deepEqual(
      f.timeline!.map((m) => [m.start, m.kind, m.label]),
      [[0, "text", '"Bulls can\'t see red"'], [2, "image", "image"], [5, "text", '"It\'s the motion"']],
      "what comes on screen and when, without shapes or hidden layers",
    );
    assert.deepEqual(f.starts, [2, 5]);
    const named = videoFeatures({ scene: { duration: 10, layers: [{ id: "pricingTable", type: "shape", start: 1 }, { id: "bar-3", group: "revenue chart", type: "shape", start: 2 }, { id: "t", type: "text", text: "BIG", size: 140, start: 3 }] } })!;
    assert.deepEqual(named.timeline!.map((m) => m.kind), ["table", "chart", "title"], "named by its id or group first, then by what it is");
    // Several openings: each posted copy is read with its own hook, the shared voice notwithstanding.
    const hooks = {
      scene: { duration: 10, variant: "B", layers: [{ type: "text", text: "Nobody tells you this", start: 0, end: 2.5, variant: "A" }, { type: "text", text: "Stop doing this", start: 0, end: 2.5, variant: "B" }, { type: "text", text: "The body", start: 3 }] },
      audio: { words: [{ text: "Listen", start: 0.2 }] },
    };
    assert.equal(videoFeatures(hooks, "A")!.hook, "Nobody tells you this");
    assert.equal(videoFeatures(hooks)!.hook, "Stop doing this", "the one the scene plays");
    assert.deepEqual(videoFeatures(hooks, "A")!.timeline!.map((m) => m.label), ['"Nobody tells you this"', '"The body"']);
    // Without a voice, the hook is the text on screen.
    assert.equal(videoFeatures({ scene: { duration: 10, layers: [{ type: "text", text: "Vikings never had horns", start: 0.2 }] } })!.hook, "Vikings never had horns");
    assert.equal(videoFeatures({ scene: null }), null);
  });

  it("keeps the numbers at 1, 3 and 7 days old, once each, and none for an age it was first measured long after", () => {
    const post = { metrics: [], checkpoints: [], postedAt: null, markModified: () => undefined } as unknown as PostDocument;
    const born = Date.parse("2026-10-01T10:00:00Z");
    const at = (hours: number, views: number) => ({ platform: SocialPlatform.Instagram, fetchedAt: new Date(born + hours * 3_600_000).toISOString(), views, reach: null, likes: null, comments: null, shares: null, saves: null, avgWatch: null, skipRate: null, retention: null, duration: null });
    const published = new Date(born).toISOString();
    for (const [h, v] of [[5, 100], [26, 900], [31, 1000], [75, 1500], [80, 1600], [400, 3000]] as const) setMetrics(post, at(h, v), published);
    assert.deepEqual(post.checkpoints.map((c) => [c.day, c.views, c.ageHours]), [[1, 900, 26], [3, 1500, 75]], "the week's was missed (first measured at 400 h), so it is not faked");
    assert.equal(post.metrics[0]!.views, 3000);
  });

  it("matches a post to the video published near it with the same caption, not to another one", () => {
    const when = new Date(now);
    const videos = [
      { id: "a", url: null, publishedAt: iso(now - HOUR), caption: "Something else entirely about cats", duration: null },
      { id: "b", url: null, publishedAt: iso(now - 3 * HOUR), caption: "A dead man fooled Hitler, the true story", duration: null },
    ];
    assert.equal(matchVideo(when, "A dead man fooled Hitler", videos, new Set())?.id, "b");
    assert.equal(matchVideo(when, "A dead man fooled Hitler", videos, new Set(["b"])), null, "taken videos and unrelated captions stay out");
    assert.equal(matchVideo(when, "", [videos[0]!], new Set())?.id, "a", "a lone video right next to it is the post");
    assert.equal(matchVideo(when, "x", [{ ...videos[1]!, publishedAt: iso(now - 5 * 24 * HOUR) }], new Set()), null, "days apart is another post");
  });

  it("finds which video a posted one came from by its length and the words its caption shares", () => {
    const made = (id: string, name: string, script: string, duration: number): MatchCandidate => ({ id, name, text: `${name}\n${script}`, duration, createdAt: now - 72 * HOUR, postedAt: [] });
    const videos = [
      made("tongue", "The Tongue Map Is Fake", "You've seen the tongue map: sweet at the tip, bitter at the back. It's wrong.", 54.9),
      made("vikings", "Vikings Never Had Horns", "Vikings never wore horned helmets. The horns came from an opera.", 53.2),
      made("goldfish", "Goldfish Memory", "Goldfish don't have three-second memories.", 48.6),
    ];
    const tiktok = (caption: string, duration: number | null) => ({ caption, duration, publishedAt: iso(now - HOUR) });
    // Same length as two of them: the caption decides.
    assert.equal(sureMatch(rankMatches(tiktok("The tongue map you learned at school is a myth #science", 54), videos))?.id, "tongue");
    // No caption, two videos as long: unclear, both offered.
    const unclear = rankMatches(tiktok("", 54), videos);
    assert.equal(sureMatch(unclear), null);
    assert.deepEqual(unclear.slice(0, 2).map((m) => m.id).sort(), ["tongue", "vikings"]);
    // Only the length (Instagram gives none): the caption alone is enough when it names it.
    assert.equal(sureMatch(rankMatches(tiktok("Goldfish remember for months 🐟", null), videos))?.id, "goldfish");
    // The length alone is enough when no other video is as long, unless the video was made after it went out.
    assert.equal(sureMatch(rankMatches(tiktok("", 48), videos))?.id, "goldfish");
    assert.equal(sureMatch(rankMatches({ ...tiktok("", 48), publishedAt: iso(now - 100 * HOUR) }, videos)), null);
  });

  it("links what was posted outside the calendar to the video it clearly came from", async () => {
    const auth = await login("autolink@example.com");
    await http.put("/social/instagram").set(auth).send({ token: IG_TOKEN }).expect(200);
    const app = { clientKey: "awtiktok", clientSecret: "tt-secret", redirectUri: "https://example.com/callback" };
    const { body: start } = await http.post("/social/tiktok/start").set(auth).send(app).expect(200);
    const state = new URL(start.authorizeUrl as string).searchParams.get("state")!;
    await http.post("/social/tiktok/finish").set(auth).send({ url: `https://example.com/callback?code=abc&state=${state}` }).expect(200);
    const project = async (name: string, voiceScript: string, duration: number) => {
      const { body: p } = await http.post("/projects").set(auth).send({ name }).expect(201);
      await http.patch(`/projects/${p.id}`).set(auth).send({ voiceScript }).expect(200);
      await http.put(`/projects/${p.id}/scene`).set(auth).send({ scene: { version: 1, duration, layers: [{ id: "t", type: "text", text: name, start: 0 }] }, baseRevision: 0 }).expect(200);
      return p.id as string;
    };
    const mincemeat = await project("Operation Mincemeat", "In 1943 a dead man fooled Hitler with a briefcase of fake plans.", 15.4);
    await project("Goldfish Memory", "Goldfish don't have three-second memories.", 48.6);

    const { body: r } = await http.post("/social/published/auto-link").set(auth).expect(200);
    assert.deepEqual(r.linked.map((l: { platform: string; projectId: string }) => [l.platform, l.projectId]).sort(), [["instagram", mincemeat], ["tiktok", mincemeat]].sort());
    assert.ok(r.linked.find((l: { platform: string }) => l.platform === "tiktok").why.some((w: string) => /same length/.test(w)));
    const { body: published } = await http.get("/social/published").set(auth).expect(200);
    assert.ok(published.every((v: { linked: { projectId: string } | null }) => v.linked?.projectId === mincemeat), "both now belong to it");
    const { body: channel } = await http.get("/social/channel").set(auth).expect(200);
    assert.equal(channel.filter((c: { projectId: string }) => c.projectId === mincemeat).length, 2, "and are measured");
    // Run again: nothing left to link.
    const { body: again } = await http.post("/social/published/auto-link").set(auth).expect(200);
    assert.deepEqual([again.linked, again.unsure], [[], []]);
  });

  it("connects the three accounts, matches the posted video on each and keeps its numbers", async () => {
    const auth = await login("social@example.com");
    // Instagram: a pasted long-lived token, checked before it is kept.
    await http.put("/social/instagram").set(auth).send({ token: "IGQWR_wrong_token_0123456789" }).expect(400);
    const { body: afterIg } = await http.put("/social/instagram").set(auth).send({ token: IG_TOKEN }).expect(200);
    assert.deepEqual(afterIg.find((a: { platform: string }) => a.platform === "instagram"), { platform: "instagram", connected: true, handle: "motionily", error: null });

    // TikTok: the app, the login URL, then the address TikTok redirects to pasted back.
    const app = { clientKey: "awtiktok", clientSecret: "tt-secret", redirectUri: "https://example.com/callback" };
    const { body: start } = await http.post("/social/tiktok/start").set(auth).send(app).expect(200);
    const authorize = new URL(start.authorizeUrl as string);
    assert.equal(authorize.searchParams.get("client_key"), "awtiktok");
    assert.equal(authorize.searchParams.get("scope"), "user.info.basic,video.list");
    const state = authorize.searchParams.get("state")!;
    await http.post("/social/tiktok/finish").set(auth).send({ url: "https://example.com/callback?code=abc&state=forged" }).expect(400);
    await http.post("/social/tiktok/finish").set(auth).send({ url: `https://example.com/callback?code=abc&state=${state}` }).expect(200);

    // YouTube: Google redirects to this API, which needs no session (the state says whose login it is).
    const { body: yt } = await http.post("/social/youtube/start").set(auth).send({ clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" }).expect(200);
    const ytUrl = new URL(yt.authorizeUrl as string);
    assert.match(ytUrl.searchParams.get("redirect_uri")!, /\/social\/youtube\/callback$/);
    assert.match(ytUrl.searchParams.get("scope")!, /yt-analytics\.readonly/);
    const page = await http.get(`/social/youtube/callback?code=google-code&state=${ytUrl.searchParams.get("state")}`).expect(200);
    assert.match(page.text, /YouTube connected as @motionily/);
    const replay = await http.get(`/social/youtube/callback?code=google-code&state=${ytUrl.searchParams.get("state")}`).expect(200);
    assert.match(replay.text, /could not be connected/, "a state works once");

    const { body: accounts } = await http.get("/social/accounts").set(auth).expect(200);
    assert.deepEqual(accounts.accounts.map((a: { handle: string }) => a.handle), ["motionily", "Motionily", "@motionily"]);
    assert.match(accounts.youtubeRedirect, /^http:\/\/127\.0\.0\.1:\d+\/social\/youtube\/callback$/);

    // A posted video is matched on all three and measured.
    const { projectId, postId } = await postedVideo(auth);
    const { body: sync } = await http.post("/social/sync").set(auth).expect(200);
    assert.deepEqual(sync.errors, []);
    const { body: posts } = await http.get("/posts").set(auth).expect(200);
    const post = posts.find((p: { id: string }) => p.id === postId);
    assert.deepEqual(post.links.map((l: { platform: string; id: string }) => [l.platform, l.id]).sort(), [["instagram", REEL.id], ["tiktok", TIKTOK.id], ["youtube", SHORT_ID]]);
    const by = Object.fromEntries(post.metrics.map((m: { platform: string }) => [m.platform, m]));
    assert.equal(by.instagram.views, 1200);
    assert.equal(by.instagram.avgWatch, 4.2);
    assert.equal(by.instagram.skipRate, 0.38);
    assert.equal(by.tiktok.views, 5400);
    assert.equal(by.tiktok.duration, 15);
    assert.equal(by.youtube.duration, 20);
    assert.equal(by.youtube.avgWatch, 11.5);
    assert.equal(by.youtube.retention.length, 100);

    // The video's agent reads them; the posting plan stays the user's.
    const { body: token } = await http.post(`/projects/${projectId}/agent-token`).set(auth).expect(201);
    const agent = { Authorization: `Bearer ${token.token as string}` };
    const { body: perf } = await http.get(`/projects/${projectId}/performance`).set(agent).expect(200);
    assert.equal(perf.length, 1);
    assert.equal(perf[0].metrics.length, 3);
    assert.equal(perf[0].outdated, false);
    await http.get("/posts").set(agent).expect(403);
    await http.post("/social/sync").set(agent).expect(403);
    await http.get("/social/accounts").set(agent).expect(403);

    // The video's agent records what it tests; it reaches the video and every row of the channel.
    await http.put(`/projects/${projectId}/experiment`).set(agent).send({ change: "x", metric: "hook" }).expect(400);
    await http.put(`/projects/${projectId}/experiment`).set(agent).send({ change: "Opens with a question", metric: "likes" }).expect(400);
    const { body: set } = await http.put(`/projects/${projectId}/experiment`).set(agent).send({ change: " Opens with a question ", metric: "hook" }).expect(200);
    assert.equal(set.experiment.change, "Opens with a question");
    const { body: video } = await http.get(`/projects/${projectId}`).set(auth).expect(200);
    assert.equal(video.experiment.metric, "hook");

    // The Stats page: one row per published copy, with the video's name and numbers.
    const { body: channel } = await http.get("/social/channel").set(auth).expect(200);
    assert.deepEqual(channel.map((r: { platform: string }) => r.platform).sort(), ["instagram", "tiktok", "youtube"]);
    assert.ok(channel.every((r: { projectId: string; postId: string; name: string }) => r.projectId === projectId && r.postId === postId && r.name));
    assert.equal(channel.find((r: { platform: string }) => r.platform === "tiktok").metrics.views, 5400);
    assert.ok(channel.every((r: { views3d: unknown; features: unknown }) => r.views3d === null && "features" in r));
    assert.ok(channel.every((r: { experiment: { change: string } | null }) => r.experiment?.change === "Opens with a question"));
    await http.delete(`/projects/${projectId}/experiment`).set(auth).expect(200);
    assert.equal((await http.get(`/projects/${projectId}`).set(auth).expect(200)).body.experiment, null);
    // The agent compares across videos through its own video's route, never the user's.
    const { body: seen } = await http.get(`/projects/${projectId}/channel`).set(agent).expect(200);
    assert.equal(seen.length, 3);
    await http.get("/social/channel").set(agent).expect(403);
  });

  it("links a post by its URL, and an expired token asks to connect again instead of failing the rest", async () => {
    const auth = await login("links@example.com");
    await http.put("/social/instagram").set(auth).send({ token: IG_TOKEN }).expect(200);
    const { postId } = await postedVideo(auth, "Totally different words here");
    await http.post(`/posts/${postId}/links`).set(auth).send({ platform: "instagram", url: "https://www.instagram.com/reel/NOPE/" }).expect(400);
    const { body: linked } = await http.post(`/posts/${postId}/links`).set(auth).send({ platform: "instagram", url: REEL.permalink }).expect(200);
    assert.equal(linked.links[0].id, REEL.id, "the permalink is looked up to the media id");
    assert.equal(linked.metrics[0].views, 1200);
    const { body: unlinked } = await http.delete(`/posts/${postId}/links/instagram`).set(auth).expect(200);
    assert.deepEqual([unlinked.links, unlinked.metrics], [[], []]);

    igExpired = true;
    try {
      await http.post(`/posts/${postId}/links`).set(auth).send({ platform: "instagram", url: REEL.permalink }).expect(400);
      const { body: sync } = await http.post(`/posts/${postId}/sync`).set(auth).expect(200);
      assert.equal(sync.errors.length, 1);
      const { body: accounts } = await http.get("/social/accounts").set(auth).expect(200);
      const ig = accounts.accounts.find((a: { platform: string }) => a.platform === "instagram");
      assert.equal(ig.connected, false);
      assert.match(ig.error, /needs connecting again/);
    } finally {
      igExpired = false;
    }
    const { body: gone } = await http.delete("/social/instagram").set(auth).expect(200);
    assert.equal(gone.find((a: { platform: string }) => a.platform === "instagram").connected, false);
  });
});
