import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, formatIssues, lintLayers, readableOn, resolveColor, type Layer, type Palette, detachedChildren } from "../src/lint.js";
import type { FrameLayout, LayoutRow } from "@motionily/protocol";

const palette: Palette = { background: "#fbf7fb", surface: "#ffffff", primary: "#0f1733", accent: "#ffb347", text: "#0f1733" };
const size: [number, number] = [1080, 1920];
const row = (id: string, screen: [number, number, number, number], extra: Partial<LayoutRow> = {}): LayoutRow => ({ id, screen, k: 1, z: 0, visible: true, ...extra });
const frame = (t: number, layers: LayoutRow[]): FrameLayout => ({ t, camera: null, layers, behind: [] });

test("colors resolve to hex, slots, on_* tokens and animated lists", () => {
  assert.equal(resolveColor("#ABC", palette), "#aabbcc");
  assert.equal(resolveColor("primary", palette), "#0f1733");
  assert.equal(resolveColor([{ t: 0, c: "accent" }], palette), "#ffb347");
  assert.equal(resolveColor("on_primary", palette), "#ffffff", "white reads best on the dark primary");
  assert.equal(resolveColor("nonsense", palette), null);
});

test("readableOn picks the ink that clears WCAG on the color", () => {
  assert.ok(contrast(readableOn("#0f1733", palette), "#0f1733") >= 4.5);
  assert.ok(contrast(readableOn("#ffb347", palette), "#ffb347") >= 4.5);
});

test("low contrast text gets an on_* fix; the fix is a patch op", () => {
  const layers: Layer[] = [
    { id: "pill", type: "shape", fill: "primary" },
    { id: "label", type: "text", fill: "primary", size: 60 },
  ];
  const f = frame(1, [row("pill", [400, 900, 680, 1000]), row("label", [420, 930, 660, 970], { ink: true })]);
  const issues = lintLayers({ layers, frames: [f], palette, size });
  const c = issues.find((i) => i.kind === "low_contrast");
  assert.ok(c, "dark text on a dark pill is reported");
  assert.deepEqual(c!.fix, [{ op: "patch", id: "label", fields: { fill: "on_primary" } }]);
  assert.match(formatIssues(issues).join("\n"), /fix: \[\{"op":"patch"/);
});

test("text on the background that already reads is clean", () => {
  const layers: Layer[] = [{ id: "title", type: "text", fill: "text", size: 120 }];
  const f = frame(0.5, [row("title", [100, 100, 900, 220], { ink: true })]);
  assert.equal(lintLayers({ layers, frames: [f], palette, size }).length, 0);
});

test("a box mostly past an edge is reported with an x shift; an entirely hidden one is not", () => {
  const layers: Layer[] = [{ id: "card", type: "shape", x: 1000, y: 500, w: 400, h: 300 }, { id: "later", type: "shape", x: 500, y: 500 }];
  const f = frame(2, [row("card", [860, 350, 1260, 650]), row("later", [2000, 400, 2300, 600])]);
  const issues = lintLayers({ layers, frames: [f], palette, size });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.kind, "off_frame");
  assert.deepEqual(issues[0]!.fix, [{ op: "patch", id: "card", fields: { x: 1000 - 180 } }]);
});

test("tiny static text is reported once with the size to use", () => {
  const layers: Layer[] = [{ id: "fine", type: "text", size: 14, start: 0 }];
  const issues = lintLayers({ layers, frames: [], palette, size });
  assert.equal(issues[0]!.kind, "tiny_text");
  assert.deepEqual(issues[0]!.fix, [{ op: "patch", id: "fine", fields: { size: 26 } }]);
});

test("overlapping text merges across frames; place= to a missing layer is reported", () => {
  const layers: Layer[] = [
    { id: "a", type: "text", fill: "text", size: 80 },
    { id: "b", type: "text", fill: "text", size: 80 },
    { id: "c", type: "shape", place: { of: "ghost", side: "below" } },
  ];
  const frames = [
    frame(1, [row("a", [100, 100, 600, 200], { ink: true }), row("b", [120, 120, 620, 220], { ink: true })]),
    frame(2, [row("a", [100, 100, 600, 200], { ink: true }), row("b", [120, 120, 620, 220], { ink: true })]),
  ];
  const issues = lintLayers({ layers, frames, palette, size });
  const overlap = issues.find((i) => i.kind === "text_overlap")!;
  assert.deepEqual(overlap.times, [1, 2]);
  assert.ok(issues.some((i) => i.kind === "place_missing" && i.id === "c"));
});

test("a child written in scene coordinates is reported, a hand at the end of its arm is not", () => {
  const arm = { id: "arm_l", type: "shape", w: 64, h: 230, x: -165, y: 150 };
  const broken = detachedChildren([arm, { id: "hand_l", type: "shape", parent: "arm_l", w: 70, h: 70, x: -165, y: 275 }]);
  assert.equal(broken.length, 1);
  assert.match(broken[0]!.message, /relative to the parent's center/);
  assert.equal(detachedChildren([arm, { id: "hand_l", type: "shape", parent: "arm_l", w: 70, h: 70, x: 0, y: 115 }]).length, 0);
  // Camera and pivot nulls: children far from a 1 px parent are the point.
  assert.equal(detachedChildren([{ id: "rig", type: "shape", w: 1, h: 1 }, { id: "far", type: "shape", parent: "rig", w: 100, h: 100, x: 900, y: 0 }]).length, 0);
});
