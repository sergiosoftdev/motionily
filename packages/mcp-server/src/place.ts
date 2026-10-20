/**
 * `place=` in numbers: a layer's x and y from the screen box of the layer it sits against. Layer x/y
 * are centers, so every rule places the center. The tools call this after each write and again when
 * the anchor moves; the engine draws the x and y it is given.
 */
import type { Layer, Op } from "./lint.js";

export type Box = [number, number, number, number];

/** Center of a layer that sits `side` of `anchor`, `gap` px away, aligned on the cross axis. */
export function placeCenter(place: { side: string; gap?: number; align?: string }, anchor: Box, size: [number, number]): [number, number] {
  const [ax0, ay0, ax1, ay1] = anchor;
  const [w, h] = size;
  const gap = place.gap ?? 0;
  const align = place.align ?? "center";
  const acx = (ax0 + ax1) / 2;
  const acy = (ay0 + ay1) / 2;
  // Cross-axis position for above/below (x) and left/right (y).
  const across = (lo: number, hi: number, len: number) => (align === "start" ? lo + len / 2 : align === "end" ? hi - len / 2 : (lo + hi) / 2);
  switch (place.side) {
    case "below":
      return [across(ax0, ax1, w), ay1 + gap + h / 2];
    case "above":
      return [across(ax0, ax1, w), ay0 - gap - h / 2];
    case "right":
      return [ax1 + gap + w / 2, across(ay0, ay1, h)];
    case "left":
      return [ax0 - gap - w / 2, across(ay0, ay1, h)];
    default:
      return [acx, acy];
  }
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Patches that move every placed layer to where its anchor is now (box at the layer's start time).
 * `boxAt(id, t)` is the layer's screen box, or null when it is not on screen at t.
 */
export function placementPatches(layers: Layer[], boxAt: (id: string, t: number) => Box | null, frame: [number, number]): { op: Op; id: string; x: number; y: number }[] {
  const patches: { op: Op; id: string; x: number; y: number }[] = [];
  for (const layer of layers) {
    const place = layer.place as { of?: string; side?: string; gap?: number; align?: string } | undefined;
    if (!place?.of || !place.side || layer.parent) continue;
    const spec = { side: place.side, gap: place.gap, align: place.align };
    const id = String(layer.id);
    const t = Number(layer.start ?? 0);
    const anchor = boxAt(place.of, t);
    if (!anchor) continue;
    const own = boxAt(id, t);
    const w = typeof layer.w === "number" ? layer.w : own ? own[2] - own[0] : null;
    const h = typeof layer.h === "number" ? layer.h : own ? own[3] - own[1] : null;
    if (w === null || h === null) continue;
    const [x, y] = placeCenter(spec, anchor, [w, h]);
    // Keep the layer on the frame edge it was placed against: no silent clipping.
    const fx = Math.min(Math.max(x, w / 2), frame[0] - w / 2);
    const fy = Math.min(Math.max(y, h / 2), frame[1] - h / 2);
    const nx = round(fx);
    const ny = round(fy);
    if (layer.x === nx && layer.y === ny) continue;
    patches.push({ id, x: nx, y: ny, op: { op: "patch", id, fields: { x: nx, y: ny } } });
  }
  return patches;
}
