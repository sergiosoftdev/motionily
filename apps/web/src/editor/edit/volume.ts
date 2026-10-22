/**
 * Volume keyframes of the Edit view: a clip's `volume` (a number or keys, seconds from the clip's
 * start, like any property) and the music's `envelope` (keys from the music's start, multiplying
 * its level). Both are drawn and edited as one rubber band, so the math lives here.
 */

/** One volume key. `ease` is the engine's curve to the next key (the Edit view writes linear ones). */
export type VolumeKey = { t: number; v: number; ease?: string };

const LINEAR = "linear";
/** Keys closer than this (s) are the same key. */
const SAME_KEY = 0.01;

const isKeys = (a: unknown): a is VolumeKey[] => Array.isArray(a) && a.every((k) => typeof k === "object" && k !== null && typeof (k as VolumeKey).t === "number" && typeof (k as VolumeKey).v === "number");

/** A clip's `volume` field as a flat level and its keys: the level is the loudest point (0 = silent throughout). */
export function readVolume(raw: unknown): { level: number; keys: VolumeKey[] | null } {
  if (typeof raw === "number") return { level: raw, keys: null };
  if (isKeys(raw) && raw.length) return { level: Math.max(...raw.map((k) => k.v)), keys: raw };
  // An expression: assume it is heard somewhere.
  if (typeof raw === "string") return { level: 1, keys: null };
  return { level: 0, keys: null };
}

/** Level at `t` (key time), straight between keys; the first and last levels hold outside them. */
export function levelAt(keys: VolumeKey[], t: number): number {
  const first = keys[0];
  const last = keys.at(-1);
  if (!first || !last) return 0;
  if (t <= first.t) return first.v;
  if (t >= last.t) return last.v;
  const i = keys.findIndex((k) => k.t > t);
  const a = keys[i - 1]!;
  const b = keys[i]!;
  return a.v + ((b.v - a.v) * (t - a.t)) / Math.max(1e-6, b.t - a.t);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const key = (t: number, v: number): VolumeKey => ({ t: r3(t), v: Math.round(clamp01(v) * 100) / 100, ease: LINEAR });

/** Add a key at `t` on the line (it does not change the sound until dragged). Returns the keys and the new key's index. */
export function insertKey(keys: VolumeKey[] | null, level: number, t: number): { keys: VolumeKey[]; index: number } {
  const list = keys ?? [];
  const v = list.length ? levelAt(list, t) : level;
  const near = list.findIndex((k) => Math.abs(k.t - t) < SAME_KEY);
  if (near >= 0) return { keys: list, index: near };
  const next = [...list, key(t, v)].sort((a, b) => a.t - b.t);
  return { keys: next, index: next.findIndex((k) => Math.abs(k.t - t) < SAME_KEY / 2) };
}

/** Move key `i` to (`t`, `v`), kept between its neighbours. */
export function moveKey(keys: VolumeKey[], i: number, t: number, v: number): VolumeKey[] {
  const lo = i > 0 ? keys[i - 1]!.t + SAME_KEY : -Infinity;
  const hi = i < keys.length - 1 ? keys[i + 1]!.t - SAME_KEY : Infinity;
  return keys.map((k, j) => (j === i ? key(Math.min(hi, Math.max(lo, t)), v) : k));
}

/** Remove key `i`; the last one left becomes a flat level. */
export function removeKey(keys: VolumeKey[], i: number): VolumeKey[] | number {
  const rest = keys.filter((_, j) => j !== i);
  return rest.length ? rest : (keys[i]?.v ?? 0);
}

/** Keys of a clip whose start moved by `dt` while its picture stayed (a trim or split): they stay on the same sound. */
export function shiftKeys(raw: unknown, dt: number): unknown {
  return isKeys(raw) ? raw.map((k) => ({ ...k, t: r3(k.t - dt) })) : raw;
}
