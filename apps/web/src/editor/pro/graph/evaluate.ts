import type { Key } from "../keys";

/**
 * TypeScript mirror of the engine's keyframe sampling (crates/scene/src/anim.rs): every `Easing`
 * variant, the CSS cubic-bezier solve and `sample_keys`, step for step, so the graph can draw
 * exact curves even before (or without) the engine's own sampler.
 */

/** Easing names as the engine spells them (`Easing`, snake_case). */
export const Ease = {
  Linear: "linear",
  EaseInOut: "ease_in_out",
  EaseOut: "ease_out",
  EaseIn: "ease_in",
  Back: "back",
  Hold: "hold",
  ExpoOut: "expo_out",
  ExpoIn: "expo_in",
  ExpoInOut: "expo_in_out",
  Elastic: "elastic",
  Bounce: "bounce",
  Spring: "spring",
} as const;
export type Ease = (typeof Ease)[keyof typeof Ease];

/** A key without `ease` leaves with ease-in-out (`#[default] EaseInOut`). */
export const DEFAULT_EASE: Ease = Ease.EaseInOut;

/** CSS cubic-bezier(x1, y1, x2, y2) of the segment that leaves a key. */
export type Bezier = [number, number, number, number];

/** `f32::EPSILON`: the engine's floor for a segment's span. */
const F32_EPSILON = 1.1920929e-7;
const TAU = Math.PI * 2;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** `Easing::apply`: progress 0..1 (may overshoot) at `t` along the segment. */
export function applyEase(ease: string, t: number): number {
  t = clamp01(t);
  switch (ease) {
    case Ease.Linear:
      return t;
    case Ease.EaseIn:
      return t * t * t;
    case Ease.EaseOut:
      return 1 - (1 - t) ** 3;
    case Ease.EaseInOut:
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    case Ease.Back: {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
    }
    case Ease.Hold:
      return 0;
    case Ease.ExpoOut:
      return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
    case Ease.ExpoIn:
      return t <= 0 ? 0 : 2 ** (10 * t - 10);
    case Ease.ExpoInOut:
      if (t <= 0 || t >= 1) return t;
      return t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;
    case Ease.Elastic:
      if (t <= 0 || t >= 1) return t;
      return 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * TAU) / 3) + 1;
    case Ease.Spring:
      return springStep(t);
    case Ease.Bounce: {
      const n = 7.5625;
      const d = 2.75;
      if (t < 1 / d) return n * t * t;
      if (t < 2 / d) {
        const u = t - 1.5 / d;
        return n * u * u + 0.75;
      }
      if (t < 2.5 / d) {
        const u = t - 2.25 / d;
        return n * u * u + 0.9375;
      }
      const u = t - 2.625 / d;
      return n * u * u + 0.984375;
    }
    default:
      // A name this mirror doesn't know yet (the engine grew a new one): linear until it learns it.
      return t;
  }
}

/** Damped oscillator step (damping ratio 0.42), rescaled to land on 1 at u = 1 (`spring_step`). */
const SPRING_ZETA = 0.42;
const SPRING_W = Math.log(1000) / SPRING_ZETA;
const SPRING_WD = SPRING_W * Math.sqrt(1 - SPRING_ZETA * SPRING_ZETA);
const springX = (u: number) =>
  1 - Math.exp(-SPRING_ZETA * SPRING_W * u) * (Math.cos(SPRING_WD * u) + ((SPRING_ZETA * SPRING_W) / SPRING_WD) * Math.sin(SPRING_WD * u));
const SPRING_END = springX(1);
function springStep(u: number) {
  return u >= 1 ? 1 : springX(u) / SPRING_END;
}

/** `cubic_bezier`: solve x(u) = t by 8 Newton steps (clamped), then return y(u). */
export function cubicBezier(b: readonly number[], t: number): number {
  const [x1, y1, x2, y2] = b as unknown as Bezier;
  t = clamp01(t);
  const bez = (a: number, c: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * c * u * u * (1 - u) + u * u * u;
  const dbez = (a: number, c: number, u: number) => 3 * a * (1 - u) ** 2 + 6 * (c - a) * u * (1 - u) + 3 * (1 - c) * u * u;
  let u = t;
  for (let i = 0; i < 8; i++) {
    const d = dbez(x1, x2, u);
    if (Math.abs(d) < 1e-6) break;
    u = clamp01(u - (bez(x1, x2, u) - t) / d);
  }
  return bez(y1, y2, u);
}

export const hasBezier = (k: Key): k is Key & { bezier: Bezier } => Array.isArray(k.bezier) && k.bezier.length === 4;
export const easeOf = (k: Key): string => k.ease ?? DEFAULT_EASE;
/** The segment leaving `k` holds its value (a bezier overrides the ease, even `hold`). */
export const isHold = (k: Key) => !hasBezier(k) && easeOf(k) === Ease.Hold;

/** Progress along the segment that leaves key `a`, at segment fraction `u`. */
export function progress(a: Key, u: number): number {
  return hasBezier(a) ? cubicBezier(a.bezier, u) : applyEase(easeOf(a), u);
}

/** `sample_keys`: the value at layer-local time `t`. Keys must be sorted by time. */
export function sampleKeys(keys: readonly Key[], t: number): number {
  if (!keys.length) return 0;
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (t <= first.t) return first.v;
  if (t >= last.t) return last.v;
  // partition_point(|k| k.t <= t)
  let i = 0;
  while (i < keys.length && keys[i]!.t <= t) i++;
  const a = keys[i - 1]!;
  const b = keys[i]!;
  const span = Math.max(b.t - a.t, F32_EPSILON);
  const u = (t - a.t) / span;
  return a.v + (b.v - a.v) * progress(a, u);
}

/**
 * Cubic-bezier stand-ins for the named eases, used to show (and start dragging) handles on a
 * segment that has no `bezier` yet. Linear, ease in/out and back are exact cubics; the rest are the
 * usual close fits (elastic, bounce and spring can't be a single cubic).
 */
const EASE_BEZIER: Record<Exclude<Ease, typeof Ease.Hold>, Bezier> = {
  [Ease.Linear]: [1 / 3, 1 / 3, 2 / 3, 2 / 3],
  [Ease.EaseIn]: [1 / 3, 0, 2 / 3, 0],
  [Ease.EaseOut]: [1 / 3, 1, 2 / 3, 1],
  [Ease.EaseInOut]: [0.65, 0, 0.35, 1],
  [Ease.Back]: [1 / 3, (3 * (1.70158 + 1) - 2 * 1.70158) / 3, 2 / 3, 1],
  [Ease.ExpoOut]: [0.16, 1, 0.3, 1],
  [Ease.ExpoIn]: [0.7, 0, 0.84, 0],
  [Ease.ExpoInOut]: [0.87, 0, 0.13, 1],
  [Ease.Elastic]: [0.34, 1.56, 0.64, 1],
  [Ease.Bounce]: [0.33, 1, 0.68, 1],
  [Ease.Spring]: [0.3, 1.45, 0.6, 1],
};

/** The bezier that shapes the segment leaving `k` (named eases approximated); null for a hold. */
export function bezierOf(k: Key): Bezier | null {
  if (hasBezier(k)) return [...k.bezier] as Bezier;
  const e = easeOf(k);
  if (e === Ease.Hold) return null;
  return [...(EASE_BEZIER[e as keyof typeof EASE_BEZIER] ?? EASE_BEZIER[Ease.Linear])] as Bezier;
}
