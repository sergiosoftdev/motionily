import { OpName, type Op } from "@motionily/protocol";
import type { SceneLayerView, SceneView } from "../sceneView";

/**
 * Transitions between clips of the main track, made only of what the engine already draws: the
 * incoming clip starts `duration` seconds before the previous one ends (they overlap), sits above it
 * and fades in with opacity keyframes. A dip also holds the incoming clip black (or white) with a
 * keyframed color effect while it fades in, so the old clip dips to black, then lifts the color: the
 * classic dip, with half its length taken from each clip. Everything lives on the incoming clip, so
 * moving, trimming and splitting only have to look after one layer, and the agent writes the same
 * keys (docs/agent/syntax.md, "Transitions between clips").
 */

export const TransitionKind = { Dissolve: "dissolve", DipToBlack: "dip_to_black", DipToWhite: "dip_to_white" } as const;
export type TransitionKind = (typeof TransitionKind)[keyof typeof TransitionKind];

export const TRANSITION_LABEL: Record<TransitionKind, string> = {
  [TransitionKind.Dissolve]: "Dissolve",
  [TransitionKind.DipToBlack]: "Dip to black",
  [TransitionKind.DipToWhite]: "Dip to white",
};
const DEFAULT_LENGTH: Record<TransitionKind, number> = {
  [TransitionKind.Dissolve]: 0.5,
  [TransitionKind.DipToBlack]: 0.6,
  [TransitionKind.DipToWhite]: 0.6,
};
/** Brightness a dip holds the incoming clip at while it fades in (the color effect adds it to every pixel). */
const DIP_BRIGHTNESS: Record<TransitionKind, number> = { [TransitionKind.Dissolve]: 0, [TransitionKind.DipToBlack]: -1, [TransitionKind.DipToWhite]: 1 };

export const MIN_TRANSITION = 0.1;
export const MAX_TRANSITION = 2;
/** Clips this close (s) touch: there is a cut between them. */
export const CUT_EPS = 0.02;
/** How far (s) an overlap may differ from its keyframes and still read as that transition. */
const MATCH_EPS = 0.02;
const EPS = 0.001;
/** Shortest piece of a clip a transition leaves on screen. */
const MIN_SHOWN = 0.1;

/** Engine vocabulary the keys use. */
const Ease = { Linear: "linear" } as const;
const COLOR_EFFECT = "color";

/** A transition into a main-track clip from the clip before it (`from`), which it overlaps for `duration` s. */
export type ClipTransition = { kind: TransitionKind; duration: number; from: string };
/** The clip fields the transition ops need (an `EditClip` has them all). */
export type TransitionClip = { id: string; start: number; end: number; transition: ClipTransition | null; outgoing: number };

type Key = { t: number; v: number; ease?: string };
type Effect = Record<string, unknown>;

const isKeys = (a: unknown): a is Key[] => Array.isArray(a) && a.every((k) => typeof k === "object" && k !== null && typeof (k as Key).t === "number" && typeof (k as Key).v === "number");
const near = (a: number, b: number, eps = EPS) => Math.abs(a - b) <= eps;
export const round = (n: number) => Math.round(n * 1000) / 1000;

/** Index, sign (−1 black, +1 white) and length of the dip's color effect in a layer's effects. */
function dipEffect(effects: unknown): { index: number; sign: number; length: number } | null {
  if (!Array.isArray(effects)) return null;
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i] as Effect | null;
    if (!e || e.fx !== COLOR_EFFECT || (e.hue ?? 0) !== 0 || (e.saturation ?? 1) !== 1 || (e.contrast ?? 1) !== 1) continue;
    const b = e.brightness;
    if (!isKeys(b) || b.length !== 3) continue;
    const [k0, k1, k2] = b as [Key, Key, Key];
    if (near(k0.t, 0) && near(Math.abs(k0.v), 1) && near(k1.v, k0.v) && near(k2.v, 0) && k2.t > k1.t) return { index: i, sign: Math.sign(k0.v), length: k2.t };
  }
  return null;
}

/** The transition a layer's keys describe (whether it overlaps a clip is for the caller to check). */
export function readTransition(l: SceneLayerView): { kind: TransitionKind; duration: number } | null {
  const o = l.opacity;
  if (!isKeys(o) || o.length !== 2) return null;
  const [a, b] = o as [Key, Key];
  if (!near(a.t, 0) || !near(a.v, 0) || !near(b.v, 1) || b.t <= 0) return null;
  const dip = dipEffect(l.effects);
  if (dip && near(dip.length / 2, b.t, MATCH_EPS)) return { kind: dip.sign < 0 ? TransitionKind.DipToBlack : TransitionKind.DipToWhite, duration: dip.length };
  return { kind: TransitionKind.Dissolve, duration: b.t };
}

/** True when an overlap of `overlap` seconds matches a transition of `duration`. */
export const overlapMatches = (overlap: number, duration: number) => near(overlap, duration, MATCH_EPS);

const withoutDip = (l: SceneLayerView): unknown[] => {
  const effects = Array.isArray(l.effects) ? l.effects : [];
  const dip = dipEffect(effects);
  return dip ? effects.filter((_, i) => i !== dip.index) : effects;
};

/** Patch fields that give a layer the transition's keys (its other effects stay). */
function transitionFields(l: SceneLayerView, kind: TransitionKind, d: number): Record<string, unknown> {
  const rest = withoutDip(l);
  const fade = kind === TransitionKind.Dissolve ? d : d / 2;
  const opacity: Key[] = [
    { t: 0, v: 0, ease: Ease.Linear },
    { t: round(fade), v: 1, ease: Ease.Linear },
  ];
  const s = DIP_BRIGHTNESS[kind];
  const dip: Effect[] = s
    ? [
        {
          fx: COLOR_EFFECT,
          brightness: [
            { t: 0, v: s, ease: Ease.Linear },
            { t: round(d / 2), v: s, ease: Ease.Linear },
            { t: round(d), v: 0, ease: Ease.Linear },
          ],
        },
      ]
    : [];
  const effects = [...rest, ...dip];
  return { opacity, effects: effects.length ? effects : null };
}

