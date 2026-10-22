import type { Op } from "@motionily/protocol";
import { isKeys, setProp, snap, type Anim, type Key } from "../keys";
import type { TimelineScene } from "./contract";
import { sameTime, type KeyRef } from "./selection";

/**
 * Keyframe editing for the timeline: interpolation (AE's Keyframe Interpolation and Easy Ease),
 * moving several keys at once, delete, copy and paste. Everything comes out as `set_prop` ops.
 *
 * The engine stores one curve per segment, on the key that starts it (`ease` or `bezier` to the
 * next key). AE thinks per key side: a key's "out" is the start of its segment, its "in" the end of
 * the previous one. Easy Ease In/Out edit the matching bezier handle, like AE's influence handles.
 */

/** Named eases the engine knows (Easing in crates/scene/src/anim.rs). */
export const Ease = {
  Linear: "linear",
  EaseInOut: "ease_in_out",
  EaseIn: "ease_in",
  EaseOut: "ease_out",
  ExpoIn: "expo_in",
  ExpoOut: "expo_out",
  ExpoInOut: "expo_in_out",
  Back: "back",
  Elastic: "elastic",
  Bounce: "bounce",
  Spring: "spring",
  Hold: "hold",
} as const;
export type Ease = (typeof Ease)[keyof typeof Ease];
/** What the engine uses when a key has no `ease`. */
export const DEFAULT_EASE: Ease = Ease.EaseInOut;

export type Bezier = [number, number, number, number];
/** AE's Easy Ease: 33.33% influence, zero speed at the key. */
export const EASY_EASE: Bezier = [0.33, 0, 0.67, 1];
const EASE_OUT_HANDLE: [number, number] = [0.33, 0];
const EASE_IN_HANDLE: [number, number] = [0.67, 1];

/** Closest bezier of each named ease, so easing one side keeps the other side's feel. */
const EASE_HANDLES: Record<Ease, Bezier> = {
  linear: [0.33, 0.33, 0.67, 0.67],
  ease_in_out: [0.65, 0, 0.35, 1],
  ease_in: [0.32, 0, 0.67, 0],
  ease_out: [0.33, 1, 0.68, 1],
  expo_in: [0.7, 0, 0.84, 0],
  expo_out: [0.16, 1, 0.3, 1],
  expo_in_out: [0.87, 0, 0.13, 1],
  back: [0.34, 1.56, 0.64, 1],
  elastic: [0.33, 0.33, 0.67, 0.67],
  bounce: [0.33, 0.33, 0.67, 0.67],
  spring: [0.33, 0.33, 0.67, 0.67],
  hold: [0.33, 0.33, 0.67, 0.67],
};

/** How one side of a key is drawn: AE's diamond, hourglass, square, or a circle for overshooting curves. */
export const KeySide = { Linear: "linear", Eased: "eased", Hold: "hold", Custom: "custom" } as const;
export type KeySide = (typeof KeySide)[keyof typeof KeySide];

const near = (a: number, b: number) => Math.abs(a - b) < 0.03;
const SLOW_START = new Set<string>([Ease.EaseIn, Ease.EaseInOut, Ease.ExpoIn, Ease.ExpoInOut]);
const SLOW_END = new Set<string>([Ease.EaseOut, Ease.EaseInOut, Ease.ExpoOut, Ease.ExpoInOut]);
const OVERSHOOT = new Set<string>([Ease.Back, Ease.Elastic, Ease.Bounce, Ease.Spring]);

const easeOf = (k: Key) => (k.ease ?? DEFAULT_EASE) as Ease;

/** How the segment that starts at `k` leaves it (out) and reaches the next key (in). */
export function segmentSides(k: Key): { out: KeySide; in: KeySide } {
  const b = k.bezier;
  if (b && b.length === 4) {
    const [x1, y1, x2, y2] = b as Bezier;
    const side = (x: number, y: number, flat: number) => (near(x, y) ? KeySide.Linear : near(y, flat) ? KeySide.Eased : KeySide.Custom);
    return { out: side(x1, y1, 0), in: side(x2, y2, 1) };
  }
  const e = easeOf(k);
  if (e === Ease.Hold) return { out: KeySide.Hold, in: KeySide.Linear };
  if (OVERSHOOT.has(e)) return { out: KeySide.Custom, in: KeySide.Custom };
  return { out: SLOW_START.has(e) ? KeySide.Eased : KeySide.Linear, in: SLOW_END.has(e) ? KeySide.Eased : KeySide.Linear };
}

/** Left (incoming) and right (outgoing) half of the key at index `i`. The ends mirror their only side. */
export function keySides(keys: Key[], i: number): [KeySide, KeySide] {
  const out = segmentSides(keys[i]!).out;
  const inn = i > 0 ? segmentSides(keys[i - 1]!).in : out;
  return [inn, i < keys.length - 1 || i === 0 ? out : inn === KeySide.Hold ? KeySide.Linear : out];
}

/** The interpolation a key's menu shows as checked: a named ease, or "bezier" for a custom curve. */
export const BEZIER = "bezier";
export function keyInterp(k: Key): Ease | typeof BEZIER {
  return k.bezier ? BEZIER : easeOf(k);
}

const handles = (k: Key): Bezier => (k.bezier && k.bezier.length === 4 ? ([...k.bezier] as Bezier) : [...EASE_HANDLES[easeOf(k)]]);
const withBezier = (k: Key, b: Bezier): Key => ({ ...k, ease: easeOf(k) === Ease.Hold ? DEFAULT_EASE : easeOf(k), bezier: b.map((n) => Math.round(n * 1000) / 1000) });
const withEase = (k: Key, ease: Ease): Key => {
  const { bezier: _drop, ...rest } = k;
  return { ...rest, ease };
};

