import { engineHost } from "../../../engine/host";
import { useEditor } from "../../../store";
import { isExpr, isKeys, type Anim, type Key } from "../keys";

/** Easing names as the scene stores them (crates/scene/src/anim.rs). */
const Ease = {
  Linear: "linear",
  EaseIn: "ease_in",
  EaseOut: "ease_out",
  EaseInOut: "ease_in_out",
  Back: "back",
  Hold: "hold",
  ExpoOut: "expo_out",
  ExpoIn: "expo_in",
  ExpoInOut: "expo_in_out",
} as const;

/** Progress 0..1 through a segment, for the common curves (others read as ease in-out). */
function ease(name: string | undefined, t: number): number {
  switch (name) {
    case Ease.Linear:
      return t;
    case Ease.EaseIn:
      return t * t * t;
    case Ease.EaseOut:
      return 1 - (1 - t) ** 3;
    case Ease.Back: {
      const c1 = 1.70158;
      return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2;
    }
    case Ease.Hold:
      return 0;
    case Ease.ExpoOut:
      return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
    case Ease.ExpoIn:
      return t <= 0 ? 0 : 2 ** (10 * t - 10);
    case Ease.ExpoInOut:
      return t <= 0 || t >= 1 ? t : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;
    default:
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  }
}

function sampleKeys(keys: Key[], t: number): number {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (!first || !last) return 0;
  if (t <= first.t) return first.v;
  if (t >= last.t) return last.v;
  const i = keys.findIndex((k) => k.t > t);
  const a = keys[i - 1]!;
  const b = keys[i]!;
  const u = (t - a.t) / Math.max(b.t - a.t, 1e-6);
  return a.v + (b.v - a.v) * ease(a.ease, u);
}

/**
 * A nested animatable value of a layer (an effect param…) at layer time `lt`, for display.
 * Keys are sampled here; formulas ask the engine (`sampleProp`, top-level props only), else `undefined`.
 */
export function sampleAnim(a: Anim | undefined, lt: number, fallback = 0, engine?: { id: string; path: string }): number | undefined {
  if (a === undefined || a === null) return fallback;
  if (typeof a === "number") return a;
  if (isKeys(a)) return sampleKeys(a, lt);
  if (isExpr(a) && engine) {
    const [v] = engineHost.sampleProp(engine.id, engine.path, [useEditor.getState().time]);
    return v;
  }
  return undefined;
}
