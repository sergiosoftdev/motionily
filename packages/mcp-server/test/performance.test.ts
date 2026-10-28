import { test } from "node:test";
import assert from "node:assert/strict";
import { activeVariant, attentionCurve, forVariant, hookTests, newHookOps, sceneVariants, audienceDrops, channelDropoffs, channelExperiments, channelInsights, channelLessons, channelPlaybook, channelSummary, onScreenAt, type ChannelVideo, type PostMetrics, type VideoFeatures } from "@motionily/protocol";
import { channelBrief, channelReport, performanceReport } from "../src/performance.js";

const base: PostMetrics = { platform: "instagram", fetchedAt: "2026-10-27T18:00:00.000Z", views: 1200, reach: 900, likes: 80, comments: 4, shares: 9, saves: 15, avgWatch: 4.2, skipRate: 0.38, retention: null, duration: null };
const scene = {
  duration: 20,
  layers: [
    { id: "bg", type: "shape", start: 0 },
    { id: "hook", type: "text", text: "Bulls don't hate red.", start: 0, end: 3.5 },
    { id: "why", type: "text", text: "They hate the motion", start: 3.5, end: 8 },
  ],
};

test("drops: the 3-second skip and the average view, at their times on the scene", () => {
  const drops = audienceDrops(base, 20);
  assert.deepEqual(drops.map((d) => d.t), [3, 4.2]);
  assert.match(drops[0]!.why, /38% skipped/);
  assert.match(drops[1]!.why, /21% of the video/);
});

test("drops: the steepest falls of a retention curve, not every wiggle", () => {
  // Flat at 100%, a cliff from 30% to 40% of the video, flat at 50%.
  const retention = Array.from({ length: 100 }, (_, i) => (i < 30 ? 1 : i < 40 ? 1 - (i - 29) * 0.05 : 0.5));
  const drops = audienceDrops({ ...base, platform: "youtube", avgWatch: null, skipRate: null, retention, duration: 20 }, 20);
  assert.equal(drops.length, 1);
  assert.ok(drops[0]!.t > 6 && drops[0]!.t < 8, `the cliff is at 30-40% of 20 s, got ${drops[0]!.t}`);
});

test("on screen: the texts shown at that time first, then the other layers", () => {
  assert.deepEqual(onScreenAt(scene, 4.2), ['"They hate the motion"', "bg"]);
});

test("the report maps each drop to what was on screen and says when nothing is posted", () => {
  const report = performanceReport([{ postId: "p", postedAt: "2026-10-26T18:00:00.000Z", outdated: true, links: [{ platform: "instagram", id: "1", url: "https://instagram.com/reel/x", publishedAt: null }], metrics: [base] }], scene);
  assert.match(report, /1\.2K views · reach 900 · 80 likes/);
  assert.match(report, /average view 4\.2 s of 20 s \(21%\) · 38% skipped in the first 3 s/);
  assert.match(report, /- 3 s: 38% skipped in the first 3 s · on screen: "Bulls don't hate red\.", bg\n  - 4\.2 s: the average view ends here \(21% of the video\) · on screen: "They hate the motion", bg/);
  assert.match(report, /edited since/);
  assert.match(performanceReport([], scene), /not been posted/);
});

const posted = (name: string, platform: ChannelVideo["platform"], views: number, skipRate: number, avgWatch: number, duration: number): ChannelVideo => ({
  postId: name,
  projectId: name,
  name,
  cover: null,
  format: "vertical",
  duration,
  platform,
  url: null,
  publishedAt: "2026-10-01T10:00:00.000Z",
  metrics: { ...base, platform, views, skipRate, avgWatch, duration, shares: Math.round(views * 0.002) },
  views3d: null,
  features: null,
  experiment: null,
});

test("channel: what the best videos do differently, only when it is a real difference", () => {
  const rows = [
    posted("short-1", "tiktok", 40_000, 0.2, 9, 12),
    posted("short-2", "tiktok", 30_000, 0.22, 8, 13),
    posted("long-1", "instagram", 2_000, 0.5, 8, 35),
    posted("long-2", "instagram", 1_500, 0.55, 7, 40),
    posted("long-3", "instagram", 1_200, 0.6, 6, 38),
    posted("long-4", "tiktok", 1_800, 0.5, 9, 36),
  ];
  const titles = channelInsights(rows).map((i) => i.title);
  assert.ok(titles.includes("The hook decides it"), titles.join(", "));
  assert.ok(titles.includes("Shorter does better"), titles.join(", "));
  assert.ok(titles.includes("TikTok is where you grow"), titles.join(", "));
  // Alike videos: nothing to act on.
  const alike = Array.from({ length: 6 }, (_, i) => posted(`v${i}`, "instagram", 1000 + i * 10, 0.3, 6, 20));
  assert.deepEqual(channelInsights(alike), []);
  // Too few to compare.
  assert.deepEqual(channelInsights(rows.slice(0, 3)), []);
  assert.equal(channelSummary(rows).views, 76_500);
});

