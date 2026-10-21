import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { OpName, type Op } from "@motionily/protocol";
import type { SfxCue } from "../../audio/sfxPlayer";
import { engineHost } from "../../engine/host";
import { useEditor } from "../../store";
import type { SceneView } from "../sceneView";
import { MIN_CLIP, moveBlockOps, moveClipOps, trimClipOps, type EditClip, type EditTracks, type GraphicsBlock } from "./tracks";
import type { EditActions } from "./useEditActions";

const HEADER_W = 104;
const RULER_H = 26;
const LANE_H = 44;
const SMALL_LANE_H = 28;
const MIN_LABEL_GAP = 70;
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
/** Edges snap to the playhead and to other clips within this many pixels. */
const SNAP_PX = 7;
const HANDLE_PX = 7;
const DRAG_THRESHOLD = 3;
const MAX_ZOOM = 30;
/** Words further apart than this start a new caption chip, and a chip holds at most this many words. */
const PHRASE_GAP = 0.35;
const PHRASE_WORDS = 6;

/** What the user has picked in the timeline. Clips and blocks follow the editor's selection (canvas or timeline). */
export type EditSelection = { kind: "clip"; clip: EditClip } | { kind: "block"; block: GraphicsBlock } | { kind: "cue"; cue: SfxCue } | null;

type Drag = { kind: "move" | "in" | "out"; x0: number; moved: boolean };

/**
 * CapCut-style multitrack timeline: graphics blocks on top, video lanes (the main track at the
 * bottom of them), captions, voice and sound effects. Drag to move, drag an edge to trim; the
 * parent decides what Delete and S do.
 */
