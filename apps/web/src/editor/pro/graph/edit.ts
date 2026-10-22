import { snap, type Anim, type Key } from "../keys";
import { bezierOf, DEFAULT_EASE, Ease, isHold, type Bezier } from "./evaluate";

/**
 * Pure keyframe edits behind the graph editor. Each returns a new key list for one prop; the
 * editor writes it with an ordinary `set_prop` op, the same op Claude sends through MCP.
 *
 * A key's `bezier` shapes the segment to the NEXT key, so the "out" side of key i lives in key i's
 * bezier (x1, y1) and its "in" side lives in key i-1's bezier (x2, y2).
 */

/** Which side of a key a handle (or an ease) belongs to. */
export const Side = { In: "in", Out: "out" } as const;
export type Side = (typeof Side)[keyof typeof Side];

/** AE's keyframe assistants and interpolation converters. */
export const EasePreset = {
  EasyEase: "easy_ease",
  EaseIn: "ease_in",
  EaseOut: "ease_out",
  Hold: "hold",
  Linear: "linear",
  AutoBezier: "auto_bezier",
} as const;
export type EasePreset = (typeof EasePreset)[keyof typeof EasePreset];

/** AE's Easy Ease: speed 0 with 33.33% influence. */
const EASY_INFLUENCE = 1 / 3;
/** Influence below this makes the speed blow up; AE stops at 0.1%. */
const MIN_INFLUENCE = 0.001;
/** Bezier numbers are stored to 4 decimals (keeps the scene JSON short and stable). */
const round = (n: number) => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Two keys within half a frame are the same key (as in keys.ts). */
export const sameT = (a: number, b: number, fps: number) => Math.abs(a - b) < 0.5 / fps;

const withEase = (k: Key, ease: string): Key => {
  const { bezier: _drop, ...rest } = k;
  return { ...rest, ease };
};

/** The segment leaving `k` gets bezier `b`; a straight one is stored as plain `linear`. */
function withBezier(k: Key, b: Bezier): Key {
  const r = b.map(round) as Bezier;
  if (Math.abs(r[0] - r[1]) < 1e-4 && Math.abs(r[2] - r[3]) < 1e-4) return withEase(k, Ease.Linear);
  // A held key that gets a curve stops holding (the bezier would override it anyway; keep the JSON honest).
  return { ...k, bezier: r, ease: k.ease === Ease.Hold ? DEFAULT_EASE : k.ease };
}

/** Index of the segment a side of key `i` shapes, or -1 when that side has no segment. */
export function segmentOf(keys: readonly Key[], i: number, side: Side) {
  const s = side === Side.Out ? i : i - 1;
  return s >= 0 && s < keys.length - 1 ? s : -1;
}

const replace = (keys: readonly Key[], i: number, k: Key) => keys.map((x, j) => (j === i ? k : x));

/**
 * Edit one side of key `i` in normalized segment space: the out side sets (x1, y1), the in side
 * (x2, y2). `x` is clamped to [0, 1]; `y` may overshoot. A named ease becomes a bezier; a held
 * segment has no handles and is left alone unless `unhold`.
 */
export function setHandle(keys: readonly Key[], i: number, side: Side, x: number, y: number, unhold = false): Key[] {
  const s = segmentOf(keys, i, side);
  if (s < 0) return [...keys];
  const k = keys[s]!;
  if (isHold(k) && !unhold) return [...keys];
  const b = bezierOf(k) ?? bezierOf(withEase(k, Ease.Linear))!;
  if (side === Side.Out) {
    b[0] = clamp(x, 0, 1);
    b[1] = y;
  } else {
    b[2] = clamp(x, 0, 1);
    b[3] = y;
  }
  return replace(keys, s, withBezier(k, b));
}

/** AE's speed (value units per second) and influence (0..1) of one side of key `i`. */
export type SpeedHandle = { speed: number; influence: number };

export function speedHandle(keys: readonly Key[], i: number, side: Side): SpeedHandle | null {
  const s = segmentOf(keys, i, side);
  if (s < 0 || isHold(keys[s]!)) return null;
  const a = keys[s]!;
  const b = keys[s + 1]!;
  const dt = b.t - a.t;
  if (dt <= 0) return null;
  const avg = (b.v - a.v) / dt;
  const bz = bezierOf(a)!;
  const influence = side === Side.Out ? bz[0] : 1 - bz[2];
  const rise = side === Side.Out ? bz[1] : 1 - bz[3];
  return { influence, speed: (rise / Math.max(influence, MIN_INFLUENCE)) * avg };
}

