/**
 * Point tracking on grayscale frames: follows a patch from frame to frame by normalized cross-correlation,
 * searched around where its motion predicts it, refined to sub-pixel, and re-anchored on the first
 * frame's patch so it does not drift (repeating detail, like stripes, would otherwise walk it off).
 */

export type Gray = { px: Float32Array; w: number; h: number };
export type TrackPoint = { t: number; x: number; y: number };

/** Farthest (px) the patch is looked for from its predicted position. */
const SEARCH = 24;
/** Below this match quality the track stops (the subject left or got covered). */
export const MIN_SCORE = 0.5;
/** Re-anchoring on the first patch is kept when it matches at least this well… */
const ANCHOR_SCORE = 0.75;
/** …searched this close (px) around the current match. */
const ANCHOR_SEARCH = 4;

export function grayOf(rgba: Uint8ClampedArray, w: number, h: number): Gray {
  const px = new Float32Array(w * h);
  for (let i = 0; i < px.length; i++) px[i] = 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!;
  return { px, w, h };
}

/** The (2r+1)² patch centred on (cx, cy), zero-mean and unit-norm; null off the frame or without contrast. */
export function patchAt(g: Gray, cx: number, cy: number, r: number): Float32Array | null {
  const x0 = Math.round(cx) - r;
  const y0 = Math.round(cy) - r;
  if (x0 < 0 || y0 < 0 || x0 + 2 * r >= g.w || y0 + 2 * r >= g.h) return null;
  const s = 2 * r + 1;
  const out = new Float32Array(s * s);
  let m = 0;
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const v = g.px[(y0 + y) * g.w + x0 + x]!;
      out[y * s + x] = v;
      m += v;
    }
  m /= out.length;
  let n = 0;
  for (let i = 0; i < out.length; i++) {
    out[i]! -= m;
    n += out[i]! * out[i]!;
  }
  n = Math.sqrt(n);
  if (n < 1e-3) return null;
  for (let i = 0; i < out.length; i++) out[i]! /= n;
  return out;
}

const corr = (g: Gray, tpl: Float32Array, r: number, x: number, y: number) => {
  const p = patchAt(g, x, y, r);
  if (!p) return -1;
  let s = 0;
  for (let i = 0; i < p.length; i++) s += p[i]! * tpl[i]!;
  return s;
};

/** Best match of `tpl` within `radius` px of (cx, cy) (integer grid), refined to sub-pixel. */
export function match(g: Gray, tpl: Float32Array, r: number, cx: number, cy: number, radius = SEARCH): { x: number; y: number; score: number } {
  const [ix, iy] = [Math.round(cx), Math.round(cy)];
  let best = { x: ix, y: iy, score: -1 };
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const s = corr(g, tpl, r, ix + dx, iy + dy);
      if (s > best.score) best = { x: ix + dx, y: iy + dy, score: s };
    }
  if (best.score < 0) return best;
  // A parabola through the neighbours on each axis puts the peak between pixels.
  const peak = (a: number, b: number, c: number) => {
    const d = a - 2 * b + c;
    return d < 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d))) : 0;
  };
  const s = best.score;
  const fx = peak(corr(g, tpl, r, best.x - 1, best.y), s, corr(g, tpl, r, best.x + 1, best.y));
  const fy = peak(corr(g, tpl, r, best.x, best.y - 1), s, corr(g, tpl, r, best.x, best.y + 1));
  return { x: best.x + fx, y: best.y + fy, score: s };
}

/**
 * Track the point (x0, y0) of `first` through `frames` (in time order, away from the first frame):
 * every step searches around the position its velocity predicts with the patch last found, then snaps
 * to the first frame's patch when that still matches (no drift). Stops where the match is lost.
 */
export function trackPoint(first: Gray, x0: number, y0: number, r: number, frames: { t: number; g: Gray }[]): { points: TrackPoint[]; lost: boolean } {
  const anchor = patchAt(first, x0, y0, r);
  if (!anchor) throw new Error("nothing to track there: move the window onto a detail with some contrast");
  const points: TrackPoint[] = [];
  let tpl = anchor;
  let [x, y, vx, vy] = [x0, y0, 0, 0];
  for (const { t, g } of frames) {
    let m = match(g, tpl, r, x + vx, y + vy);
    if (m.score < MIN_SCORE) return { points, lost: true };
    const back = match(g, anchor, r, m.x, m.y, ANCHOR_SEARCH);
    if (back.score >= ANCHOR_SCORE) m = back;
    [vx, vy] = [m.x - x, m.y - y];
    [x, y] = [m.x, m.y];
    points.push({ t, x, y });
    // Follow slow changes of the subject's look: the next step searches with the patch found here.
    tpl = patchAt(g, x, y, r) ?? tpl;
  }
  return { points, lost: false };
}
