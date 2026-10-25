// Run: pnpm --filter @motionily/web test (node's own runner, types stripped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { trackPoint, type Gray } from "../src/editor/edit/pointTrack.ts";

const W = 480;
const H = 270;

/** A test-card square (vertical color bars, like the "Tracking test" clip) centred on (cx, cy) on gray. */
function frame(cx: number, cy: number, half = 20): Gray {
  const px = new Float32Array(W * H).fill(48);
  const bars = [0, 76, 180, 105, 29, 226, 150, 255];
  for (let y = Math.round(cy - half); y < cy + half; y++)
    for (let x = Math.round(cx - half); x < cx + half; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const bar = Math.floor(((x - (cx - half)) / (2 * half)) * bars.length);
      // A horizontal ramp across the lower part, as on the clip.
      px[y * W + x] = y > cy + half * 0.4 && y < cy + half * 0.65 ? (x - (cx - half)) * 6 : bars[Math.min(bars.length - 1, bar)]!;
    }
  return { px, w: W, h: H };
}

test("follows a striped subject on a straight path within 2 px", () => {
  // The clip: (420,540) → (1095,720) in a 1920 scene over 3 s, analysed at a quarter size, 15 samples a second.
  const at = (t: number) => [105 + (273.75 - 105) * (t / 3), 135 + (180 - 135) * (t / 3)] as const;
  const times = Array.from({ length: 45 }, (_, i) => (i + 1) / 15);
  const { points, lost } = trackPoint(frame(...at(0)), 105, 135, 10, times.map((t) => ({ t, g: frame(...at(t)) })));
  assert.equal(lost, false);
  assert.equal(points.length, times.length);
  for (const p of points) {
    const [ex, ey] = at(p.t);
    assert.ok(Math.hypot(p.x - ex, p.y - ey) < 2, `at ${p.t.toFixed(2)} s: (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) vs (${ex.toFixed(1)}, ${ey.toFixed(1)})`);
  }
});

test("stops when the subject leaves", () => {
  const frames = [1, 2, 3].map((i) => ({ t: i / 15, g: i < 3 ? frame(100 + i * 4, 135) : ({ px: new Float32Array(W * H).fill(48), w: W, h: H } as Gray) }));
  const { points, lost } = trackPoint(frame(100, 135), 100, 135, 10, frames);
  assert.equal(lost, true);
  assert.equal(points.length, 2);
});
