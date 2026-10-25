import { OpName, type Op } from "@motionily/protocol";
import { engineHost } from "../../engine/host";
import { grayOf, trackPoint, type Gray } from "./pointTrack";

/**
 * Point tracking for color windows: follows the picture under a window from frame to frame (pointTrack)
 * and keys the window's x / y on it, forward and backward from the playhead across its clip. Measured on
 * the rendered frames, without the window's own grade.
 */

/** Width (px) frames are analysed at. */
const ANALYSIS_WIDTH = 480;
/** Samples per second of video (keys in between are linear). */
const SAMPLES_PER_SECOND = 15;
/** Patch radius (analysis px): the window and some context around it (small patches slip along repeating detail), within these bounds. */
const PATCH_CONTEXT = 0.75;
const PATCH_MIN = 8;
const PATCH_MAX = 32;
/** Frames rendered per batch while tracking. */
const BATCH = 15;

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
  const r = Math.round(Math.min(PATCH_MAX, Math.max(PATCH_MIN, Math.min(w, h) * k * PATCH_CONTEXT)));
  const step = 1 / SAMPLES_PER_SECOND;
  const forward: number[] = [];
  for (let t = t0 + step; t < end - 1e-3; t += step) forward.push(t);
  const backward: number[] = [];
  for (let t = t0 - step; t > start + 1e-3; t -= step) backward.push(t);
  // Every sample rendered up front, in batches (the window hidden once per batch, not per frame).
  const all = [t0, ...forward, ...backward];
  const frames = new Map<number, Gray>();
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    // The clip's own picture: the window's grade would follow it into the match.
    for (const f of await engineHost.framePixels(batch, ANALYSIS_WIDTH, { hide: [id] })) frames.set(f.t, grayOf(f.image.data, f.image.width, f.image.height));
    onProgress?.(Math.min(1, (i + batch.length) / all.length));
  }
  const frame = (t: number) => frames.get(t)!;
  const p0x = (xs[0] ?? sw / 2) * k;
  const p0y = (ys[0] ?? 0) * k;
  const ahead = trackPoint(frame(t0), p0x, p0y, r, forward.map((t) => ({ t, g: frame(t) })));
  const behind = trackPoint(frame(t0), p0x, p0y, r, backward.map((t) => ({ t, g: frame(t) })));
  const keys = [{ t: t0, x: p0x, y: p0y }, ...ahead.points, ...behind.points];
  const lost = ahead.lost || behind.lost;
  keys.sort((a, b) => a.t - b.t);
  const round = (v: number) => Math.round(v * 10) / 10;
  const keyed = (pick: (q: { x: number; y: number }) => number) =>
    keys.map((q) => ({ t: Math.round((q.t - start) * 1000) / 1000, v: round(pick(q) / k), ease: "linear" }));
  const ops: Op[] = [{ op: OpName.Patch, id, fields: { x: keyed((q) => q.x), y: keyed((q) => q.y) } }];
  return { ops, samples: keys.length, from: keys[0]!.t, to: keys[keys.length - 1]!.t, lost };
}
