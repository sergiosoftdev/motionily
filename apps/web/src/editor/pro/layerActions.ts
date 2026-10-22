import { OpName, type Op } from "@motionily/protocol";
import { apply } from "../../editing/direct";
import { engineHost } from "../../engine/host";
import { VIDEO_LAYER } from "../../engine/video";
import { ActivitySource, logActivity, useEditor } from "../../store";
import { freshId } from "../edit/tracks";
import { isLocked, type TimelineLayer, type TimelineScene } from "./timeline/contract";
import { useTimelineSelection } from "./timeline/selection";

/**
 * AE's layer commands (Duplicate, Split Layer, the [ ] in/out keys) as plain functions. Each one is
 * a batch of ordinary ops (`add_layer`, `reorder`, `set_timing`, `patch`) with fresh unique ids,
 * so the agent sees exactly what a hand edit did. The timeline shortcuts and the Layer menu share them.
 * Without `ids` they act on the selected layers; locked layers are always left alone.
 */

/** Shortest a layer can be trimmed to, in seconds. */
export const MIN_LAYER = 0.1;
/** Key and time values are rounded to this, so float noise never shows up in the scene. */
const PRECISION = 1e4;
const round = (n: number) => Math.round(n * PRECISION) / PRECISION;

export const readScene = (): TimelineScene => JSON.parse(engineHost.sceneJson()) as TimelineScene;
const fpsOf = (scene: TimelineScene) => scene.fps ?? 30;
/** The playhead, on a frame. */
const playhead = (fps: number) => Math.round(useEditor.getState().time * fps) / fps;
const endOf = (l: TimelineLayer, scene: TimelineScene) => (l.end == null ? scene.duration : l.end);

