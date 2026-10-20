import { OpName, type Op } from "@motionily/protocol";
import { engineHost, type PickHit } from "../engine/host";
import { useEditor } from "../store";
import { moveOps, resizeOps, type Animated } from "./direct";

type SceneLayer = {
  id: string;
  group?: string;
  start?: number;
  end?: number | null;
};

function layers(): SceneLayer[] {
  return (
    (JSON.parse(engineHost.sceneJson()) as { layers?: SceneLayer[] }).layers ??
    []
  );
}

export function groupOf(id: string): string | undefined {
  return layers().find((l) => l.id === id)?.group;
}

export function groupLayerIds(group: string): string[] {
  return layers()
    .filter((l) => l.group === group)
    .map((l) => l.id);
}

/**
 * Figma-style selection from a click on the preview. `stack` is what is under the pointer,
 * front to back; full-frame backdrops and overlays only count where nothing else is.
 * - First click: the group of the front layer (the layer itself when it has none).
 * - Clicking inside the group you are in (it or one of its layers is selected): its layer under
 *   the pointer; clicking that layer again goes to the next one under it.
 * - ⌘/Ctrl-click (`deep`): the front layer, skipping its group.
 * - Nothing there: clear the selection.
 */
export function selectAt(stack: PickHit[], deep: boolean) {
  const content = stack.filter((h) => !h.cover);
  const hits = content.length ? content : stack;
  const front = hits[0];
  if (!front) return useEditor.setState({ selectedLayerId: null, selectedGroup: null });
  const all = layers();
  const groupOfHit = (id: string) => all.find((l) => l.id === id)?.group;
  const select = (id: string) => useEditor.setState({ selectedLayerId: id, selectedGroup: null });
  if (deep) return select(front.id);
  const { selectedGroup, selectedLayerId } = useEditor.getState();
  const inside = selectedGroup ?? (selectedLayerId ? groupOfHit(selectedLayerId) : undefined);
  // In a group, or clicking the selected layer again: walk down what is under the pointer there.
  const pool = inside ? hits.filter((h) => groupOfHit(h.id) === inside) : hits.some((h) => h.id === selectedLayerId) ? hits : [];
  if (pool.length) return select(pool[(pool.findIndex((h) => h.id === selectedLayerId) + 1) % pool.length]!.id);
  const group = groupOfHit(front.id);
  if (group) return useEditor.setState({ selectedGroup: group, selectedLayerId: null });
  select(front.id);
}

/** Box around several layers at the current time: [cx, cy, w, h]. */
export function unionBounds(
  ids: string[],
): [number, number, number, number] | null {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const id of ids) {
    const b = engineHost.layerBounds(id);
    if (!b) continue;
    const [cx = 0, cy = 0, w = 0, h = 0] = b;
    x0 = Math.min(x0, cx - w / 2);
    y0 = Math.min(y0, cy - h / 2);
    x1 = Math.max(x1, cx + w / 2);
    y1 = Math.max(y1, cy + h / 2);
  }
  return x0 === Infinity
    ? null
    : [(x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0];
}

type Base = { id: string; layer: Record<string, unknown>; bounds: number[] };

/** Snapshot of the layers before a drag, so every move is computed from the same start. */
export function snapshot(ids: string[]): Base[] {
  return ids.flatMap((id) => {
    const layer = engineHost.layer(id);
    const bounds = engineHost.layerBounds(id);
    return layer && bounds ? [{ id, layer, bounds }] : [];
  });
}

export function moveGroupOps(base: Base[], dx: number, dy: number): Op[] {
  return base.flatMap((b) => moveOps(b.id, b.layer, dx, dy));
}

/** Scale a group about its center: sizes scale and positions spread out from the center. */
export function resizeGroupOps(
  base: Base[],
  k: number,
  center: [number, number],
): Op[] {
  return base.flatMap((b) => {
    const [cx = 0, cy = 0, w = 1, h = 1] = b.bounds;
    return [
      ...resizeOps(b.id, b.layer, k, [w, h]),
      ...moveOps(
        b.id,
        b.layer,
        (cx - center[0]) * (k - 1),
        (cy - center[1]) * (k - 1),
      ),
    ];
  });
}

export function removeGroupOps(group: string): Op[] {
  return [{ op: OpName.RemoveGroup, group }];
}

/** Shift every layer of a group in time by dt (keyframes ride along). */
export function retimeGroupOps(
  group: string,
  dt: number,
  base: SceneLayer[],
  duration: number,
): Op[] {
  return base
    .filter((l) => l.group === group)
    .map((l) => {
      const start = Math.max(0, (l.start ?? 0) + dt);
      const end = l.end == null ? null : Math.min(duration, l.end + dt);
      return { op: OpName.SetTiming, id: l.id, start, end };
    });
}

export type { Animated, SceneLayer };
export { layers as sceneLayers };