/** Set one side of key `i` from an AE speed and influence. */
export function setSpeedHandle(keys: readonly Key[], i: number, side: Side, speed: number, influence: number, unhold = false): Key[] {
  const s = segmentOf(keys, i, side);
  if (s < 0) return [...keys];
  const a = keys[s]!;
  const b = keys[s + 1]!;
  const dt = b.t - a.t;
  const dv = b.v - a.v;
  const infl = clamp(influence, MIN_INFLUENCE, 1);
  // Slope in normalized segment space; a flat segment (dv = 0) can only stay flat.
  const slope = dv !== 0 && dt > 0 ? (speed * dt) / dv : 0;
  return side === Side.Out
    ? setHandle(keys, i, side, infl, slope * infl, unhold)
    : setHandle(keys, i, side, 1 - infl, 1 - slope * infl, unhold);
}

/**
 * Move the keys at `selected` by `dt` seconds (snapped to frames) and `dv` value units. A moved key
 * dropped onto a key that stays replaces it, as in the timeline.
 */
export function moveKeys(keys: readonly Key[], selected: ReadonlySet<number>, dt: number, dv: number, fps: number, clampV: (v: number) => number = (v) => v): Key[] {
  const moved = keys.map((k, i) => (selected.has(i) ? { ...k, t: dt !== 0 ? snap(k.t + dt, fps) : k.t, v: dv !== 0 ? clampV(k.v + dv) : k.v } : k));
  const landed = moved.filter((_, i) => selected.has(i)).map((k) => k.t);
  const out: Key[] = [];
  moved.forEach((k, i) => {
    if (!selected.has(i) && landed.some((t) => sameT(t, k.t, fps))) return;
    if (selected.has(i) && out.some((o) => sameT(o.t, k.t, fps))) return;
    out.push(k);
  });
  return out.sort((x, y) => x.t - y.t);
}

/** Remove the keys at `selected`; with none left the prop becomes the fixed `fallback` (AE keeps the current value). */
export function deleteKeys(keys: readonly Key[], selected: ReadonlySet<number>, fallback: number): Anim {
  const rest = keys.filter((_, i) => !selected.has(i));
  return rest.length ? rest : fallback;
}

/** AE's Auto Bezier speed at key `i`: the slope between its neighbors (one-sided at the ends). */
function autoSpeed(keys: readonly Key[], i: number) {
  const p = keys[i - 1];
  const k = keys[i]!;
  const n = keys[i + 1];
  if (p && n) return (n.v - p.v) / (n.t - p.t || 1);
  if (n) return (n.v - k.v) / (n.t - k.t || 1);
  if (p) return (k.v - p.v) / (k.t - p.t || 1);
  return 0;
}

/**
 * Apply an AE assistant or converter to the keys at `selected`:
 * Easy Ease (both sides speed 0, 33.33%), Ease In (in side), Ease Out (out side), Hold (the
 * segment leaving the key holds), Linear (both sides along the chord), Auto Bezier (smooth
 * through the key, speed from its neighbors). Selecting both keys of a segment and choosing Easy
 * Ease gives exactly [0.3333, 0, 0.6667, 1].
 */
export function applyPreset(keys: readonly Key[], selected: ReadonlySet<number>, preset: EasePreset): Key[] {
  let out = [...keys];
  const order = [...selected].filter((i) => i >= 0 && i < keys.length).sort((a, b) => a - b);
  const speeds = new Map(order.map((i) => [i, autoSpeed(keys, i)]));
  for (const i of order) {
    switch (preset) {
      case EasePreset.EasyEase:
        out = setHandle(out, i, Side.Out, EASY_INFLUENCE, 0, true);
        out = setHandle(out, i, Side.In, 1 - EASY_INFLUENCE, 1);
        break;
      case EasePreset.EaseIn:
        out = setHandle(out, i, Side.In, 1 - EASY_INFLUENCE, 1);
        break;
      case EasePreset.EaseOut:
        out = setHandle(out, i, Side.Out, EASY_INFLUENCE, 0, true);
        break;
      case EasePreset.Hold:
        if (segmentOf(out, i, Side.Out) >= 0) out = replace(out, i, withEase(out[i]!, Ease.Hold));
        break;
      case EasePreset.Linear:
        out = setHandle(out, i, Side.Out, 1 / 3, 1 / 3, true);
        out = setHandle(out, i, Side.In, 2 / 3, 2 / 3);
        break;
      case EasePreset.AutoBezier: {
        const s = speeds.get(i) ?? 0;
        out = setSpeedHandle(out, i, Side.Out, s, 1 / 3, true);
        out = setSpeedHandle(out, i, Side.In, s, 1 / 3);
        break;
      }
    }
  }
  return out;
}