export function EditTimeline({
  scene,
  tracks,
  selection,
  onSelectCue,
  edits,
}: {
  scene: SceneView;
  tracks: EditTracks;
  selection: EditSelection;
  onSelectCue: (cue: SfxCue | null) => void;
  edits: EditActions;
}) {
  const time = useEditor((s) => s.time);
  const duration = Math.max(scene.duration, 0.1);
  const [zoom, setZoom] = useState(1);
  const [viewW, setViewW] = useState(800);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth - HEADER_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const trackW = Math.max(200, viewW * zoom);
  const pps = trackW / duration;
  const px = (t: number) => t * pps;
  const step = TICK_STEPS.find((s) => s * pps >= MIN_LABEL_GAP) ?? TICK_STEPS.at(-1)!;
  const ticks = useMemo(() => Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step), [duration, step]);
  const phrases = useMemo(() => {
    const words = scene.captions?.words ?? [];
    const out: { start: number; end: number; text: string; words: number }[] = [];
    for (const w of words) {
      const last = out.at(-1);
      if (last && w.start - last.end < PHRASE_GAP && last.words < PHRASE_WORDS) {
        last.end = w.end;
        last.text += ` ${w.text}`;
        last.words += 1;
      } else out.push({ start: w.start, end: w.end, text: w.text, words: 1 });
    }
    return out;
  }, [scene.captions]);

  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - HEADER_W;
    return Math.max(0, Math.min(duration, x / pps));
  };
  const seekTo = (clientX: number) => engineHost.seek(timeAt(clientX));

  /** Scrub along the ruler (or an empty lane). */
  const scrub = (e: ReactPointerEvent) => {
    e.preventDefault();
    engineHost.pause();
    seekTo(e.clientX);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Snap a time to the playhead or a neighbour's edge when close enough. */
  const snap = (t: number, points: number[]) => {
    let best = t;
    let dist = SNAP_PX / pps;
    for (const p of points) {
      if (Math.abs(p - t) < dist) {
        dist = Math.abs(p - t);
        best = p;
      }
    }
    return best;
  };

  /** Drag helper: a click selects, a drag past the threshold edits live and commits on release. */
  const drag = (e: ReactPointerEvent, kind: Drag["kind"], onSelect: () => void, onDrag: (dt: number, clientX: number) => Op[], what: () => string, recaption: boolean) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    const d: Drag = { kind, x0: e.clientX, moved: false };
    const move = (ev: PointerEvent) => {
      if (!d.moved && Math.abs(ev.clientX - d.x0) < DRAG_THRESHOLD) return;
      if (!d.moved) edits.begin();
      d.moved = true;
      edits.preview(onDrag((ev.clientX - d.x0) / pps, ev.clientX));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (d.moved) edits.end(what(), recaption);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const clipPoints = (c: EditClip) => [0, time, ...tracks.clips.filter((x) => x.id !== c.id && x.lane === c.lane).flatMap((x) => [x.start, x.end])];
  const selectClip = (c: EditClip) => {
    onSelectCue(null);
    useEditor.setState({ selectedLayerId: c.id, selectedGroup: null });
  };
  const selectBlock = (b: GraphicsBlock) => {
    onSelectCue(null);
    useEditor.setState({ selectedLayerId: b.group ? null : b.ids[0]!, selectedGroup: b.group });
  };

  const lanes: { key: string; label: string; height: number; body: ReactNode }[] = [];
  for (let row = tracks.blockLanes - 1; row >= 0; row--) {
    lanes.push({
      key: `graphics-${row}`,
      label: row === 0 ? "Graphics" : "",
      height: LANE_H,
      body: tracks.blocks.filter((b) => b.lane === row).map((b) => {
        const on = selection?.kind === "block" && selection.block.key === b.key;
        return (
          <div
            key={b.key}
            title={`${b.label} · ${b.start.toFixed(1)}–${b.end.toFixed(1)} s · ${b.ids.length} layers`}
            onPointerDown={(e) =>
              drag(
                e,
                "move",
                () => selectBlock(b),
                (dt) => {
                  const start = snap(b.start + dt, [0, time, ...tracks.clips.map((c) => c.start)]);
                  return moveBlockOps(b, start - b.start, scene);
                },
                () => `Moves ${b.label}`,
                false,
              )
            }
            className={`absolute top-1.5 bottom-1.5 cursor-grab overflow-hidden rounded-md px-2 text-[11px] leading-[30px] whitespace-nowrap text-violet-50 active:cursor-grabbing ${on ? "bg-violet-500 ring-2 ring-white" : "bg-violet-600/80 hover:bg-violet-500/90"}`}
            style={{ left: px(b.start), width: Math.max(4, px(b.end - b.start)) }}
          >
            {b.label}
          </div>
        );
      }),
    });
  }
  // Overlay lanes above, the main track (lane 0) at the bottom, as in CapCut.
  for (let lane = tracks.lanes - 1; lane >= 0; lane--) {
    lanes.push({
      key: `video-${lane}`,
      label: lane === 0 ? "Video" : `Overlay ${lane}`,
      height: LANE_H,
      body: tracks.clips
        .filter((c) => c.lane === lane)
        .map((c) => {
          const on = selection?.kind === "clip" && selection.clip.id === c.id;
          const edge = (kind: "in" | "out") => (e: ReactPointerEvent) =>
            drag(
              e,
              kind,
              () => selectClip(c),
              (dt) => trimClipOps(c, kind, snap((kind === "in" ? c.start : c.end) + dt, clipPoints(c))),
              () => `Trims ${c.id}`,
              true,
            );
          return (
            <div
              key={c.id}
              title={`${c.name} · ${c.start.toFixed(2)}–${c.end.toFixed(2)} s · file ${c.in.toFixed(2)}–${(c.out ?? c.in + (c.end - c.start) * c.speed).toFixed(2)} s`}
              onPointerDown={(e) =>
                drag(
                  e,
                  "move",
                  () => selectClip(c),
                  (dt) => {
                    const pts = clipPoints(c);
                    let start = snap(c.start + dt, pts);
                    if (start === c.start + dt) start = snap(c.end + dt, pts) - (c.end - c.start);
                    return moveClipOps(c, start);
                  },
                  () => `Moves ${c.id}`,
                  true,
                )
              }
              className={`group absolute top-1.5 bottom-1.5 cursor-grab overflow-hidden rounded-md text-[11px] whitespace-nowrap text-sky-50 active:cursor-grabbing ${on ? "bg-sky-500 ring-2 ring-white" : "bg-sky-700/90 hover:bg-sky-600"}`}
              style={{ left: px(c.start), width: Math.max(4, px(c.end - c.start)) }}
            >
              <span className="pointer-events-none absolute inset-0 truncate px-2.5 leading-[30px]">
                {c.name}
                {c.scale > 1 ? ` · ${Math.round((c.scale - 1) * 100)}% zoom` : ""}
              </span>
              <span onPointerDown={edge("in")} className="absolute inset-y-0 left-0 cursor-ew-resize bg-white/0 group-hover:bg-white/25" style={{ width: HANDLE_PX }} />
              <span onPointerDown={edge("out")} className="absolute inset-y-0 right-0 cursor-ew-resize bg-white/0 group-hover:bg-white/25" style={{ width: HANDLE_PX }} />
            </div>
          );
        }),
    });
  }
  if (phrases.length)
    lanes.push({
      key: "captions",
      label: "Captions",
      height: SMALL_LANE_H,
      body: phrases.map((p, i) => (
        <div key={i} title={p.text} className="pointer-events-none absolute top-1 bottom-1 truncate rounded bg-neutral-700/70 px-1.5 text-[10px] leading-5 text-neutral-200" style={{ left: px(p.start), width: Math.max(2, px(p.end - p.start)) }}>
          {p.text}
        </div>
      )),
    });
  if (scene.audio) {
    const a = scene.audio;
    lanes.push({
      key: "voice",
      label: "Voice",
      height: SMALL_LANE_H,
      body: <div className="pointer-events-none absolute top-1 bottom-1 rounded bg-emerald-700/70 px-1.5 text-[10px] leading-5 text-emerald-50" style={{ left: px(a.start), right: 0 }}>Voice-over</div>,
    });
  }
  if (scene.sfx?.length)
    lanes.push({
      key: "sfx",
      label: "Effects",
      height: SMALL_LANE_H,
      body: scene.sfx.map((cue) => {
        const on = selection?.kind === "cue" && selection.cue.id === cue.id;
        return (
          <div
            key={cue.id}
            title={`${cue.sound} · ${cue.at.toFixed(2)} s`}
            onPointerDown={(e) =>
              drag(
                e,
                "move",
                () => {
                  useEditor.setState({ selectedLayerId: null, selectedGroup: null });
                  onSelectCue(cue);
                },
                (dt) => [{ op: OpName.PutSfx, cue: { ...cue, at: Math.max(0, Math.round(snap(cue.at + dt, [time]) * 1000) / 1000) } }],
                () => `Moves the ${cue.sound} effect`,
                false,
              )
            }
            className={`absolute top-1 bottom-1 cursor-grab truncate rounded px-1 text-[10px] leading-5 ${on ? "bg-amber-400 text-neutral-900" : "bg-amber-600/70 text-amber-50 hover:bg-amber-500"}`}
            style={{ left: px(cue.at), width: Math.max(36, MIN_CLIP * pps) }}
          >
            {cue.sound}
          </div>
        );
      }),
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onWheel={(e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          setZoom((z) => Math.min(MAX_ZOOM, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
        }}
        className="relative min-h-0 flex-1 overflow-auto"
      >
        <div className="relative" style={{ width: HEADER_W + trackW }}>
          {/* Ruler */}
          <div className="sticky top-0 z-20 flex bg-neutral-950" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-30 flex shrink-0 items-center gap-1 bg-neutral-950 px-2" style={{ width: HEADER_W }}>
              <button type="button" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} className="rounded px-1.5 text-neutral-400 hover:text-white" aria-label="Zoom out">
                −
              </button>
              <button type="button" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))} className="rounded px-1.5 text-neutral-400 hover:text-white" aria-label="Zoom in">
                +
              </button>
            </div>
            <div onPointerDown={scrub} className="relative flex-1 cursor-col-resize border-b border-neutral-800">
              {ticks.map((t) => (
                <span key={t} className={`absolute top-1 text-[10px] text-neutral-500 tabular-nums ${t > 0 ? "-translate-x-1/2" : "pl-1"}`} style={{ left: px(t) }}>
                  {t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}` : `${t}s`}
                </span>
              ))}
            </div>
          </div>
          {/* Lanes */}
          {lanes.map((l) => (
            <div key={l.key} className="flex" style={{ height: l.height }}>
              <div className="sticky left-0 z-10 flex shrink-0 items-center bg-neutral-950 px-3 text-[11px] text-neutral-500" style={{ width: HEADER_W }}>
                {l.label}
              </div>
              <div onPointerDown={(e) => (useEditor.setState({ selectedLayerId: null, selectedGroup: null }), onSelectCue(null), scrub(e))} className="relative flex-1 border-b border-neutral-900/80">
                {l.body}
              </div>
            </div>
          ))}
          {/* Playhead */}
          <div className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-red-400" style={{ left: HEADER_W + px(time) }}>
            <span className="absolute -top-0 -left-1.5 size-3 rotate-45 bg-red-400" />
          </div>
        </div>
      </div>
    </div>
  );
}