/** Patch fields that take a layer's transition keys off (nothing when it has none). */
export function stripTransitionFields(l: SceneLayerView): Record<string, unknown> | null {
  if (!readTransition(l)) return null;
  const rest = withoutDip(l);
  return { opacity: null, effects: rest.length ? rest : null };
}

const layerOf = (scene: SceneView, id: string) => scene.layers.find((l) => l.id === id);

/** Ops that take the transition keys off a clip (none when it has none). */
export function stripTransitionOps(scene: SceneView, id: string): Op[] {
  const l = layerOf(scene, id);
  const fields = l && stripTransitionFields(l);
  return fields ? [{ op: OpName.Patch, id, fields }] : [];
}

/**
 * Move everything that starts at or after scene second `from` (layers and sound effects) by `dt`,
 * except the layers in `skip`, and the video length with it: the main track rippling.
 */
export function shiftAfterOps(scene: SceneView, from: number, dt: number, skip: Set<string>): Op[] {
  const ops: Op[] = [];
  for (const l of scene.layers) {
    const start = l.start ?? 0;
    if (skip.has(l.id) || start < from - EPS) continue;
    ops.push({ op: OpName.SetTiming, id: l.id, start: round(Math.max(0, start + dt)), end: l.end == null ? null : round(l.end + dt) });
  }
  for (const cue of scene.sfx ?? []) if (cue.at >= from - EPS) ops.push({ op: OpName.PutSfx, cue: { ...cue, at: round(Math.max(0, cue.at + dt)) } });
  ops.push({ op: OpName.SetDuration, duration: round(Math.max(MIN_SHOWN, scene.duration + dt)) });
  return ops;
}

/** Longest transition `a` can leave by: it keeps some picture between its own way in and way out. */
export const roomAfter = (a: TransitionClip) => Math.min(MAX_TRANSITION, a.end - a.start - (a.transition?.duration ?? 0) - MIN_SHOWN);
/** Longest transition `b` can enter with. */
export const roomBefore = (b: TransitionClip) => Math.min(MAX_TRANSITION, b.end - b.start - b.outgoing - MIN_SHOWN);

/** Longest transition that fits between `a` and `b` (each keeps some picture of its own). */
export function maxTransition(a: TransitionClip, b: TransitionClip): number {
  return Math.max(0, Math.min(roomAfter(a), roomBefore(b)));
}

/** Keys of `kind` over `d` seconds on `b`, which overlaps `a` by `d` and sits right above it. */
function keyOps(scene: SceneView, a: TransitionClip, b: TransitionClip, kind: TransitionKind, d: number): Op[] {
  const l = layerOf(scene, b.id);
  if (!l) return [];
  const ops: Op[] = [{ op: OpName.Patch, id: b.id, fields: transitionFields(l, kind, d) }];
  const ai = scene.layers.findIndex((x) => x.id === a.id);
  const bi = scene.layers.findIndex((x) => x.id === b.id);
  // The incoming clip fades in over the outgoing one, so it must draw above it.
  if (bi < ai) ops.push({ op: OpName.Reorder, id: b.id, index: ai });
  return ops;
}

/**
 * Add a transition at the cut between `a` and `b` (touching clips of the main track): `b` and
 * everything after it moves back by its length, so the clips overlap and the video gets shorter.
 */
export function addTransitionOps(scene: SceneView, a: TransitionClip, b: TransitionClip, kind: TransitionKind): Op[] | null {
  const d = round(Math.min(DEFAULT_LENGTH[kind], maxTransition(a, b)));
  if (d < MIN_TRANSITION) return null;
  return [...shiftAfterOps(scene, b.start, -d, new Set([a.id])), ...keyOps(scene, a, b, kind, d)];
}

/** Another kind for an existing transition (same length). */
export function changeTransitionOps(scene: SceneView, a: TransitionClip, b: TransitionClip, kind: TransitionKind): Op[] {
  return b.transition ? keyOps(scene, a, b, kind, b.transition.duration) : [];
}

/** Make a transition `d` seconds long: `b` and what follows slide to keep the overlap equal to it. */
export function retimeTransitionOps(scene: SceneView, a: TransitionClip, b: TransitionClip, d: number): Op[] {
  if (!b.transition) return [];
  const next = round(Math.min(Math.max(d, MIN_TRANSITION), maxTransition(a, b)));
  const delta = next - b.transition.duration;
  return [...shiftAfterOps(scene, b.start, -delta, new Set([a.id])), ...keyOps(scene, a, b, b.transition.kind, next)];
}

/** Take a transition out: `b` and what follows slide forward again, back to a plain cut. */
export function removeTransitionOps(scene: SceneView, a: TransitionClip, b: TransitionClip): Op[] {
  if (!b.transition) return [];
  return [...shiftAfterOps(scene, b.start, b.transition.duration, new Set([a.id])), ...stripTransitionOps(scene, b.id)];
}

/**
 * After a trim changed how much `b` overlaps `a`: re-key the transition to the new overlap, or take
 * it off when the clips no longer overlap enough to hold one.
 */
export function refitTransitionOps(scene: SceneView, a: TransitionClip, b: TransitionClip, overlap: number): Op[] {
  if (!b.transition) return [];
  if (overlap < MIN_TRANSITION) return stripTransitionOps(scene, b.id);
  return keyOps(scene, a, b, b.transition.kind, round(overlap));
}
