import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoints, diffScenes } from "../src/checkpoints.js";
import { loadExamples, rankExamples, saveExample, techniques, describeExample } from "../src/examples.js";
import { nextSteps, type ProjectState } from "../src/nextstep.js";
import { frameStats } from "../src/review.js";

test("checkpoints save, restore a copy, and refuse bad names", () => {
  const cp = new Checkpoints();
  const scene = { width: 1080, layers: [{ id: "a", x: 1 }] };
  cp.save("first", scene);
  scene.layers[0]!.x = 99; // later edits do not leak into the snapshot
  assert.equal((cp.get("first").layers as { x: number }[])[0]!.x, 1);
  assert.throws(() => cp.save("bad name!", scene), /letters, digits/);
  assert.throws(() => cp.get("nope"), /Saved: first/);
});

test("diff names added, removed and changed layers and scene keys", () => {
  const a = { duration: 6, layers: [{ id: "t", fill: "primary", x: 540 }, { id: "gone", x: 1 }] };
  const b = { duration: 8, layers: [{ id: "t", fill: "accent", x: 540 }, { id: "new", x: 2 }] };
  const lines = diffScenes(a, b);
  assert.ok(lines.includes("+ new (added)"));
  assert.ok(lines.includes("- gone (removed)"));
  assert.ok(lines.some((l) => l.startsWith("~ t: fill \"primary\" to \"accent\"")));
  assert.ok(lines.includes("scene duration: 6 to 8"));
  assert.deepEqual(diffScenes(a, a), ["no differences"]);
});

test("examples are saved, ranked by query words, and described by technique and layers", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-ex-"));
  const scene = {
    width: 1080, height: 1920, duration: 6,
    layers: [
      { id: "card", type: "shape", ease: "spring", blend: "overlay", effects: [{ fx: "glow", radius: 40, threshold: 0.7 }] },
      { id: "title", type: "text", animate: { by: "char" } },
    ],
  };
  saveExample(dir, "Clinic booking reel", ["booking", "vertical"], scene);
  saveExample(dir, "Pricing spot", ["pricing"], { width: 1920, height: 1080, duration: 8, layers: [] });
  const all = loadExamples(dir);
  assert.equal(all.length, 2);
  const ranked = rankExamples(all, "booking reel", 1080, 1920);
  assert.equal(ranked[0]!.label, "Clinic booking reel");
  const tech = techniques(ranked[0]!.scene);
  assert.ok(tech.includes("spring easing") && tech.includes("blend overlay") && tech.includes("glow threshold (bloom)"), tech.join(", "));
  const card = describeExample(ranked[0]!, (l) => `${l.id} ${l.type}`);
  assert.match(card, /techniques: .*spring easing/);
});

test("next_step follows the state: empty, then review, then sound, then done", () => {
  const base: ProjectState = { layers: 0, duration: 0, sfx: 0, editsSinceReview: false, reviewed: false, lintIds: [], pastEnd: [], checkpoints: 0 };
  assert.match(nextSteps(base)[0]!, /get_project/);
  const built: ProjectState = { ...base, layers: 8, duration: 6, editsSinceReview: true };
  assert.match(nextSteps(built).join(" "), /Not reviewed yet/);
  assert.match(nextSteps({ ...built, reviewed: true, lintIds: ["title"] }).join(" "), /Lint issues open/);
  assert.match(nextSteps({ ...built, reviewed: true }).join(" "), /add_sfx/);
  assert.match(nextSteps({ ...built, reviewed: true, editsSinceReview: false, sfx: 3 })[0]!, /Looks complete/);
});

test("frame stats count layers on screen and the share of the frame under text", () => {
  const frame = { t: 1, camera: null, behind: [], layers: [
    { id: "bg", screen: [0, 0, 1080, 1920] as [number, number, number, number], k: 1, z: 0, visible: true },
    { id: "title", screen: [0, 960, 1080, 1152] as [number, number, number, number], k: 1, z: 0, visible: true },
    { id: "off", screen: [2000, 0, 2100, 100] as [number, number, number, number], k: 1, z: 0, visible: true },
  ] };
  const s = frameStats(frame, [1080, 1920], new Set(["title"]));
  assert.equal(s.onScreen, 2);
  assert.equal(s.textCover, 10);
});
