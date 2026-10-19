import { OpName, type Op } from "@motionily/protocol";
import { engineHost } from "../engine/host";
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
 * Figma-like picking: the first click on a grouped layer selects its group; clicking again
 * inside the selected group drills into the layer.
 */
export function selectFromPick(id: string | null) {
  const { selectedGroup } = useEditor.getState();
  if (!id)
    return useEditor.setState({ selectedLayerId: null, selectedGroup: null });
  const group = groupOf(id);
  if (group && group !== selectedGroup)
    return useEditor.setState({ selectedGroup: group, selectedLayerId: null });
  useEditor.setState({ selectedLayerId: id, selectedGroup: null });
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
