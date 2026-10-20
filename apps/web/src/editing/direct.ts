import { OpName, type Op } from "@motionily/protocol";
import { engineHost } from "../engine/host";
import { agentBridge } from "../bridge";
import { ActivitySource, logActivity } from "../store";

/**
 * Direct edits made by hand in the editor: zero tokens. They change the scene like the agent
 * would (ops), so autosave, undo by agent and the agent's view all stay in sync.
 */

/** Layer type of a component instance (`define_component` + `use`). */
const COMPONENT_INSTANCE = "use";

type Keyframe = { t: number; v: number; ease?: string };
/** A layer number: static or keyframed. */
export type Animated = number | Keyframe[];

/** Moves the whole value (every keyframe) by `d`, keeping the motion. */
export function shift(v: Animated | undefined, d: number): Animated {
  if (Array.isArray(v)) return v.map((k) => ({ ...k, v: k.v + d }));
  return (v ?? 0) + d;
}

/** Scales the whole value (every keyframe) by `k`. */
export function scale(
  v: Animated | undefined,
  k: number,
  fallback: number,
): Animated {
  if (Array.isArray(v)) return v.map((key) => ({ ...key, v: key.v * k }));
  return (v ?? fallback) * k;
}

/** Ops that move a layer by (dx, dy) scene pixels from its state in `base`. */
export function moveOps(
  id: string,
  base: Record<string, unknown>,
  dx: number,
  dy: number,
): Op[] {
  return [
    { op: OpName.SetProp, id, prop: "x", value: shift(base.x as Animated, dx) },
    { op: OpName.SetProp, id, prop: "y", value: shift(base.y as Animated, dy) },
  ];
}

/** Ops that resize a layer's box by factor `k` from `base` (text refits inside it). */
export function resizeOps(
  id: string,
  base: Record<string, unknown>,
  k: number,
  size: [number, number],
): Op[] {
  // A component instance has no box of its own: it grows by its scale.
  if (base.type === COMPONENT_INSTANCE)
    return [{ op: OpName.SetProp, id, prop: "scale", value: scale(base.scale as Animated, k, 1) }];
  return [
    {
      op: OpName.SetProp,
      id,
      prop: "w",
      value: scale(base.w as Animated, k, size[0]),
    },
    {
      op: OpName.SetProp,
      id,
      prop: "h",
      value: scale(base.h as Animated, k, size[1]),
    },
  ];
}

/** Apply while dragging: render now, no agent sync yet. */
export function preview(ops: Op[]) {
  try {
    engineHost.applyOps(ops);
  } catch {
    // A transient invalid state mid-drag: ignore.
  }
}

/** Finish an edit: let the agent's view catch up and leave a trace in the activity log. */
export function commit(what: string) {
  agentBridge.sceneChanged();
  logActivity(ActivitySource.User, what);
}

export function apply(ops: Op[], what: string) {
  engineHost.applyOps(ops);
  commit(what);
}