test("channel report: best first, the open video marked, and the comparison", () => {
  const rows = [posted("a", "tiktok", 500, 0.4, 5, 20), posted("b", "tiktok", 9000, 0.1, 15, 20), posted("c", "instagram", 100, 0.7, 3, 20)];
  const report = channelReport(rows, "a");
  assert.ok(report.indexOf('"b"') < report.indexOf('"a"'));
  assert.match(report, /"a" \(this video\)/);
  assert.match(report, /Too few videos to compare yet/);
  assert.match(report, /Early signal/);
  assert.match(channelReport([], "a"), /No posted video has numbers yet/);
});

const made = (hook: string, beatsPerMin: number, voice: boolean): VideoFeatures => ({ duration: 30, hook, beatsPerMin, wordsPerSec: voice ? 2.5 : 0, voice, captions: voice, music: true, genre: null, format: "vertical" });

test("channel: videos under 3 days old are shown as growing, never compared", () => {
  const now = Date.parse("2026-10-28T20:00:00.000Z");
  const old = [posted("a", "instagram", 2500, 0.24, 8, 10), posted("b", "instagram", 1700, 0.35, 6, 13), posted("c", "instagram", 1700, 0.43, 5, 13), posted("d", "instagram", 1600, 0.4, 5, 14)];
  const fresh = { ...posted("today", "instagram", 155, 0.21, 3, 10), publishedAt: "2026-10-28T12:00:00.000Z" };
  const playbook = channelPlaybook([...old, fresh], now)!;
  assert.match(playbook, /Still collecting views.*"today" 155 views at 8 h/);
  assert.doesNotMatch(playbook, /Weakest: "today"/);
  assert.match(playbook, /Weakest: "d"/);
  // Ranked by views at 3 days when kept, so an old video's later views don't count against a new one.
  const ranked = channelPlaybook([{ ...old[0]!, views3d: 900 }, { ...old[1]!, views3d: 1200 }], now)!;
  assert.match(ranked, /Learn from: "b"/);
});

test("channel: the best videos' hook, pace and voice against the rest", () => {
  const now = Date.parse("2026-10-28T20:00:00.000Z");
  const rows = [
    { ...posted("a", "tiktok", 9000, 0.3, 8, 30), features: made("Bulls can't see red.", 30, true) },
    { ...posted("b", "tiktok", 8000, 0.3, 8, 30), features: made("Goldfish remember for months.", 28, true) },
    { ...posted("c", "tiktok", 1000, 0.3, 8, 30), features: made("Today we are going to talk about something that most people believe about vikings", 12, false) },
    { ...posted("d", "tiktok", 900, 0.3, 8, 30), features: made("Here is a little story about the history of the tongue map and taste", 10, false) },
  ];
  const titles = channelInsights(rows, now).map((i) => i.title);
  assert.ok(titles.includes("Short opening lines"), titles.join(", "));
  assert.ok(titles.includes("A faster pace holds them"), titles.join(", "));
  assert.ok(titles.includes("A voice helps"), titles.join(", "));
  const brief = channelBrief(rows)!;
  assert.match(brief, /opens with: "Bulls can't see red\."/);
  assert.equal(channelBrief([]), null);
});