/** Apply a batch as one hand edit; a refused batch is logged instead of throwing out of a key handler. */
export function runOps(ops: Op[], what: string): boolean {
  if (!ops.length) return false;
  try {
    apply(ops, what);
    return true;
  } catch (e) {
    logActivity(ActivitySource.System, `${what}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** The layers the timeline has selected (several after Shift-click or ⌘A), never locked ones. */
export function selectedLayerIds(scene: TimelineScene = readScene()): string[] {
  const { selectedLayerId, selectedGroup } = useEditor.getState();
  const multi = useTimelineSelection.getState().layers;
  let ids: string[] = [];
  if (selectedLayerId && multi.includes(selectedLayerId)) ids = multi;
  else if (selectedLayerId) ids = [selectedLayerId];
  else if (selectedGroup) ids = scene.layers.filter((l) => l.group === selectedGroup).map((l) => l.id);
  return ids.filter((id) => {
    const l = scene.layers.find((x) => x.id === id);
    return l && !isLocked(l);
  });
}

/** Select these layers in the timeline; `primary` (default: the topmost) drives Effect Controls. */
export function selectLayers(ids: string[], primary?: string) {
  const main = primary ?? ids[ids.length - 1] ?? null;
  useEditor.setState({ selectedLayerId: main, selectedGroup: null });
  useTimelineSelection.setState({ layers: ids, keys: [], marker: null });
}

/** ⌘A: every layer that isn't locked. */
export function selectAllLayers() {
  const scene = readScene();
  const ids = scene.layers.filter((l) => !isLocked(l)).map((l) => l.id);
  selectLayers(ids);
}

// ── time shifts ───────────────────────────────────────────────────────

const isKeyList = (v: unknown): v is { t: number }[] =>
  Array.isArray(v) && v.length > 0 && v.every((k) => k !== null && typeof k === "object" && !Array.isArray(k) && typeof (k as { t?: unknown }).t === "number" && "v" in k);

function shiftKeys(v: unknown, d: number): unknown {
  if (isKeyList(v)) return v.map((k) => ({ ...k, t: round(k.t - d) }));
  if (Array.isArray(v)) return v.map((x) => shiftKeys(x, d));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shiftKeys(x, d)]));
  return v;
}

/** Fields the start moves by itself (or that never hold layer time). */
const TIMING_FIELDS = new Set(["id", "type", "start", "end", "anims", "group", "parent", "matte"]);

/**
 * The fields to patch so the layer keeps its content in place while its start moves by `d`
 * seconds: keyframes (stored relative to the start) move by −d, animation bricks too, and a video
 * advances its source in-point. Expressions of `t` are left as they are.
 */
export function shiftLocalTime(l: TimelineLayer, d: number): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (Math.abs(d) < 1e-6) return fields;
  for (const [k, v] of Object.entries(l)) {
    if (TIMING_FIELDS.has(k)) continue;
    const shifted = shiftKeys(v, d);
    if (JSON.stringify(shifted) !== JSON.stringify(v)) fields[k] = shifted;
  }
  const anims = l.anims as { at?: number }[] | undefined;
  if (Array.isArray(anims) && anims.length) fields.anims = anims.map((a) => ({ ...a, at: round((a.at ?? 0) - d) }));
  if (l.type === VIDEO_LAYER) fields.in = round(Math.max(0, num(l.in, 0) + d * num(l.speed, 1)));
  return fields;
}

const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);

/** Earliest start a trim can reach: a video can't start before the first frame of its file. */
function earliestStart(l: TimelineLayer) {
  return l.type === VIDEO_LAYER ? (l.start ?? 0) - num(l.in, 0) / num(l.speed, 1) : -Infinity;
}

// ── duplicate / split ─────────────────────────────────────────────────

/** Ops that add `copy` right above the layer `aboveId`, tracking the stack in `order`. */
function insertAbove(order: string[], aboveId: string, copy: Record<string, unknown>): Op[] {
  const at = order.indexOf(aboveId) + 1;
  order.splice(at, 0, copy.id as string);
  return [
    { op: OpName.AddLayer, layer: copy },
    { op: OpName.Reorder, id: copy.id as string, index: at },
  ];
}

/** Stack order (back to front) of the targets, so inserted copies land in a predictable place. */
const inStackOrder = (scene: TimelineScene, ids: string[]) => scene.layers.filter((l) => ids.includes(l.id) && !isLocked(l));

/** ⌘D: a copy of each layer right above it (fresh id, same timing, keys and switches). Returns the new ids. */
export function duplicateLayer(ids?: string[]): string[] {
  const scene = readScene();
  const targets = inStackOrder(scene, ids ?? selectedLayerIds(scene));
  const taken = new Set(scene.layers.map((l) => l.id));
  const order = scene.layers.map((l) => l.id);
  const ops: Op[] = [];
  const created: string[] = [];
  for (const l of targets) {
    const id = freshId(l.id, taken);
    taken.add(id);
    created.push(id);
    ops.push(...insertAbove(order, l.id, { ...structuredClone(l), id }));
  }
  if (runOps(ops, `Duplicates ${targets.map((l) => l.id).join(", ")} as ${created.join(", ")}`)) selectLayers(created);
  return created;
}

/**
 * ⌘⇧D: cut each layer at the playhead. The original ends there; the part after it becomes a new
 * layer right above (fresh id) whose keyframes, bricks and video in-point are shifted so nothing
 * moves on screen. Layers the playhead isn't inside are skipped. Returns the new ids.
 */
export function splitLayerAtPlayhead(ids?: string[]): string[] {
  const scene = readScene();
  const t = playhead(fpsOf(scene));
  const targets = inStackOrder(scene, ids ?? selectedLayerIds(scene)).filter((l) => t > (l.start ?? 0) + 1e-6 && t < endOf(l, scene) - 1e-6);
  const taken = new Set(scene.layers.map((l) => l.id));
  const order = scene.layers.map((l) => l.id);
  const ops: Op[] = [];
  const created: string[] = [];
  for (const l of targets) {
    const start = l.start ?? 0;
    const id = freshId(l.id, taken);
    taken.add(id);
    created.push(id);
    ops.push({ op: OpName.SetTiming, id: l.id, start, end: t });
    ops.push(...insertAbove(order, l.id, { ...structuredClone(l), ...shiftLocalTime(l, t - start), id, start: t, end: l.end ?? null }));
  }
  if (runOps(ops, `Splits ${targets.map((l) => l.id).join(", ")} at ${t.toFixed(2)} s`)) selectLayers(created);
  return created;
}

// ── in / out points ───────────────────────────────────────────────────

/** Ops for each target layer from `edit(layer)`; null skips that layer. */
function timingEdit(ids: string[] | undefined, what: (t: number) => string, edit: (l: TimelineLayer, t: number, scene: TimelineScene) => Op[] | null) {
  const scene = readScene();
  const fps = fpsOf(scene);
  const t = playhead(fps);
  const ops = inStackOrder(scene, ids ?? selectedLayerIds(scene)).flatMap((l) => edit(l, t, scene) ?? []);
  return runOps(ops, what(t));
}

/** Alt+[: trim the in point to the playhead; the content stays where it is in time. */
export function trimInToPlayhead(ids?: string[]) {
  return timingEdit(
    ids,
    (t) => `Trims the in point to ${t.toFixed(2)} s`,
    (l, t, scene) => {
      const start = l.start ?? 0;
      const to = Math.max(earliestStart(l), t);
      if (to > endOf(l, scene) - MIN_LAYER || Math.abs(to - start) < 1e-6) return null;
      const fields = shiftLocalTime(l, to - start);
      return [
        { op: OpName.SetTiming, id: l.id, start: round(to), end: l.end ?? null },
        ...(Object.keys(fields).length ? [{ op: OpName.Patch, id: l.id, fields }] : []),
      ];
    },
  );
}

/** Alt+]: trim the out point so the frame under the playhead is the layer's last. */
export function trimOutToPlayhead(ids?: string[]) {
  return timingEdit(
    ids,
    (t) => `Trims the out point to ${t.toFixed(2)} s`,
    (l, t, scene) => {
      const start = l.start ?? 0;
      const end = round(t + 1 / fpsOf(scene));
      if (end < start + MIN_LAYER) return null;
      return [{ op: OpName.SetTiming, id: l.id, start, end }];
    },
  );
}

/** [: move the layer so it starts at the playhead (keys ride along). */
export function moveInToPlayhead(ids?: string[]) {
  return timingEdit(
    ids,
    (t) => `Moves the in point to ${t.toFixed(2)} s`,
    (l, t, scene) => {
      const start = l.start ?? 0;
      const d = t - start;
      if (Math.abs(d) < 1e-6) return null;
      // A layer that runs to the end of the video keeps doing so when it moves later.
      const end = l.end == null && d > 0 ? null : round(endOf(l, scene) + d);
      return [{ op: OpName.SetTiming, id: l.id, start: round(t), end }];
    },
  );
}

/** ]: move the layer so the frame under the playhead is its last. */
export function moveOutToPlayhead(ids?: string[]) {
  return timingEdit(
    ids,
    (t) => `Moves the out point to ${t.toFixed(2)} s`,
    (l, t, scene) => {
      const end = t + 1 / fpsOf(scene);
      const d = end - endOf(l, scene);
      if (Math.abs(d) < 1e-6) return null;
      return [{ op: OpName.SetTiming, id: l.id, start: round((l.start ?? 0) + d), end: round(end) }];
    },
  );
}
