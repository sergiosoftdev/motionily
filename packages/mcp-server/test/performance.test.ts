import { test } from "node:test";
import assert from "node:assert/strict";
import { audienceDrops, channelInsights, channelSummary, onScreenAt, type ChannelVideo, type PostMetrics } from "@motionily/protocol";
import { channelReport, performanceReport } from "../src/performance.js";

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
  assert.match(report, /too few measured videos/);
  assert.match(channelReport([], "a"), /No posted video has numbers yet/);
});
