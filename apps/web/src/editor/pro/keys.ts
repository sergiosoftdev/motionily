import { OpName, type Op } from "@motionily/protocol";

/** A keyframe as the scene stores it: time relative to the layer start, value, easing to the next key. */
export type Key = { t: number; v: number; ease?: string; bezier?: number[] };
/** A layer number: fixed, keyframed or a formula. */
export type Anim = number | Key[] | string;

export const isKeys = (a: unknown): a is Key[] => Array.isArray(a);
export const isExpr = (a: unknown): a is string => typeof a === "string";

/** Keys land on frames. */
export const snap = (t: number, fps: number) => Math.round(t * fps) / fps;
/** Two keys within half a frame are the same key. */
const same = (a: number, b: number, fps: number) => Math.abs(a - b) < 0.5 / fps;

export const keyAt = (a: Anim | undefined, lt: number, fps: number) => (isKeys(a) ? a.find((k) => same(k.t, lt, fps)) : undefined);

function insert(a: Key[], k: Key): Key[] {
  // A new key takes the easing of the key before it, so the motion keeps its feel.
  const before = [...a].reverse().find((x) => x.t < k.t);
  return [...a, before?.ease ? { ...k, ease: before.ease } : k].sort((x, y) => x.t - y.t);
}

/** The value at local time `lt` becomes `v`: a fixed value changes, an animated one gets (or updates) a key there. */
export function setAt(a: Anim | undefined, lt: number, v: number, fps: number): Anim {
  if (!isKeys(a)) return v;
  const t = snap(lt, fps);
  return keyAt(a, t, fps) ? a.map((k) => (same(k.t, t, fps) ? { ...k, v } : k)) : insert(a, { t, v });
}

/** A key at the current time with the current value (a fixed value becomes animated). */
export function addKey(a: Anim | undefined, lt: number, current: number, fps: number): Anim {
  const t = snap(lt, fps);
  if (!isKeys(a)) return [{ t, v: current }];
  return keyAt(a, t, fps) ? a : insert(a, { t, v: current });
}

export function moveKey(a: Anim | undefined, from: number, to: number, fps: number): Anim | undefined {
  if (!isKeys(a)) return a;
  const t = snap(Math.max(0, to), fps);
  // Dropping onto another key replaces it.
  return a
    .filter((k) => same(k.t, from, fps) || !same(k.t, t, fps))
    .map((k) => (same(k.t, from, fps) ? { ...k, t } : k))
    .sort((x, y) => x.t - y.t);
}

export function removeKey(a: Anim | undefined, t: number, fps: number): Anim | undefined {
  if (!isKeys(a)) return a;
  const rest = a.filter((k) => !same(k.t, t, fps));
  return rest.length ? rest : (a.find((k) => same(k.t, t, fps))?.v ?? 0);
}

/** Key times of several props together (Position = x and y), sorted, without duplicates. */
export function keyTimes(anims: (Anim | undefined)[], fps: number): Key[] {
  const out: Key[] = [];
  for (const a of anims) if (isKeys(a)) for (const k of a) if (!out.some((o) => same(o.t, k.t, fps))) out.push(k);
  return out.sort((x, y) => x.t - y.t);
}

export const setProp = (id: string, prop: string, value: Anim | undefined): Op => ({ op: OpName.SetProp, id, prop, value });

/** A row of the Transform group: one or two scene props shown as one AE property. */
export type PropDef = {
  label: string;
  props: string[];
  /** Shown value = stored value × factor (scale and opacity show as %). */
  factor?: number;
  unit?: string;
  /** Change per pixel dragged, in shown units. */
  step: number;
  min?: number;
  max?: number;
  /** Shown even when the layer leaves it at 0. */
  always?: boolean;
};

export const TRANSFORM: PropDef[] = [
  { label: "Position", props: ["x", "y"], step: 1, always: true },
  { label: "Scale", props: ["scale"], factor: 100, unit: "%", step: 0.5, always: true },
  { label: "Rotation", props: ["rotation"], unit: "°", step: 0.5, always: true },
  { label: "Opacity", props: ["opacity"], factor: 100, unit: "%", step: 0.5, min: 0, max: 100, always: true },
  { label: "Size", props: ["w", "h"], step: 1, min: 0 },
  { label: "Roundness", props: ["radius"], step: 0.5, min: 0 },
  { label: "Depth (z)", props: ["z"], step: 1 },
  { label: "X Rotation", props: ["rotate_x"], unit: "°", step: 0.5 },
  { label: "Y Rotation", props: ["rotate_y"], unit: "°", step: 0.5 },
  { label: "Feather", props: ["soft"], step: 0.5, min: 0 },
  { label: "Backdrop blur", props: ["backdrop"], step: 0.5, min: 0 },
];

/** The rows a layer shows: Position, Scale, Rotation, Opacity, plus whatever else it uses. */
export function rowsFor(layer: Record<string, unknown>): PropDef[] {
  return TRANSFORM.filter((d) => d.always || d.props.some((p) => layer[p] !== undefined && layer[p] !== 0));
}

/** Every prop the Transform rows handle (the generic inspector leaves them to those rows). */
export const TRANSFORM_PROPS = new Set(TRANSFORM.flatMap((d) => d.props));
