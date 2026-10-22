import type { Op } from "@motionily/protocol";
import { commit } from "../../../editing/direct";
import { engineHost } from "../../../engine/host";
import { useEditor } from "../../../store";
import type { SceneLayerView, SceneView } from "../../sceneView";
import { selectedLayerIds } from "../layerActions";
import { useTimelineSelection } from "../timeline/selection";
import { notify } from "./notice";

/** A component as the scene library stores it (component.rs). */
export type ComponentDef = { params?: { name: string; type: string; default?: unknown }[]; duration?: number; layers: unknown[] };

/** The parts of the scene library the panels list. */
export type SceneLibrary = {
  animations?: Record<string, unknown>;
  prefabs?: Record<string, unknown>;
  components?: Record<string, ComponentDef>;
};

/** The scene JSON with what the layer panels read beyond `SceneView`. */
export type SceneJson = SceneView & {
  width?: number;
  height?: number;
  library?: SceneLibrary;
  typography?: { family: string; body: number; heading: number } | null;
};

/** Layer type of a component instance. */
export const INSTANCE_TYPE = "use";
/** Longest component name the engine takes (component.rs NAME_MAX). */
const NAME_MAX = 40;

export function readScene(): SceneJson | null {
  return engineHost.ready ? (JSON.parse(engineHost.sceneJson()) as SceneJson) : null;
}

export const sceneLayers = (): SceneLayerView[] => readScene()?.layers ?? [];

/** Ids and component names are letters, digits and `_`, not starting with a digit. */
export function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const safe = /^[0-9]/.test(s) ? `l_${s}` : s;
  return (safe || "layer").slice(0, NAME_MAX);
}

/** `base_1`, `base_2`… (or `base` itself when `numbered` is false) that no layer uses yet. */
export function uniqueId(base: string, taken: Iterable<string> = sceneLayers().map((l) => l.id), numbered = true): string {
  const used = new Set(taken);
  const b = slug(base);
  if (!numbered && !used.has(b)) return b;
  for (let n = 1; ; n++) {
    const id = `${b}_${n}`.slice(-NAME_MAX);
    if (!used.has(id)) return id;
  }
}

/** The layers the user has selected: several in the timeline, a whole group, or the one layer (never locked ones). */
export function selectedIds(): string[] {
  return engineHost.ready ? selectedLayerIds() : [];
}

/** Same as `selectedIds`, as a hook that follows the selection. */
export function useSelectedIds(scene: SceneView | null): string[] {
  const selected = useEditor((s) => s.selectedLayerId);
  const group = useEditor((s) => s.selectedGroup);
  const multi = useTimelineSelection((s) => s.layers);
  if (selected && multi.includes(selected)) return multi;
  if (group) return (scene?.layers ?? []).filter((l) => l.group === group).map((l) => l.id);
  return selected ? [selected] : [];
}

export const selectLayer = (id: string) => useEditor.setState({ selectedLayerId: id, selectedGroup: null });

/** The layer's own clock at the playhead (keys and anims are timed from the layer start). */
export function localTime(layer: { start?: number }): number {
  return useEditor.getState().time - (layer.start ?? 0);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Apply hand edits as ordinary ops (what the agent would send), then let the agent's view catch up
 * and log them. A refused op surfaces in the menu bar; returns whether it went through.
 */
export function runOps(ops: Op[], what: string): boolean {
  if (!ops.length) return false;
  try {
    engineHost.applyOps(ops);
    commit(what);
    return true;
  } catch (e) {
    notify(message(e));
    return false;
  }
}

/** Like `runOps`, but hands the engine's refusal back to the caller (inline editors show it in place). */
export function tryOps(ops: Op[], what: string): string | null {
  try {
    engineHost.applyOps(ops);
    commit(what);
    return null;
  } catch (e) {
    return message(e);
  }
}

/** Ask for a selection when an action needs one. */
export function needSelection(ids: string[], what: string): boolean {
  if (ids.length) return true;
  notify(`Select a layer to ${what}.`);
  return false;
}
