import { memo, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { OpName } from "@motionily/protocol";
import { commit, preview } from "../../../editing/direct";
import { engineHost } from "../../../engine/host";
import { useEditor } from "../../../store";
import { runOps } from "../layerActions";
import { MARKER_COLORS, type Marker, type WorkArea } from "./contract";
import { useTimelineSelection } from "./selection";

/**
 * The time ruler: AE's work area bar on top, time ticks, composition markers and the playhead
 * head. Markers and the work area live in the scene (`set_markers`, `set_work_area`), so the
 * agent reads and writes the same ones.
 */

export const RULER_H = 38;
const WORK_H = 8;
/** Ruler labels at least this far apart (px). */
const MIN_LABEL_GAP = 64;
const TICK_STEPS = [1 / 30, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
const DRAG_THRESHOLD = 3;
/** Shortest work area, s. */
const MIN_WORK = 0.1;

const sorted = (m: Marker[]) => [...m].sort((a, b) => a.t - b.t);
const markersOp = (markers: Marker[]) => [{ op: OpName.SetMarkers, markers: sorted(markers) }];
const workOp = (work_area: WorkArea | null) => [{ op: OpName.SetWorkArea, work_area }];

/** M / numpad *: a marker at `t` (none twice on one frame). Returns its index. */
export function addMarker(markers: Marker[], t: number, fps: number): number | null {
  if (markers.some((m) => Math.abs(m.t - t) < 0.5 / fps)) return null;
  const next = sorted([...markers, { t, label: "" }]);
  return runOps(markersOp(next), `Adds a marker at ${t.toFixed(2)} s`) ? next.findIndex((m) => m.t === t) : null;
}

export function removeMarker(markers: Marker[], i: number) {
  const m = markers[i];
  if (m) runOps(markersOp(markers.filter((_, j) => j !== i)), `Removes the marker${m.label ? ` “${m.label}”` : ""} at ${m.t.toFixed(2)} s`);
}

/** B / N: one end of the work area at `t` (the other end stays, or the video's edge). */
export function setWorkAreaEnd(work: WorkArea | null | undefined, end: "in" | "out", t: number, duration: number) {
  const [a, b] = work ?? [0, duration];
  const next: WorkArea = end === "in" ? [t, t < b - MIN_WORK ? b : duration] : [t > a + MIN_WORK ? a : 0, t];
  if (next[1] - next[0] >= MIN_WORK) runOps(workOp(next), `Work area ${next[0].toFixed(2)}–${next[1].toFixed(2)} s`);
}

type Props = {
  duration: number;
  fps: number;
  pps: number;
  trackW: number;
  markers: Marker[];
  workArea: WorkArea | null;
  /** Click or drag on the ticks: scrub. */
  onScrub: (e: ReactPointerEvent) => void;
};

export const Ruler = memo(function Ruler({ duration, fps, pps, trackW, markers, workArea, onScrub }: Props) {
  const picked = useTimelineSelection((s) => s.marker);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  const px = (t: number) => t * pps;

  const ticks = useMemo(() => {
    const step = TICK_STEPS.find((s) => s * pps >= MIN_LABEL_GAP) ?? 60;
    return Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => +(i * step).toFixed(4));
  }, [pps, duration]);
  const tickLabel = (t: number) => (Number.isInteger(t) ? `${String(t).padStart(2, "0")}s` : `${Math.floor(t)}:${String(Math.round((t % 1) * fps)).padStart(2, "0")}f`);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  /** Drag in time: `onMove(dt)` while moving, `onDone(moved)` at the end. */
  const dragX = (e: ReactPointerEvent, onMove: (dt: number) => void, onDone: (moved: boolean) => void) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < DRAG_THRESHOLD) return;
      moved = true;
      onMove((ev.clientX - x0) / pps);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => (window.removeEventListener("pointermove", move), onDone(moved)), { once: true });
  };
  const frame = (t: number) => Math.min(duration, Math.max(0, Math.round(t * fps) / fps));

  const dragMarker = (i: number) => (e: ReactPointerEvent) => {
    const m = markers[i]!;
    useTimelineSelection.setState({ marker: i, keys: [] });
    let t = m.t;
    dragX(
      e,
      (dt) => {
        t = frame(m.t + dt);
        preview(markersOp(markers.map((x, j) => (j === i ? { ...x, t } : x))));
      },
      (moved) => {
        if (moved) {
          commit(`Moves the marker${m.label ? ` “${m.label}”` : ""} to ${t.toFixed(2)} s`);
          useTimelineSelection.setState({ marker: sorted(markers.map((x, j) => (j === i ? { ...x, t } : x))).findIndex((x) => x.t === t) });
        } else {
          engineHost.pause();
          engineHost.seek(m.t);
        }
      },
    );
  };

  const work = workArea ?? [0, duration];
  const dragWork = (part: "in" | "out" | "both") => (e: ReactPointerEvent) => {
    let next: WorkArea = work;
    dragX(
      e,
      (dt) => {
        const [a, b] = work;
        if (part === "in") next = [Math.min(frame(a + dt), b - MIN_WORK), b];
        else if (part === "out") next = [a, Math.max(frame(b + dt), a + MIN_WORK)];
        else {
          const d = Math.min(Math.max(dt, -a), duration - b);
          next = [frame(a + d), frame(b + d)];
        }
        preview(workOp(next));
      },
      (moved) => moved && commit(`Work area ${next[0].toFixed(2)}–${next[1].toFixed(2)} s`),
    );
  };

  const rename = (i: number, label: string) => {
    setRenaming(null);
    const m = markers[i];
    if (m && label !== m.label) runOps(markersOp(markers.map((x, j) => (j === i ? { ...x, label } : x))), `Renames the marker at ${m.t.toFixed(2)} s to “${label}”`);
  };
  const recolor = (i: number, color: string | null) => {
    const m = markers[i];
    if (!m) return;
    const { color: _old, ...rest } = m;
    runOps(markersOp(markers.map((x, j) => (j === i ? (color ? { ...rest, color } : rest) : x))), `Marker at ${m.t.toFixed(2)} s: ${color ?? "default color"}`);
  };

  return (
    <div className="relative shrink-0 select-none" style={{ width: trackW, height: RULER_H }}>
      {/* Work area bar. */}
      <div
        onPointerDown={dragWork("both")}
        onDoubleClick={() => workArea && runOps(workOp(null), "Work area: the whole video")}
        title={workArea ? `Work area ${workArea[0].toFixed(2)}–${workArea[1].toFixed(2)} s · drag the ends · double-click to reset` : "Work area: the whole video · drag an end (or press B / N) to set it"}
        data-work-area
        className={`absolute top-0 cursor-grab rounded-[2px] ${workArea ? "bg-[#6b7280]" : "bg-[#3a3a3a]"}`}
        style={{ left: px(work[0]), width: Math.max(4, px(work[1] - work[0])), height: WORK_H }}
      >
        <span data-work-in onPointerDown={dragWork("in")} className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-[2px] bg-[#9aa1ad] hover:bg-white" />
        <span data-work-out onPointerDown={dragWork("out")} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-[2px] bg-[#9aa1ad] hover:bg-white" />
      </div>
      {workArea && (
        <>
          <span className="pointer-events-none absolute bottom-0 left-0 bg-black/35" style={{ width: px(workArea[0]), top: WORK_H }} />
          <span className="pointer-events-none absolute right-0 bottom-0 bg-black/35" style={{ left: px(workArea[1]), top: WORK_H }} />
        </>
      )}

      {/* Ticks: click or drag to scrub. */}
      <div onPointerDown={onScrub} className="absolute inset-x-0 bottom-0 cursor-ew-resize" style={{ top: WORK_H }}>
        {ticks.map((t) => (
          <span key={t} className="absolute top-0 h-full" style={{ left: px(t) }}>
            <span className="absolute bottom-0 h-1.5 w-px bg-[#6a6a6a]" />
            <span className="absolute top-0.5 left-1 text-[10px] whitespace-nowrap text-[#9a9a9a] tabular-nums">{tickLabel(t)}</span>
          </span>
        ))}
      </div>

      {/* Composition markers. */}
      {markers.map((m, i) => (
        <span
          key={`${i}:${m.t}`}
          data-marker={i}
          onPointerDown={dragMarker(i)}
          onDoubleClick={(e) => (e.stopPropagation(), setRenaming(i))}
          onContextMenu={(e) => {
            e.preventDefault();
            useTimelineSelection.setState({ marker: i, keys: [] });
            setMenu({ i, x: e.clientX, y: e.clientY });
          }}
          title={`${m.label || "Marker"} · ${m.t.toFixed(2)} s — drag to move, double-click to rename, right-click for color`}
          className="absolute bottom-0 z-[5] flex cursor-pointer items-end"
          style={{ left: px(m.t) - 5 }}
        >
          <svg viewBox="0 0 10 12" className="h-3 w-2.5 shrink-0" aria-hidden>
            <path d="M0 0h10v7l-5 5-5-5Z" fill={m.color ?? MARKER_COLORS[0]} stroke={picked === i ? "#fff" : "none"} strokeWidth={1.4} />
          </svg>
          {renaming === i ? (
            <input
              autoFocus
              defaultValue={m.label}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") rename(i, e.currentTarget.value);
                if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={(e) => rename(i, e.currentTarget.value)}
              className="mb-0.5 ml-0.5 w-28 rounded-sm bg-[#1b1b1b] px-1 text-[10px] text-white ring-1 ring-[#2d8ceb] focus:outline-none"
            />
          ) : (
            m.label && <span className="mb-0.5 ml-0.5 max-w-32 truncate text-[10px] leading-none text-[#d6d6d6]">{m.label}</span>
          )}
        </span>
      ))}

      <RulerHead pps={pps} />

      {menu && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          className="fixed z-[100] flex min-w-36 flex-col rounded-[3px] bg-[#2b2b2b] py-1 text-[12px] text-[#d6d6d6] shadow-xl ring-1 ring-black/60"
          style={{ left: menu.x, top: menu.y }}
        >
          <button type="button" className="px-3 py-1 text-left hover:bg-[#2d8ceb] hover:text-white" onClick={() => (setRenaming(menu.i), setMenu(null))}>
            Rename…
          </button>
          <span className="flex gap-1 px-3 py-1.5">
            {MARKER_COLORS.map((c) => (
              <button key={c} type="button" aria-label={`Color ${c}`} onClick={() => (recolor(menu.i, c === MARKER_COLORS[0] ? null : c), setMenu(null))} className="size-3.5 rounded-[2px] ring-white hover:ring-1" style={{ background: c }} />
            ))}
          </span>
          <button type="button" className="px-3 py-1 text-left hover:bg-[#2d8ceb] hover:text-white" onClick={() => (removeMarker(markers, menu.i), useTimelineSelection.setState({ marker: null }), setMenu(null))}>
            Delete marker
          </button>
        </div>
      )}
    </div>
  );
});

/** The playhead's blue head (only this re-renders while playing). */
function RulerHead({ pps }: { pps: number }) {
  const time = useEditor((s) => s.time);
  return (
    <span className="pointer-events-none absolute bottom-0 z-10 -translate-x-1/2" style={{ left: time * pps }}>
      <svg viewBox="0 0 12 14" className="h-3.5 w-3" aria-hidden>
        <path d="M0 0h12v8l-6 6-6-6Z" fill="#2d8ceb" />
      </svg>
    </span>
  );
}

/** The red current-time line over every row. */
export function TimeIndicator({ left, pps }: { left: number; pps: number }) {
  const time = useEditor((s) => s.time);
  return <span className="pointer-events-none absolute top-0 bottom-0 z-[15] w-px" style={{ left: left + time * pps, background: "#e5484d" }} />;
}
