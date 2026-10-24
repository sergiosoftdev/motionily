import { OpName, type Op } from "@motionily/protocol";
import { engineHost } from "../../engine/host";

/**
 * Point tracking for color windows: follows the picture under a window from frame to frame (normalized
 * cross-correlation of a patch, searched around its last position) and keys the window's x / y on it,
 * forward and backward from the playhead across its clip. Measured on the rendered frames.
 */

/** Width (px) frames are analysed at. */
const ANALYSIS_WIDTH = 480;
/** Samples per second of video (keys in between are linear). */
const SAMPLES_PER_SECOND = 15;
const PATCH_MIN = 12;
const PATCH_MAX = 40;
/** Farthest (analysis px) the patch is looked for from one sample to the next. */
const SEARCH = 28;
/** Below this match quality the track stops (the subject left or got covered). */
const MIN_SCORE = 0.5;

type Gray = { px: Float32Array; w: number; h: number };

function gray(img: ImageData): Gray {
  const px = new Float32Array(img.width * img.height);
  for (let i = 0; i < px.length; i++) px[i] = 0.299 * img.data[i * 4]! + 0.587 * img.data[i * 4 + 1]! + 0.114 * img.data[i * 4 + 2]!;
  return { px, w: img.width, h: img.height };
}

function patch(g: Gray, cx: number, cy: number, r: number): Float32Array | null {
  const x0 = Math.round(cx) - r;
  const y0 = Math.round(cy) - r;
  if (x0 < 0 || y0 < 0 || x0 + 2 * r >= g.w || y0 + 2 * r >= g.h) return null;
  const s = 2 * r + 1;
  const out = new Float32Array(s * s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) out[y * s + x] = g.px[(y0 + y) * g.w + x0 + x]!;
  return out;
}

/** Zero-mean, unit-norm copy (so the score is a correlation in −1..1). */
function normalize(p: Float32Array): Float32Array | null {
  let m = 0;
  for (const v of p) m += v;
  m /= p.length;
  let n = 0;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) {
    out[i] = p[i]! - m;
    n += out[i]! * out[i]!;
  }
  n = Math.sqrt(n);
  if (n < 1e-3) return null;
  for (let i = 0; i < out.length; i++) out[i]! /= n;
  return out;
}

/** Where `tpl` (radius r) matches best in `g` around (cx, cy), and how well. */
function search(g: Gray, tpl: Float32Array, r: number, cx: number, cy: number): { x: number; y: number; score: number } {
  let best = { x: cx, y: cy, score: -1 };
  for (let dy = -SEARCH; dy <= SEARCH; dy += 2) {
    for (let dx = -SEARCH; dx <= SEARCH; dx += 2) best = score(g, tpl, r, cx + dx, cy + dy, best);
  }
  // Refine around the coarse best at single pixels.
  const coarse = best;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) best = score(g, tpl, r, coarse.x + dx, coarse.y + dy, best);
  return best;
}

function score(g: Gray, tpl: Float32Array, r: number, x: number, y: number, best: { x: number; y: number; score: number }) {
  const p = patch(g, x, y, r);
  const n = p && normalize(p);
  if (!n) return best;
  let s = 0;
  for (let i = 0; i < n.length; i++) s += n[i]! * tpl[i]!;
  return s > best.score ? { x, y, score: s } : best;
}

export type TrackResult = { ops: Op[]; samples: number; from: number; to: number; lost: boolean };

/** Track the window `id` over its clip from `at` (the playhead); returns the ops that key its x / y. */
export async function trackWindow(id: string, at: number, onProgress?: (ratio: number) => void): Promise<TrackResult> {
  const layer = engineHost.layer(id);
  if (!layer) throw new Error(`no layer ${id}`);
  const start = Number(layer.start ?? 0);
  const end = Number(layer.end ?? engineHost.duration());
  const t0 = Math.min(end, Math.max(start, at));
  const [sw] = engineHost.sceneSize();
  const k = ANALYSIS_WIDTH / sw;
  const xs = engineHost.sampleProp(id, "x", [t0]);
  const ys = engineHost.sampleProp(id, "y", [t0]);
  const w = engineHost.sampleProp(id, "w", [t0])[0] ?? 100;
  const h = engineHost.sampleProp(id, "h", [t0])[0] ?? 100;
  const r = Math.round(Math.min(PATCH_MAX, Math.max(PATCH_MIN, (Math.min(w, h) * k) / 4)));
  const step = 1 / SAMPLES_PER_SECOND;
  const forward: number[] = [];
  for (let t = t0 + step; t < end - 1e-3; t += step) forward.push(t);
  const backward: number[] = [];
  for (let t = t0 - step; t > start + 1e-3; t -= step) backward.push(t);
  const total = forward.length + backward.length + 1;
  let done = 0;
  const frame = async (t: number) => {
    const [f] = await engineHost.framePixels([t], ANALYSIS_WIDTH);
    onProgress?.(++done / total);
    return gray(f!.image);
  };
  const first = await frame(t0);
  const p0x = (xs[0] ?? sw / 2) * k;
  const p0y = (ys[0] ?? 0) * k;
  const tpl0 = patch(first, p0x, p0y, r);
  const norm0 = tpl0 && normalize(tpl0);
  if (!norm0) throw new Error("nothing to track there: move the window onto a detail with some contrast");
  const keys: { t: number; x: number; y: number }[] = [{ t: t0, x: p0x, y: p0y }];
  let lost = false;
  for (const times of [forward, backward]) {
    let tpl = norm0;
    let [x, y] = [p0x, p0y];
    for (const t of times) {
      const g = await frame(t);
      const m = search(g, tpl, r, x, y);
      if (m.score < MIN_SCORE) {
        lost = true;
        break;
      }
      [x, y] = [m.x, m.y];
      keys.push({ t, x, y });
      // Follow slow changes of the subject's look: the template is refreshed from where it was found.
      const fresh = patch(g, x, y, r);
      const n = fresh && normalize(fresh);
      if (n) tpl = n;
    }
  }
  keys.sort((a, b) => a.t - b.t);
  const round = (v: number) => Math.round(v * 10) / 10;
  const keyed = (pick: (q: { x: number; y: number }) => number) =>
    keys.map((q) => ({ t: Math.round((q.t - start) * 1000) / 1000, v: round(pick(q) / k), ease: "linear" }));
  const ops: Op[] = [{ op: OpName.Patch, id, fields: { x: keyed((q) => q.x), y: keyed((q) => q.y) } }];
  return { ops, samples: keys.length, from: keys[0]!.t, to: keys[keys.length - 1]!.t, lost };
}