export const EaseSide = { Both: "both", In: "in", Out: "out" } as const;
export type EaseSide = (typeof EaseSide)[keyof typeof EaseSide];

/** F9 / ⇧F9 / ⌘⇧F9 on the keys of one animation at `times`. */
export function easyEase(keys: Key[], times: number[], side: EaseSide, fps: number): Key[] {
  const out = keys.map((k) => ({ ...k }));
  out.forEach((k, i) => {
    if (!times.some((t) => sameTime(t, k.t, fps))) return;
    if (side !== EaseSide.In) {
      const h = handles(out[i]!);
      out[i] = withBezier(out[i]!, [...EASE_OUT_HANDLE, h[2], h[3]]);
    }
    if (side !== EaseSide.Out && i > 0) {
      const h = handles(out[i - 1]!);
      out[i - 1] = withBezier(out[i - 1]!, [h[0], h[1], ...EASE_IN_HANDLE]);
    }
  });
  return out;
}

/**
 * The Keyframe Interpolation menu. Linear and Easy Ease set both sides of the key (so the previous
 * segment's end changes too, as in AE); Hold and the named eases set the curve to the next key.
 */
export function setInterpolation(keys: Key[], times: number[], choice: Ease | typeof BEZIER, fps: number): Key[] {
  if (choice === BEZIER) return easyEase(keys, times, EaseSide.Both, fps);
  const out = keys.map((k) => ({ ...k }));
  out.forEach((k, i) => {
    if (!times.some((t) => sameTime(t, k.t, fps))) return;
    out[i] = withEase(out[i]!, choice);
    const prev = out[i - 1];
    if (choice === Ease.Linear && prev && segmentSides(prev).in !== KeySide.Linear && prev.bezier) {
      const h = handles(prev);
      out[i - 1] = withBezier(prev, [h[0], h[1], 0.67, 0.67]);
    }
  });
  return out;
}

// ── selections → ops ─────────────────────────────────────────────────

/** Selected key times per (layer, scene prop). */
export function byAnim(refs: KeyRef[]): Map<string, { id: string; prop: string; times: number[] }> {
  const m = new Map<string, { id: string; prop: string; times: number[] }>();
  for (const r of refs)
    for (const prop of r.props) {
      const k = `${r.id}\u0000${prop}`;
      const e = m.get(k) ?? { id: r.id, prop, times: [] };
      e.times.push(r.t);
      m.set(k, e);
    }
  return m;
}

const animOf = (scene: TimelineScene, id: string, prop: string) => scene.layers.find((l) => l.id === id)?.[prop] as Anim | undefined;

/** One `set_prop` per animation the selection touches, with its keys rewritten by `edit`. */
export function editSelected(scene: TimelineScene, refs: KeyRef[], edit: (keys: Key[], times: number[]) => Anim): Op[] {
  const ops: Op[] = [];
  for (const { id, prop, times } of byAnim(refs).values()) {
    const a = animOf(scene, id, prop);
    if (isKeys(a)) ops.push(setProp(id, prop, edit(a, times)));
  }
  return ops;
}

export function deleteKeys(keys: Key[], times: number[], fps: number): Anim {
  const rest = keys.filter((k) => !times.some((t) => sameTime(t, k.t, fps)));
  return rest.length ? rest : (keys[0]?.v ?? 0);
}

/** Move the keys at `times` by `dt`; landing on a key that isn't moving replaces it. */
export function moveKeys(keys: Key[], times: number[], dt: number, fps: number): Key[] {
  const moving = (k: Key) => times.some((t) => sameTime(t, k.t, fps));
  const moved = keys.filter(moving).map((k) => ({ ...k, t: snap(k.t + dt, fps) }));
  const stay = keys.filter((k) => !moving(k) && !moved.some((m) => sameTime(m.t, k.t, fps)));
  return [...stay, ...moved].sort((a, b) => a.t - b.t);
}

/** Copied keys, in scene seconds, by scene prop. */
export type ClipKey = { prop: string; at: number; key: Key };

export function copyKeys(scene: TimelineScene, refs: KeyRef[], fps: number): ClipKey[] {
  const out: ClipKey[] = [];
  for (const { id, prop, times } of byAnim(refs).values()) {
    const a = animOf(scene, id, prop);
    const start = scene.layers.find((l) => l.id === id)?.start ?? 0;
    if (isKeys(a)) for (const k of a) if (times.some((t) => sameTime(t, k.t, fps))) out.push({ prop, at: start + k.t, key: k });
  }
  return out;
}

/** Paste onto layer `id` with the earliest key at scene time `at`, timing between keys kept. */
export function pasteKeys(scene: TimelineScene, clip: ClipKey[], id: string, at: number, fps: number): Op[] {
  const layer = scene.layers.find((l) => l.id === id);
  if (!layer || !clip.length) return [];
  const offset = at - Math.min(...clip.map((c) => c.at)) - (layer.start ?? 0);
  const props = [...new Set(clip.map((c) => c.prop))];
  return props.map((prop) => {
    const a = layer[prop] as Anim | undefined;
    let keys: Key[] = isKeys(a) ? a.map((k) => ({ ...k })) : [];
    for (const c of clip.filter((x) => x.prop === prop)) {
      const t = snap(c.at + offset, fps);
      keys = [...keys.filter((k) => !sameTime(k.t, t, fps)), { ...c.key, t }];
    }
    return setProp(id, prop, keys.sort((x, y) => x.t - y.t));
  });
}
