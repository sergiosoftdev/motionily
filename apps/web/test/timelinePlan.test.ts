// Run: pnpm --filter @motionily/web test (node's own runner, types stripped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { importOps, localPath, matchFiles, tracksUsed, type ImportedTimeline } from "../src/editor/edit/timelinePlan.ts";

const timeline: ImportedTimeline = {
  format: "fcpxml",
  name: "Cut",
  fps: 25,
  width: 1920,
  height: 1080,
  duration: 8,
  clips: [
    { name: "A", file: "A001.mov", url: "file:///Volumes/Card/A001.mov", kind: "video", track: "V1", start: 0, end: 4, trim_in: 2 },
    { name: "B", file: "logo.png", url: "file:///Users/me/logo.png", kind: "video", track: "V2", start: 1, end: 3, trim_in: 0 },
    { name: "C", file: "B002.mov", url: "file:///Volumes/Card/B002.mov", kind: "video", track: "V1", start: 4, end: 8, trim_in: 0 },
    { name: "vo", file: "VO take.wav", url: "file:///Users/me/VO%20take.wav", kind: "audio", track: "A2", start: 0.5, end: 6, trim_in: 1 },
  ],
  skipped: [],
};

test("files match by name or by the name in their URL, case aside", () => {
  const pool = [
    { name: "a001.MOV", url: "/media/x1.mov", kind: "video" as const },
    { name: "Logo", url: "/media/logo.png", kind: "image" as const },
    { name: "vo", url: "/media/VO%20take.wav", kind: "audio" as const },
  ];
  const { found, missing } = matchFiles(timeline, pool);
  assert.equal(found.get("A001.mov")?.url, "/media/x1.mov");
  assert.equal(found.get("logo.png")?.url, "/media/logo.png");
  assert.equal(found.get("VO take.wav")?.url, "/media/VO%20take.wav");
  assert.deepEqual(missing.map((c) => c.file), ["B002.mov"]);
});

test("clips land on their tracks, from the given time, pictures as pictures, videos stacked in order", () => {
  const pool = [
    { name: "A001.mov", url: "/media/a.mov", kind: "video" as const },
    { name: "logo.png", url: "/media/logo.png", kind: "image" as const },
    { name: "VO take.wav", url: "/media/vo.wav", kind: "audio" as const },
  ];
  const { found } = matchFiles(timeline, pool);
  const plan = importOps(timeline, found, { at: 10, size: [1080, 1920], under: 2, taken: new Set(["ft1"]), tracks: (id) => `T${id}` });
  assert.equal(plan.placed, 3);
  assert.deepEqual(plan.missing, ["B002.mov"]);
  const layers = plan.ops.filter((o) => o.op === "add_layer").map((o) => (o as { layer: Record<string, unknown> }).layer);
  assert.deepEqual(
    layers.map((l) => [l.id, l.type, l.track, l.start, l.end, l.in, l.out]),
    [
      ["ft2", "video", "TV1", 10, 14, 2, 6],
      ["pic1", "image", "TV2", 11, 13, undefined, undefined],
      ["snd1", "audio", "TA2", 10.5, 16, 1, 6.5],
    ],
  );
  const order = plan.ops.filter((o) => o.op === "reorder").map((o) => [(o as { id: string }).id, (o as { index: number }).index]);
  assert.deepEqual(order, [["ft2", 2], ["pic1", 3]]);
  assert.deepEqual(tracksUsed(timeline), { video: 2, audio: 2 });
});

test("local paths from file URLs", () => {
  assert.equal(localPath("file:///Users/me/VO%20take.wav"), "/Users/me/VO take.wav");
  assert.equal(localPath("file://localhost/Users/me/a.mp4"), "/Users/me/a.mp4");
  assert.equal(localPath("file:///C:/clips/a.mp4"), "C:/clips/a.mp4");
  assert.equal(localPath("/Volumes/A/C0001.MP4"), "/Volumes/A/C0001.MP4");
  assert.equal(localPath("https://example.com/a.mp4"), null);
});
