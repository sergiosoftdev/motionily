import { engineHost } from "../../../engine/host";
import { isExpr, isKeys, type Anim, type Key } from "../keys";
import { isHold, sampleKeys } from "./evaluate";

/**
 * Curves for the graph: values and speeds sampled at scene times, from the engine when it can
 * sample (`engineHost.sampleProp`, exact by definition) or from the TS mirror of anim.rs. Results
 * are cached per (layer, prop, keys, scene revision, visible range, density) so playback and
 * hovering only redraw.
 */

/** Where a curve's numbers came from. */
export const CurveSource = { Engine: "engine", Mirror: "mirror", None: "none" } as const;
export type CurveSource = (typeof CurveSource)[keyof typeof CurveSource];

/** What the prop holds: keys (editable), a formula (read-only) or one fixed number. */
export const CurveKind = { Keys: "keys", Formula: "formula", Fixed: "fixed" } as const;
export type CurveKind = (typeof CurveKind)[keyof typeof CurveKind];

/** A stretch drawn as one polyline; speed is discontinuous at keys, so each segment is a run. */
export type Run = { t: number[]; v: number[]; s: number[]; hold: boolean };

export type Curve = {
  kind: CurveKind;
  source: CurveSource;
  runs: Run[];
  /** Value and speed extents over the visible range (for auto-zoom). */
  vMin: number;
  vMax: number;
  sMin: number;
  sMax: number;
};

/** The engine's sampler (ENGINE agent contract), typed here so the graph doesn't wait for it to land. */
type EngineSampler = (layerId: string, prop: string, times: number[]) => ArrayLike<number>;

export function engineSampler(): EngineSampler | null {
  const host = engineHost as unknown as { ready: boolean; sampleProp?: EngineSampler };
  if (!host.ready || typeof host.sampleProp !== "function") return null;
  return (id, prop, times) => host.sampleProp!.call(engineHost, id, prop, times);
}

/** Samples per pixel of a run (every 2 px is smooth at any zoom). */
const PX_PER_SAMPLE = 2;
const MAX_SAMPLES = 1200;
const CACHE_SIZE = 48;
const cache = new Map<string, Curve>();

export type CurveRequest = {
  layerId: string;
  prop: string;
  anim: Anim | undefined;
  /** Layer start (keys are relative to it). */
  start: number;
  /** Visible scene-time range and pixels per second. */
  t0: number;
  t1: number;
  pps: number;
  /** Bumped on every scene change, so formula curves follow what they depend on. */
  revision: number;
};

export function sampleCurve(req: CurveRequest): Curve {
  const engine = engineSampler();
  const key = [req.layerId, req.prop, JSON.stringify(req.anim ?? null), req.start, req.t0.toFixed(5), req.t1.toFixed(5), req.pps.toFixed(3), engine ? req.revision : -1].join("|");
  const hit = cache.get(key);
  if (hit) return hit;
  const curve = build(req, engine);
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(key, curve);
  return curve;
}

/** Per segment: n evenly spaced sample times across [a, b] (both ends included). */
function grid(a: number, b: number, pps: number) {
  const n = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(((b - a) * pps) / PX_PER_SAMPLE) + 1));
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

/** Plan of one run: sample times plus the neighbors used for its speed, kept inside [lo, hi]. */
type Plan = { times: number[]; lefts: number[]; rights: number[]; hold: boolean; holdV?: number };

function plan(times: number[], lo: number, hi: number): Plan {
  // Finite-difference step: small against the segment, large enough for f32 engine times.
  const h = Math.min(1e-2, Math.max(1e-4, (hi - lo) * 1e-3));
  return {
    times,
    lefts: times.map((t) => Math.max(lo, t - h)),
    rights: times.map((t) => Math.min(hi, t + h)),
    hold: false,
  };
}

