import { OpName, type Op } from "@motionily/protocol";
import { engineHost } from "../../engine/host";
import { COLOR_FX } from "./colorGrade";

/**
 * Color matching between clips, like Resolve's shot match: each target clip's middle frame is brought to
 * the source clip's by transferring the mean and spread of every channel (display RGB), written as the
 * color effect's wheels (`gain` × spread, `offset` for the mean). The result is measured on the real
 * render and corrected again (the rest of the grade comes after the wheels), a few times.
 */

/** Width (px) frames are measured at. */
const MEASURE_WIDTH = 320;
/** Rounds of measure → correct per target. */
const ROUNDS = 3;
/** Bounds of the written wheels (the engine's ranges). */
const GAIN_MAX = 4;
const OFFSET_MAX = 1;
/** Spread ratio limits (a flat frame must not blow the gain up). */
const SPREAD_MIN = 0.25;
const SPREAD_MAX = 4;

type Rgb = [number, number, number];
/** Per-channel mean and standard deviation of a clip's picture (0..1), and its mean in CIELAB. */
type ClipStats = { mean: Rgb; std: Rgb; lab: Rgb };
type Effect = Record<string, unknown> & { fx?: string };
type SceneLayer = { id: string; parent?: string; attach?: string; start?: number; end?: number | null; effects?: Effect[] };

export type MatchResult = { ops: Op[]; lines: string[] };

/** Match every clip of `to` to `from`; returns the ops that write their grades and one line per clip. */
export async function matchColor(from: string, to: string[]): Promise<MatchResult> {
  const layers = (JSON.parse(engineHost.sceneJson()) as { layers?: SceneLayer[] }).layers ?? [];
  const find = (id: string) => {
    const l = layers.find((x) => x.id === id);
    if (!l) throw new Error(`no layer ${id}`);
    return l;
  };
  const ref = await clipStats(find(from), layers, []);
  const ops: Op[] = [];
  const lines: string[] = [];
  for (const id of to.filter((x) => x !== from)) {
    const clip = find(id);
    let effects = clip.effects ?? [];
    const before = await clipStats(clip, layers, []);
    let now = before;
    for (let round = 0; round < ROUNDS; round++) {
      effects = corrected(effects, now, ref);
      now = await clipStats(clip, layers, [{ op: OpName.Patch, id, fields: { effects } }]);
    }
    ops.push({ op: OpName.Patch, id, fields: { effects } });
    lines.push(`${id}: ΔE ${deltaE(before.lab, ref.lab).toFixed(1)} → ${deltaE(now.lab, ref.lab).toFixed(1)} from ${from}`);
  }
  return { ops, lines };
}

/** `effects` with the color effect's gain and offset moved so that `now` lands on `ref` (other fields kept). */
function corrected(effects: Effect[], now: ClipStats, ref: ClipStats): Effect[] {
  const old = effects.find((e) => e.fx === COLOR_FX) ?? { fx: COLOR_FX };
  const gain = rgb(old.gain, 1);
  const offset = rgb(old.offset, 0);
  const g: number[] = [];
  const o: number[] = [];
  for (let c = 0; c < 3; c++) {
    // out = k·in + b maps now's spread and mean onto ref's; composed after the wheels already there.
    const k = clamp(ref.std[c]! / Math.max(1e-3, now.std[c]!), SPREAD_MIN, SPREAD_MAX);
    const b = ref.mean[c]! - k * now.mean[c]!;
    g.push(round3(clamp(k * gain[c]!, 0, GAIN_MAX)));
    o.push(round3(clamp(k * offset[c]! + b, -OFFSET_MAX, OFFSET_MAX)));
  }
  const next = { ...old, gain: g, offset: o };
  return effects.some((e) => e.fx === COLOR_FX) ? effects.map((e) => (e === old ? next : e)) : [...effects, next];
}

/** The clip's picture at its middle, alone (other layers hidden, its windows kept), inside its box. */
async function clipStats(clip: SceneLayer, layers: SceneLayer[], ops: Op[]): Promise<ClipStats> {
  const duration = engineHost.duration();
  const t = ((clip.start ?? 0) + (clip.end ?? duration)) / 2;
  const keep = new Set([clip.id]);
  // Its parents (they place it) and its windows (part of its grade).
  for (let p = clip.parent; p && !keep.has(p); p = layers.find((l) => l.id === p)?.parent) keep.add(p);
  for (const l of layers) if (l.attach === clip.id) keep.add(l.id);
  const hide = layers.filter((l) => !keep.has(l.id)).map((l) => l.id);
  const [frame] = await engineHost.framePixels([t], MEASURE_WIDTH, { hide, ops });
  if (!frame) throw new Error("the editor could not render the clip");
  return stats(frame.image, box(clip.id, frame.image));
}

/** The clip's box on the measured frame (its bounds now, clamped to the frame), or the whole frame. */
function box(id: string, img: ImageData): [number, number, number, number] {
  const [sw] = engineHost.sceneSize();
  const k = img.width / sw;
  const b = engineHost.layerBounds(id);
  if (!b || b[4]) return [0, 0, img.width, img.height];
  const [cx = 0, cy = 0, w = 0, h = 0] = b;
  const x0 = Math.max(0, Math.floor((cx - w / 2) * k));
  const y0 = Math.max(0, Math.floor((cy - h / 2) * k));
  const x1 = Math.min(img.width, Math.ceil((cx + w / 2) * k));
  const y1 = Math.min(img.height, Math.ceil((cy + h / 2) * k));
  return x1 - x0 > 4 && y1 - y0 > 4 ? [x0, y0, x1, y1] : [0, 0, img.width, img.height];
}

function stats(img: ImageData, [x0, y0, x1, y1]: [number, number, number, number]): ClipStats {
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = img.data[i + c]! / 255;
        sum[c]! += v;
        sq[c]! += v * v;
      }
      n++;
    }
  const mean = sum.map((s) => s / Math.max(1, n)) as Rgb;
  const std = sq.map((s, c) => Math.sqrt(Math.max(0, s / Math.max(1, n) - mean[c]! ** 2))) as Rgb;
  return { mean, std, lab: lab(mean) };
}

/** CIELAB (D65) of a display (sRGB) color. */
function lab([r, g, b]: Rgb): Rgb {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

const deltaE = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const rgb = (v: unknown, d: number): Rgb => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number") ? (v as Rgb) : [d, d, d]);
