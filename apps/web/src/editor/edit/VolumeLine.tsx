import type { PointerEvent as ReactPointerEvent } from "react";
import type { Op } from "@motionily/protocol";
import type { EditActions } from "./useEditActions";
import { insertKey, levelAt, moveKey, removeKey, type VolumeKey } from "./volume";

const DRAG_THRESHOLD = 3;
/** Px kept free above 100% and below 0%. */
const PAD = 4;
/** Width (px) of the invisible band around the line that catches clicks. */
const HIT_PX = 10;

/**
 * Rubber band over a sound's block: its volume along the block (top = 100%). On a selected block,
 * click the line to add a key there (it keeps the level until dragged), drag a key to change its time
 * and level, double-click (or ⌥-click) a key to remove it. `keyZero` is the scene second of key time 0
 * (the clip's or the music's start), `from` the scene second at the block's left edge.
 */
export function VolumeLine({
  keys,
  level,
  keyZero,
  from,
  width,
  height,
  pps,
  fps,
  active,
  toOps,
  what,
  recaption,
  edits,
}: {
  keys: VolumeKey[] | null;
  level: number;
  keyZero: number;
  from: number;
  width: number;
  height: number;
  pps: number;
  fps: number;
  active: boolean;
  toOps: (volume: VolumeKey[] | number) => Op[];
  what: string;
  recaption: boolean;
  edits: EditActions;
}) {
  const span = height - PAD * 2;
  const y = (v: number) => PAD + (1 - v) * span;
  const x = (t: number) => (keyZero + t - from) * pps;
  const at = (px: number) => from + px / pps - keyZero;
  const valueAt = (t: number) => (keys?.length ? levelAt(keys, t) : level);
  const points: [number, number][] = [[0, valueAt(at(0))], ...(keys ?? []).map((k): [number, number] => [x(k.t), k.v]), [width, valueAt(at(width))]];
  points.sort((p, q) => p[0] - q[0]);
  const d = points.map(([px, v], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${y(v).toFixed(1)}`).join(" ");

  /** Drag key `i` of `base`; `begun` when the edit already started (a key just added). */
  const drag = (e: ReactPointerEvent, base: VolumeKey[], i: number, begun: boolean) => {
    const x0 = e.clientX;
    const y0 = e.clientY;
    const k0 = base[i]!;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD) return;
      if (!moved && !begun) edits.begin();
      moved = true;
      const t = Math.round((k0.t + (ev.clientX - x0) / pps) * fps) / fps;
      edits.preview(toOps(moveKey(base, i, t, k0.v - (ev.clientY - y0) / span)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved || begun) edits.end(what, recaption);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onLine = (e: ReactPointerEvent<SVGPathElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const t = Math.round(at(e.clientX - box.left) * fps) / fps;
    const added = insertKey(keys, level, t);
    edits.begin();
    edits.preview(toOps(added.keys));
    drag(e, added.keys, added.index, true);
  };
  const onKey = (e: ReactPointerEvent, i: number) => {
    e.stopPropagation();
    e.preventDefault();
    if (!keys) return;
    if (e.altKey) edits.apply(toOps(removeKey(keys, i)), what, recaption);
    else drag(e, keys, i, false);
  };

  return (
    <svg className="pointer-events-none absolute inset-0 overflow-hidden" width={width} height={height} data-volume-line>
      <path d={d} fill="none" stroke={active ? "#fde047" : "rgba(253,224,71,0.45)"} strokeWidth={active ? 1.5 : 1} />
      {active && <path d={d} fill="none" stroke="transparent" strokeWidth={HIT_PX} className="cursor-copy" style={{ pointerEvents: "stroke" }} onPointerDown={onLine} />}
      {active &&
        keys?.map((k, i) => (
          <circle
            key={i}
            cx={x(k.t)}
            cy={y(k.v)}
            r={4}
            fill="#fde047"
            stroke="#1c1917"
            strokeWidth={1.5}
            className="pointer-events-auto cursor-move"
            onPointerDown={(e) => onKey(e, i)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              edits.apply(toOps(removeKey(keys, i)), what, recaption);
            }}
          >
            <title>{`${Math.round(k.v * 100)}% at ${(keyZero + k.t).toFixed(2)} s — drag to move, double-click to remove`}</title>
          </circle>
        ))}
    </svg>
  );
}