function build(req: CurveRequest, engine: EngineSampler | null): Curve {
  const { anim, t0, t1, pps } = req;
  if (isKeys(anim) && anim.length) return keyCurve(req, anim, engine);
  if (isExpr(anim)) {
    // Formulas are read-only and only the engine can evaluate them.
    if (!engine) return finish(CurveKind.Formula, CurveSource.None, []);
    const plans = [plan(grid(t0, t1, pps), -Infinity, Infinity)];
    const runs = run(plans, (ts) => tryEngine(engine, req, ts));
    return finish(CurveKind.Formula, runs ? CurveSource.Engine : CurveSource.None, runs ?? []);
  }
  const v = typeof anim === "number" ? anim : 0;
  return finish(CurveKind.Fixed, CurveSource.Mirror, [{ t: [t0, t1], v: [v, v], s: [0, 0], hold: false }]);
}

function keyCurve(req: CurveRequest, keys: Key[], engine: EngineSampler | null): Curve {
  const { start, t0, t1, pps } = req;
  const plans: Plan[] = [];
  const T = keys.map((k) => start + k.t);
  const flat = (a: number, b: number, v: number): Plan => ({ times: [a, b], lefts: [a, b], rights: [a, b], hold: true, holdV: v });
  if (T[0]! > t0) plans.push(flat(t0, Math.min(T[0]!, t1), keys[0]!.v));
  for (let i = 0; i < keys.length - 1; i++) {
    const a = Math.max(T[i]!, t0);
    const b = Math.min(T[i + 1]!, t1);
    if (b < a) continue;
    if (isHold(keys[i]!)) plans.push(flat(a, b, keys[i]!.v));
    else plans.push(plan(grid(a, b, pps), T[i]!, T[i + 1]!));
  }
  const last = T[T.length - 1]!;
  if (last < t1) plans.push(flat(Math.max(last, t0), t1, keys[keys.length - 1]!.v));
  const mirror = (ts: number[]) => ts.map((t) => sampleKeys(keys, t - start));
  if (engine) {
    const runs = run(plans, (ts) => tryEngine(engine, req, ts));
    if (runs) return finish(CurveKind.Keys, CurveSource.Engine, runs);
  }
  return finish(CurveKind.Keys, CurveSource.Mirror, run(plans, mirror)!);
}

function tryEngine(engine: EngineSampler, req: CurveRequest, times: number[]): number[] | null {
  try {
    const out = engine(req.layerId, req.prop, times);
    if (!out || out.length !== times.length) return null;
    return Array.from(out);
  } catch {
    return null;
  }
}

/** Sample every plan in ONE batch (one engine call per prop), then split values and speeds back. */
function run(plans: Plan[], sample: (times: number[]) => number[] | null): Run[] | null {
  const all: number[] = [];
  for (const p of plans) if (!p.hold) all.push(...p.times, ...p.lefts, ...p.rights);
  const values = all.length ? sample(all) : [];
  if (!values) return null;
  let o = 0;
  return plans.map((p) => {
    if (p.hold) return { t: p.times, v: p.times.map(() => p.holdV ?? 0), s: p.times.map(() => 0), hold: true };
    const n = p.times.length;
    const v = values.slice(o, o + n);
    const l = values.slice(o + n, o + 2 * n);
    const r = values.slice(o + 2 * n, o + 3 * n);
    o += 3 * n;
    const s = p.times.map((_, i) => {
      const dt = p.rights[i]! - p.lefts[i]!;
      return dt > 0 ? (r[i]! - l[i]!) / dt : 0;
    });
    return { t: p.times, v, s, hold: false };
  });
}

function finish(kind: CurveKind, source: CurveSource, runs: Run[]): Curve {
  let vMin = Infinity;
  let vMax = -Infinity;
  let sMin = Infinity;
  let sMax = -Infinity;
  for (const r of runs) {
    for (const v of r.v) if (Number.isFinite(v)) (vMin = Math.min(vMin, v)), (vMax = Math.max(vMax, v));
    for (const s of r.s) if (Number.isFinite(s)) (sMin = Math.min(sMin, s)), (sMax = Math.max(sMax, s));
  }
  return { kind, source, runs, vMin, vMax, sMin, sMax };
}