test("experiments: judged against the channel's usual once 3 days old, waiting before", () => {
  const now = Date.parse("2026-10-28T20:00:00.000Z");
  const usual = [posted("a", "instagram", 1700, 0.35, 6, 13), posted("b", "instagram", 1700, 0.43, 5, 13), posted("c", "instagram", 1600, 0.31, 5, 14)];
  const question = { ...posted("q", "instagram", 2500, 0.2, 9, 12), experiment: { change: "Opens with a question", metric: "hook" as const, setAt: "2026-10-20T10:00:00.000Z" } };
  const long = { ...posted("l", "instagram", 900, 0.36, 9, 45), experiment: { change: "45 s instead of 15", metric: "views" as const, setAt: "2026-10-21T10:00:00.000Z" } };
  const fresh = { ...posted("f", "instagram", 155, 0.21, 3, 10), publishedAt: "2026-10-28T12:00:00.000Z", experiment: { change: "No voice", metric: "watch" as const, setAt: "2026-10-28T10:00:00.000Z" } };
  const results = channelExperiments([...usual, question, long, fresh], now);
  const by = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.equal(by.q!.status, "worked");
  assert.equal(by.q!.value, "20% skip in 3 s");
  assert.equal(by.l!.status, "failed");
  assert.equal(by.f!.status, "waiting");
  assert.equal(by.f!.readyAt, "2026-10-31T12:00:00.000Z");
  const playbook = channelPlaybook([...usual, question, long, fresh], now)!;
  assert.match(playbook, /Worked: "Opens with a question" on "q" .*20% skip in 3 s against/);
  assert.match(playbook, /Didn't work: "45 s instead of 15"/);
  assert.match(playbook, /Waiting: "No voice" on "f".*after 2026-10-31/);
});

test("lessons: videos posted without an experiment still say what stood out and what they did differently", () => {
  const now = Date.parse("2026-10-28T20:00:00.000Z");
  const ig = (name: string, views: number, watch: number, skip: number, shares: number, f: VideoFeatures) => ({
    ...posted(name, "instagram", views, skip, watch * 30, 30),
    metrics: { ...base, views, skipRate: skip, avgWatch: watch * 30, duration: 30, shares, saves: 0 },
    features: f,
  });
  const rows = [
    ig("Bulls", 2500, 0.81, 0.24, 1, { ...made("Bulls can't see red.", 20, true), duration: 45 }),
    ig("Goldfish", 1700, 0.46, 0.35, 12, made("Goldfish remember for months, not seconds, and here's how we know", 20, true)),
    ig("Vikings", 1700, 0.39, 0.43, 1, made("Vikings never wore horned helmets into battle, and the reason is surprising", 20, true)),
    { ...ig("Tongue", 155, 0.31, 0.21, 0, made("The tongue map is fake.", 20, true)), publishedAt: "2026-10-28T12:00:00.000Z" },
  ];
  const lessons = channelLessons(rows, now);
  const by = Object.fromEntries(lessons.map((l) => [l.name, l]));
  assert.equal(by.Tongue, undefined, "still growing");
  assert.deepEqual(by.Bulls!.better.map((b) => b.metric).sort(), ["hook", "views", "watch"]);
  assert.ok(by.Bulls!.traits.some((t) => t.startsWith("45 s long")), by.Bulls!.traits.join("; "));
  assert.ok(by.Bulls!.traits.some((t) => t.startsWith("a shorter opening line")), by.Bulls!.traits.join("; "));
  assert.deepEqual(by.Goldfish!.better.map((b) => b.metric), ["shares"]);
  assert.equal(lessons[0]!.name, "Bulls", "the one that stands out most first");
  assert.match(channelPlaybook(rows, now)!, /Lessons from videos already posted[\s\S]*"Bulls" (did well|was mixed): .*81% watched \(usually/);
});

test("dropoffs: what was on screen when viewers left, across videos, against the usual fall there", () => {
  // 30 s videos that lose 1 point a second, and 12 more in the 2 s after a table comes in at 10 s.
  const curve = Array.from({ length: 100 }, (_, i) => {
    const t = (i / 99) * 30;
    return 1 - 0.01 * t - (t >= 10 ? Math.min(0.12, ((t - 10) / 2) * 0.12) : 0);
  });
  const timeline: VideoFeatures["timeline"] = [
    { start: 0, end: 4, kind: "title", label: '"Hook"' },
    { start: 5, end: 10, kind: "text", label: '"Setup"' },
    { start: 10, end: 14, kind: "table", label: "pricing-table" },
    { start: 14, end: 18, kind: "text", label: '"Point"' },
    { start: 18, end: 22, kind: "footage", label: "clip" },
    { start: 22, end: 30, kind: "text", label: '"Outro"' },
  ];
  const features = { duration: 30, hook: "Hook", beatsPerMin: 12, wordsPerSec: 0, voice: false, captions: false, music: false, genre: null, format: null, timeline, starts: [5, 10, 14, 18, 22] };
  const rows = ["A", "B", "C"].map((name) => ({ ...posted(name, "youtube", 1000, 0, 15, 30), metrics: { ...base, platform: "youtube" as const, retention: curve, duration: 30, skipRate: null }, features }));
  const d = channelDropoffs(rows);
  assert.equal(d.videos, 3);
  const table = d.patterns.find((p) => p.kind === "table");
  assert.ok(table, `a table pattern, got ${JSON.stringify(d.patterns.map((p) => p.kind))}`);
  assert.equal(table.moments, 3);
  assert.ok(table.leave > 0.12 && table.normal < 0.04, `${table.leave} vs ${table.normal}`);
  assert.equal(d.patterns[0]!.kind, "table", "the worst comes first");
  assert.ok(!d.patterns.some((p) => p.kind === "footage"), "a clip on the usual slope is not a pattern");
  assert.match(d.moments[0]!.onScreen.join(), /a table \(pricing-table\)/);
  assert.match(channelPlaybook(rows, Date.parse("2026-10-27T18:00:00.000Z"))!, /When a table appears, 1\d% of viewers leave in the next 2 s, against [23]% usually there · 3 times in 3 videos: avoid it/);
  // Instagram and TikTok give no curve: nothing to say.
  assert.deepEqual(channelDropoffs(rows.map((r) => ({ ...r, metrics: { ...r.metrics, retention: null } }))).patterns, []);
});

test("hook tests: each hook against the usual on its own platform, a winner once all are 3 days old", () => {
  const now = Date.parse("2026-10-27T18:00:00.000Z");
  const usual = [1, 2, 3].flatMap((i) => [posted(`ig${i}`, "instagram", 1000, 0.4, 5, 20), posted(`tt${i}`, "tiktok", 10000, 0.3, 6, 20)]);
  const hook = (variant: string, platform: ChannelVideo["platform"], views: number, hookText: string, publishedAt = "2026-10-10T10:00:00.000Z"): ChannelVideo => ({
    ...posted("Bulls", platform, views, 0.3, 6, 20),
    postId: `bulls-${variant}`,
    projectId: "bulls",
    publishedAt,
    variant,
    features: { duration: 20, hook: hookText, beatsPerMin: 10, wordsPerSec: 2, voice: true, captions: true, music: false, genre: null, format: null },
  });
  // A: 2,000 on Instagram (2x usual). B: 9,000 on TikTok (0.9x usual): fewer views, but A won.
  const [t] = hookTests([...usual, hook("A", "instagram", 2000, "Nobody tells you this"), hook("B", "tiktok", 9000, "Stop doing this")], now);
  assert.equal(t!.status, "won");
  assert.equal(t!.winner, "A");
  assert.deepEqual(t!.entries.map((e) => [e.variant, e.vsUsual?.toFixed(1), e.hook]), [["A", "2.0", "Nobody tells you this"], ["B", "0.9", "Stop doing this"]]);
  assert.match(channelPlaybook([...usual, hook("A", "instagram", 2000, "Nobody tells you this"), hook("B", "tiktok", 9000, "Stop doing this")], now)!, /Hook tests[^\n]*\n- "Bulls": hook A won\. A \("Nobody tells you this"\) on Instagram: 2\.0x your usual views/);
  const young = hookTests([...usual, hook("A", "instagram", 2000, "a"), hook("B", "tiktok", 9000, "b", "2026-10-27T08:00:00.000Z")], now)[0]!;
  assert.equal(young.status, "waiting", "one hook is under 3 days old");
  assert.equal(hookTests([...usual, hook("A", "instagram", 1000, "a"), hook("B", "tiktok", 11000, "b")], now)[0]!.status, "unclear");
});

test("hook variants: copy the opening into B, play one at a time, the attention curve sees only the one playing", () => {
  const scene = {
    duration: 12,
    layers: [
      { id: "bg", type: "shape", start: 0 },
      { id: "card", type: "shape", start: 0, end: 2.6 },
      { id: "hook", type: "text", text: "Nobody tells you this", start: 0, end: 2.6, parent: "card" },
      { id: "body", type: "text", text: "The body", start: 3 },
    ],
  };
  const made = newHookOps(scene)!;
  assert.equal(made.variant, "B");
  assert.deepEqual(made.ops[0], { op: "patch", ids: ["card", "hook"], fields: { variant: "A" } }, "the current opening becomes A");
  const added = made.ops.filter((o) => o.op === "add_layer").map((o) => o.layer as Record<string, unknown>);
  assert.deepEqual(added.map((l) => [l.id, l.variant, l.parent]), [["card-b", "B", undefined], ["hook-b", "B", "card-b"]], "copies keep their parent among the copies");
  assert.deepEqual(made.ops.filter((o) => o.op === "reorder").map((o) => [o.id, o.index]), [["card-b", 2], ["hook-b", 4]], "each copy right above its original");
  assert.deepEqual(made.ops.at(-1), { op: "set_variant", variant: "B" });
  // Applied by hand: the scene now has both.
  const both = { ...scene, variant: "B", layers: [scene.layers[0], { ...scene.layers[1], variant: "A" }, { ...added[0], variant: "B" }, { ...scene.layers[2], variant: "A" }, { ...added[1], variant: "B" }, scene.layers[3]] };
  assert.deepEqual(sceneVariants(both), ["A", "B"]);
  assert.equal(activeVariant(both), "B");
  assert.deepEqual(forVariant(both, "A").layers.map((l) => (l as { id: string }).id), ["bg", "card", "hook", "body"]);
  assert.deepEqual(attentionCurve(both).bins, attentionCurve(forVariant(both)).bins, "one opening counted, not two");
  assert.equal(newHookOps(both)!.variant, "C");
  assert.equal(newHookOps({ duration: 12, layers: [{ id: "bg", type: "shape", start: 0 }] }), null, "nothing on screen to copy");
});
