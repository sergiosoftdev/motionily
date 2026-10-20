import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { OpName, type Op } from "@motionily/protocol";
import { sfxPlayer, type SfxCue } from "../../audio/sfxPlayer";
import { apply, commit, preview } from "../../editing/direct";
import { retimeGroupOps } from "../../editing/groups";
import { engineHost } from "../../engine/host";
import { agentBridge } from "../../bridge";
import { useEditor } from "../../store";
import { loadPeaks } from "../../timeline/waveform";
import { groupEntries, landingTime, type AudioTrack, type SceneLayerView, type SceneView } from "../sceneView";
import { keyTimes, moveKey, removeKey, rowsFor, setProp, type Anim, type Key, type PropDef } from "./keys";
import { PropRow } from "./PropRow";
import { AUDIO_LABEL, CAPTIONS_LABEL, GROUP_LABEL, labelColor, SFX_LABEL, typeIcon } from "./theme";
import { timecode } from "./timecode";

/** Width of the layer columns (eye, label, #, source name, mode, parent). */
const LEFT_W = 420;
const ROW_H = 24;
/** Ruler labels at least this far apart (px). */
const MIN_LABEL_GAP = 64;
const TICK_STEPS = [1 / 30, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
const MAX_ZOOM = 40;
/** Shortest a layer can be trimmed to, in seconds. */
const MIN_LAYER = 0.1;
const DRAG_THRESHOLD = 3;
const BLEND_MODES = ["normal", "add", "screen", "multiply"];

const LayerDrag = { Move: "move", TrimIn: "trim_in", TrimOut: "trim_out" } as const;
type LayerDrag = (typeof LayerDrag)[keyof typeof LayerDrag];

/** A keyframe picked in the timeline (Delete removes it). `t` is relative to the layer start. */
type PickedKey = { id: string; props: string[]; t: number };

/**
 * Pro mode's timeline, After Effects style: layer columns on the left (visibility, label, number,
 * source name, mode, parent), bars on the right; twirl a layer open for its Transform properties
 * and their keyframes. Voice, captions and sound effects sit on top.
 */
export function ProTimeline({ scene, audioUrl }: { scene: SceneView | null; audioUrl: string | null }) {
  const time = useEditor((s) => s.time);
  const duration = useEditor((s) => s.duration) || 1;
  const selected = useEditor((s) => s.selectedLayerId);
  const selectedGroup = useEditor((s) => s.selectedGroup);
  const fps = scene?.fps ?? 30;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [zoom, setZoom] = useState(1);
  const [viewW, setViewW] = useState(800);
  const [picked, setPicked] = useState<PickedKey | null>(null);
  const [peaks, setPeaks] = useState<{ peaks: Float32Array; duration: number } | null>(null);
  const [audioDraft, setAudioDraft] = useState<AudioTrack | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);

  const trackW = Math.max(100, viewW * zoom);
  const pps = trackW / duration;
  const px = (t: number) => t * pps;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(Math.max(100, el.clientWidth - LEFT_W - 16)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setPeaks(null);
    if (audioUrl) loadPeaks(audioUrl).then(setPeaks, () => setPeaks(null));
  }, [audioUrl]);

  // Ctrl/⌘ + wheel zooms around the pointer, keeping the second under it in place.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const x = e.clientX - el.getBoundingClientRect().left - LEFT_W + el.scrollLeft;
      const at = x / pps;
      setZoom((z) => {
        const next = Math.min(MAX_ZOOM, Math.max(1, z * Math.exp(-e.deltaY * 0.002)));
        requestAnimationFrame(() => (el.scrollLeft = (at / duration) * viewW * next - (x - el.scrollLeft)));
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pps, duration, viewW]);

  // Delete removes the picked keyframe (before the canvas selection would remove the layer).
  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return;
      if (e.key === "Escape") setPicked(null);
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const layer = scene?.layers.find((l) => l.id === picked.id);
      if (layer) apply(picked.props.map((p) => setProp(picked.id, p, removeKey(layer[p] as Anim, picked.t, fps))), `Removes a keyframe of ${picked.id}`);
      setPicked(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [picked, scene, fps]);

  const toTime = (clientX: number) => {
    const r = ruler.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - r.left) / pps));
  };
  const scrub = (e: ReactPointerEvent) => {
    engineHost.pause();
    engineHost.seek(toTime(e.clientX));
    const move = (ev: PointerEvent) => engineHost.seek(toTime(ev.clientX));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
  };

  /** Drag on the timeline: `onMove(dt)` while moving, `onDone(moved)` at the end. */
  const dragX = (e: ReactPointerEvent, onMove: (dt: number) => void, onDone: (moved: boolean) => void) => {
    e.stopPropagation();
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

  const select = (id: string | null, group: string | null, start: number, end: number) => {
    useEditor.setState({ selectedLayerId: id, selectedGroup: group });
    if (time < start || time >= end) engineHost.seek(landingTime(start, end));
  };
  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const ticks = useMemo(() => {
    const step = TICK_STEPS.find((s) => s * pps >= MIN_LABEL_GAP) ?? 60;
    return Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => +(i * step).toFixed(4));
  }, [pps, duration]);
  const tickLabel = (t: number) => (Number.isInteger(t) ? `${String(t).padStart(2, "0")}s` : `${Math.floor(t)}:${String(Math.round((t % 1) * fps)).padStart(2, "0")}f`);

  // ── rows ─────────────────────────────────────────────────────────────

  const row = (key: string, left: ReactNode, right: ReactNode, opts: { selected?: boolean; tall?: boolean } = {}) => (
    <div key={key} className="flex border-b border-[#151515]" style={{ height: opts.tall ? ROW_H + 8 : ROW_H }}>
      <div className={`sticky left-0 z-20 flex shrink-0 items-center gap-1 pr-2 ${opts.selected ? "bg-[#3e3e3e] text-white" : "bg-[#232323]"}`} style={{ width: LEFT_W }}>
        {left}
      </div>
      <div className="relative shrink-0" style={{ width: trackW }}>
        {right}
      </div>
    </div>
  );

  const eye = (visible: boolean, onClick: () => void) => (
    <button type="button" onClick={onClick} title={visible ? "Hide" : "Show"} className={`flex w-6 shrink-0 justify-center ${visible ? "text-[#c9c9c9]" : "text-[#555]"} hover:text-white`}>
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
        <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" />
        {visible ? <circle cx="8" cy="8" r="2" /> : <path d="m3 13 10-10" />}
      </svg>
    </button>
  );
  const swatch = (color: string) => <span className="mx-1 size-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />;
  const twirl = (key: string) => (
    <button type="button" onClick={() => toggle(key)} className="w-3.5 shrink-0 text-[9px] text-[#8a8a8a] hover:text-white" aria-label={open.has(key) ? "Collapse" : "Expand"}>
      {open.has(key) ? "▼" : "▶"}
    </button>
  );

  const bar = (start: number, end: number, color: string, isSel: boolean, onDown: (kind: LayerDrag) => (e: ReactPointerEvent) => void, onClick: () => void, title: string) => (
    <div
      onPointerDown={onDown(LayerDrag.Move)}
      onClick={onClick}
      title={title}
      className="absolute inset-y-[3px] cursor-grab rounded-[2px] active:cursor-grabbing"
      style={{ left: px(start), width: Math.max(2, px(end - start)), background: color, opacity: isSel ? 0.95 : 0.6, boxShadow: isSel ? "inset 0 0 0 1px rgba(255,255,255,.55)" : undefined }}
    >
      <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/40" onPointerDown={onDown(LayerDrag.TrimIn)} />
      <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-white/40" onPointerDown={onDown(LayerDrag.TrimOut)} />
    </div>
  );

  /** Move a layer in time or trim its in/out by hand; keyframes ride along with `start`. */
  const dragLayer = (id: string, start: number, end: number) => (kind: LayerDrag) => (e: ReactPointerEvent) => {
    let last: [number, number] = [start, end];
    dragX(
      e,
      (dt) => {
        if (kind === LayerDrag.Move) {
          const s = Math.min(Math.max(0, start + dt), duration - (end - start));
          last = [s, s + (end - start)];
        }
        if (kind === LayerDrag.TrimIn) last = [Math.min(Math.max(0, start + dt), end - MIN_LAYER), end];
        if (kind === LayerDrag.TrimOut) last = [start, Math.max(start + MIN_LAYER, Math.min(duration, end + dt))];
        preview([{ op: OpName.SetTiming, id, start: last[0], end: last[1] }]);
      },
      (moved) => moved && commit(`Timing of ${id}: ${last[0].toFixed(2)}–${last[1].toFixed(2)} s`),
    );
  };

  const dragGroup = (group: string) => (kind: LayerDrag) => (e: ReactPointerEvent) => {
    if (kind !== LayerDrag.Move) return e.stopPropagation();
    const base = (scene?.layers ?? []).map((l) => ({ ...l }));
    let dt = 0;
    dragX(
      e,
      (d) => {
        dt = d;
        preview(retimeGroupOps(group, dt, base, duration));
      },
      (moved) => moved && commit(`Moves group ${group} ${dt > 0 ? "+" : ""}${dt.toFixed(2)} s`),
    );
  };

  /** Keyframes of one property row; drag to retime, click to jump there (and pick it for Delete). */
  const keyTrack = (l: SceneLayerView, def: PropDef) => {
    const start = l.start ?? 0;
    const anims = def.props.map((p) => l[p] as Anim | undefined);
    return keyTimes(anims, fps).map((k: Key) => {
      const isPicked = picked?.id === l.id && picked.props[0] === def.props[0] && Math.abs(picked.t - k.t) < 0.5 / fps;
      const hold = k.ease === "hold";
      const eased = k.ease !== undefined && k.ease !== "linear" && !hold;
      return (
        <span
          key={k.t}
          title={`${def.label} · ${(start + k.t).toFixed(2)} s${k.ease ? ` · ${k.ease.replaceAll("_", " ")}` : ""}`}
          onPointerDown={(e) => {
            let to = k.t;
            dragX(
              e,
              (dt) => {
                to = Math.max(0, k.t + dt);
                preview(def.props.map((p, i) => setProp(l.id, p, moveKey(anims[i], k.t, to, fps))));
              },
              (moved) => {
                if (moved) {
                  commit(`Moves a ${def.label} key of ${l.id} to ${(start + to).toFixed(2)} s`);
                  setPicked({ id: l.id, props: def.props, t: Math.round(to * fps) / fps });
                } else {
                  setPicked({ id: l.id, props: def.props, t: k.t });
                  engineHost.pause();
                  engineHost.seek(start + k.t);
                }
              },
            );
          }}
          className="absolute top-1/2 z-10 flex size-3 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center"
          style={{ left: px(start + k.t) }}
        >
          {hold ? (
            <span className={`size-2 ${isPicked ? "bg-[#4aa3f0]" : "bg-[#b9b9b9]"}`} />
          ) : eased ? (
            <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
              <path d="M1 1h8L5 5l4 4H1l4-4Z" fill={isPicked ? "#4aa3f0" : "#b9b9b9"} />
            </svg>
          ) : (
            <span className={`size-2 rotate-45 ${isPicked ? "bg-[#4aa3f0]" : "bg-[#b9b9b9]"}`} />
          )}
        </span>
      );
    });
  };

  // AE lists the top layer first: the scene draws in array order, so the list is reversed.
  const layers = scene?.layers ?? [];
  const number = new Map([...layers].reverse().map((l, i) => [l.id, i + 1]));
  const q = filter.trim().toLowerCase();
  const matches = (l: SceneLayerView) => !q || l.id.toLowerCase().includes(q) || (l.group ?? "").toLowerCase().includes(q);

  const layerRows = (l: SceneLayerView, nested: boolean): ReactNode[] => {
    const start = l.start ?? 0;
    const end = l.end ?? duration;
    const isSel = l.id === selected;
    const visible = l.visible !== false;
    const fx = Array.isArray(l.effects) && l.effects.length > 0;
    const out = [
      row(
        l.id,
        <>
          {eye(visible, () => apply([{ op: OpName.Patch, id: l.id, fields: { visible: visible ? false : null } }], `${visible ? "Hides" : "Shows"} ${l.id}`))}
          {swatch(labelColor(l))}
          <span className="w-6 shrink-0 text-right text-[#8a8a8a] tabular-nums">{number.get(l.id)}</span>
          <span className={nested ? "w-4 shrink-0" : "w-1 shrink-0"} />
          {twirl(l.id)}
          <button type="button" onClick={() => select(l.id, null, start, end)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={l.type === "text" && l.text ? `“${l.text}”` : l.id}>
            <span className="w-3 shrink-0 text-center text-[#8a8a8a]">{typeIcon(l)}</span>
            <span className="truncate">{l.id}</span>
          </button>
          <span className={`w-5 shrink-0 text-center text-[10px] italic ${fx ? "text-[#c9c9c9]" : "text-transparent"}`}>fx</span>
          <select
            value={l.blend ?? "normal"}
            onChange={(e) => apply([{ op: OpName.Patch, id: l.id, fields: { blend: e.target.value === "normal" ? null : e.target.value } }], `Blend mode of ${l.id}: ${e.target.value}`)}
            className="w-[68px] shrink-0 rounded-sm bg-transparent px-0.5 text-[#c9c9c9] hover:bg-[#1b1b1b] focus:outline-none"
            aria-label="Mode"
          >
            {BLEND_MODES.map((m) => (
              <option key={m} value={m} className="bg-[#232323]">
                {m[0]!.toUpperCase() + m.slice(1)}
              </option>
            ))}
          </select>
          <span className="w-16 shrink-0 truncate text-[#8a8a8a]" title={l.parent ? `Parented to ${l.parent}` : "No parent"}>
            {l.parent ?? "None"}
          </span>
        </>,
        bar(start, end, labelColor(l), isSel, dragLayer(l.id, start, end), () => select(l.id, null, start, end), `${l.id} · ${start.toFixed(2)}–${end.toFixed(2)} s`),
        { selected: isSel },
      ),
    ];
    if (open.has(l.id)) {
      out.push(
        row(
          `${l.id}:transform`,
          <span className="flex items-center gap-1.5 text-[#c9c9c9]" style={{ paddingLeft: nested ? 92 : 76 }}>
            <span className="text-[9px] text-[#8a8a8a]">▼</span> Transform
          </span>,
          null,
        ),
      );
      for (const def of rowsFor(l))
        out.push(row(`${l.id}:${def.label}`, <PropRow id={l.id} layer={l} def={def} fps={fps} indent={nested ? 74 : 58} />, keyTrack(l, def)));
    }
    return out;
  };

  const entries = groupEntries(layers).reverse();
  const audio: AudioTrack | null = audioDraft ?? scene?.audio ?? (audioUrl ? { start: 0, trim_in: 0, trim_out: null } : null);
  const fileDuration = peaks?.duration ?? 0;
  const audioOut = audio ? (audio.trim_out ?? fileDuration) : 0;

  const dragAudio = (kind: LayerDrag) => (e: ReactPointerEvent) => {
    if (!audio) return;
    const base = { ...audio, trim_out: audio.trim_out ?? fileDuration };
    let last = base;
    dragX(
      e,
      (dt) => {
        if (kind === LayerDrag.Move) last = { ...base, start: Math.max(0, base.start + dt) };
        if (kind === LayerDrag.TrimIn) {
          const trimIn = Math.min(Math.max(0, base.trim_in + dt), base.trim_out - 0.2);
          last = { ...base, trim_in: trimIn, start: Math.max(0, base.start + (trimIn - base.trim_in)) };
        }
        if (kind === LayerDrag.TrimOut) last = { ...base, trim_out: Math.min(fileDuration, Math.max(base.trim_in + 0.2, base.trim_out + dt)) };
        setAudioDraft(last);
      },
      (moved) => {
        setAudioDraft(null);
        if (!moved) return;
        engineHost.applyOps([{ op: OpName.SetAudio, audio: last }]);
        agentBridge.sceneChanged();
      },
    );
  };

  /** Move a sound effect in time; a click without moving plays it. */
  const dragSfx = (cue: SfxCue) => (e: ReactPointerEvent) => {
    let at = cue.at;
    dragX(
      e,
      (dt) => {
        at = Math.min(duration, Math.max(0, cue.at + dt));
        preview([{ op: OpName.PutSfx, cue: { ...cue, at } }]);
      },
      (moved) => (moved ? commit(`Moves the effect ${cue.sound} to ${at.toFixed(2)} s`) : void sfxPlayer.preview(cue.src, cue.gain)),
    );
  };

  const words = scene?.captions?.words ?? [];
  const sfx = scene?.sfx ?? [];
  const sfxVolume = scene?.sfx_volume ?? 1;
  const audioLeft = (color: string, name: string, extra?: ReactNode) => (
    <>
      <span className="flex w-6 shrink-0 justify-center text-[#8a8a8a]">
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
          <path d="M2.5 6v4h3l3.5 3V3L5.5 6h-3ZM11 5.5a3.5 3.5 0 0 1 0 5" strokeLinejoin="round" />
        </svg>
      </span>
      {swatch(color)}
      <span className="w-6 shrink-0" />
      <span className="w-[18px] shrink-0" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {extra}
    </>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-4 border-b border-[#151515] px-3">
        <GoToTime time={time} fps={fps} duration={duration} />
        <span className="text-[11px] text-[#8a8a8a] tabular-nums">
          {Math.round(time * fps)} f · {fps} fps
        </span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search layers"
          className="w-44 rounded-sm bg-[#1b1b1b] px-2 py-1 text-[12px] placeholder:text-[#666] focus:ring-1 focus:ring-[#2d8ceb] focus:outline-none"
        />
        <span className="ml-auto text-[11px] text-[#8a8a8a]">{layers.length} layers</span>
      </div>

      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto text-[12px]">
        <div className="relative min-h-full" style={{ width: LEFT_W + trackW + 16 }}>
          <div className="sticky top-0 z-30 flex h-7 border-b border-[#151515] bg-[#232323]">
            <div className="sticky left-0 z-30 flex shrink-0 items-center gap-1 bg-[#232323] pr-2 text-[11px] text-[#8a8a8a]" style={{ width: LEFT_W }}>
              <span className="w-6 shrink-0 text-center">👁</span>
              <span className="w-[18px] shrink-0" />
              <span className="w-6 shrink-0 text-right">#</span>
              <span className="w-[18px] shrink-0" />
              <span className="flex-1">Source Name</span>
              <span className="w-5 shrink-0" />
              <span className="w-[68px] shrink-0">Mode</span>
              <span className="w-16 shrink-0">Parent</span>
            </div>
            <div ref={ruler} onPointerDown={scrub} className="relative shrink-0 cursor-ew-resize" style={{ width: trackW }}>
              {ticks.map((t) => (
                <span key={t} className="absolute top-0 h-full" style={{ left: px(t) }}>
                  <span className="absolute bottom-0 h-1.5 w-px bg-[#6a6a6a]" />
                  <span className="absolute top-1 left-1 text-[10px] whitespace-nowrap text-[#9a9a9a] tabular-nums">{tickLabel(t)}</span>
                </span>
              ))}
              <span className="absolute bottom-0 z-10 -translate-x-1/2" style={{ left: px(time) }}>
                <svg viewBox="0 0 12 14" className="h-3.5 w-3" aria-hidden>
                  <path d="M0 0h12v8l-6 6-6-6Z" fill="#2d8ceb" />
                </svg>
              </span>
            </div>
          </div>

          {row(
            "voice",
            audioLeft(AUDIO_LABEL, "Voice"),
            audio && audioUrl ? (
              <div
                onPointerDown={dragAudio(LayerDrag.Move)}
                className="absolute inset-y-[3px] flex cursor-grab overflow-hidden rounded-[2px] active:cursor-grabbing"
                style={{ left: px(audio.start), width: Math.max(4, px(audioOut - audio.trim_in)), background: `${AUDIO_LABEL}55` }}
              >
                {peaks && <Waveform peaks={peaks.peaks} from={audio.trim_in / peaks.duration} to={audioOut / peaks.duration} width={px(audioOut - audio.trim_in)} />}
                <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/40" onPointerDown={dragAudio(LayerDrag.TrimIn)} />
                <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-white/40" onPointerDown={dragAudio(LayerDrag.TrimOut)} />
              </div>
            ) : (
              <span className="absolute inset-y-0 left-2 flex items-center text-[#666]">No voice yet · upload one in Project › Voice</span>
            ),
            { tall: true },
          )}
          {words.length > 0 &&
            row(
              "captions",
              audioLeft(CAPTIONS_LABEL, "Captions"),
              words.map((w, i) => (
                <button
                  key={i}
                  type="button"
                  title={w.text}
                  onClick={() => engineHost.seek(w.start)}
                  className={`absolute inset-y-[3px] overflow-hidden rounded-[2px] px-1 text-left text-[11px] whitespace-nowrap text-[#111] ${w.emphasis ? "font-semibold" : ""}`}
                  style={{ left: px(w.start), width: Math.max(2, px(w.end - w.start) - 1), background: w.emphasis ? CAPTIONS_LABEL : `${CAPTIONS_LABEL}99` }}
                >
                  {w.text}
                </button>
              )),
            )}
          {sfx.length > 0 &&
            row(
              "sfx",
              audioLeft(
                SFX_LABEL,
                "Sound FX",
                <span className="flex shrink-0 items-center gap-1.5" title="Level of every sound effect">
                  <input
                    type="range"
                    min={0}
                    max={MAX_SFX_VOLUME}
                    step={VOLUME_STEP}
                    value={sfxVolume}
                    aria-label="Sound effects volume"
                    onChange={(e) => preview([{ op: OpName.SetSfxVolume, volume: Number(e.target.value) }])}
                    onPointerUp={() => commit(`Effects volume ${Math.round(sfxVolume * 100)}%`)}
                    className="w-20 accent-[#2d8ceb]"
                  />
                  <span className="w-9 text-right text-[#4aa3f0] tabular-nums">{Math.round(sfxVolume * 100)}%</span>
                </span>,
              ),
              sfx.map((c, i, all) => (
                <span
                  key={c.id}
                  title={`${c.sound} · ${c.at.toFixed(2)} s · ${Math.round((c.gain ?? 1) * 100)}% — drag to move, click to listen, scroll to change its volume`}
                  onPointerDown={dragSfx(c)}
                  onWheel={(e) => cueVolume(c, e.deltaY)}
                  className="group absolute inset-y-[3px] flex cursor-grab items-center gap-1 overflow-hidden rounded-[2px] pr-1 pl-1 text-[11px] whitespace-nowrap text-[#0c1a0c]"
                  style={{ left: px(c.at), maxWidth: all[i + 1] ? Math.max(6, px(all[i + 1]!.at - c.at) - 2) : 140, background: `${SFX_LABEL}cc` }}
                >
                  {c.sound} <span className="opacity-60">{Math.round((c.gain ?? 1) * 100)}%</span>
                  <button
                    type="button"
                    aria-label={`Remove ${c.sound}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => apply([{ op: OpName.RemoveSfx, id: c.id }], `Removes the effect ${c.sound}`)}
                    className="hidden group-hover:inline hover:text-white"
                  >
                    ×
                  </button>
                </span>
              )),
            )}

          {entries.flatMap((e) => {
            if (!e.group) return matches(e.layers[0]!) ? layerRows(e.layers[0]!, false) : [];
            const group = e.group;
            const shown = e.layers.filter(matches);
            if (!shown.length && !group.toLowerCase().includes(q)) return [];
            const start = Math.min(...e.layers.map((l) => l.start ?? 0));
            const end = Math.max(...e.layers.map((l) => l.end ?? duration));
            const visible = e.layers.some((l) => l.visible !== false);
            const isSel = selectedGroup === group;
            const groupOps = (fields: Record<string, unknown>): Op[] => [{ op: OpName.Patch, group, fields }];
            return [
              row(
                `g:${group}`,
                <>
                  {eye(visible, () => apply(groupOps({ visible: visible ? false : null }), `${visible ? "Hides" : "Shows"} group ${group}`))}
                  {swatch(GROUP_LABEL)}
                  <span className="w-6 shrink-0" />
                  <span className="w-1 shrink-0" />
                  {twirl(`g:${group}`)}
                  <button type="button" onClick={() => select(null, group, start, end)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    <span className="w-3 shrink-0 text-center text-[#8a8a8a]">▣</span>
                    <span className="truncate font-medium">{group}</span>
                    <span className="shrink-0 text-[#8a8a8a]">{e.layers.length}</span>
                  </button>
                </>,
                bar(start, end, GROUP_LABEL, isSel, dragGroup(group), () => select(null, group, start, end), `${group} · ${e.layers.length} layers · ${start.toFixed(2)}–${end.toFixed(2)} s`),
                { selected: isSel },
              ),
              ...(open.has(`g:${group}`) || q ? [...shown].reverse().flatMap((l) => layerRows(l, true)) : []),
            ];
          })}

          {/* Current-time indicator over every row. */}
          <span className="pointer-events-none absolute top-0 bottom-0 z-[15] w-px" style={{ left: LEFT_W + px(time), background: "#e5484d" }} />
        </div>
      </div>

      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-[#151515] px-3 text-[#8a8a8a]">
        <span className="text-[11px]">Drag a bar to retime it · twirl a layer for its keyframes · ⌘ + scroll to zoom</span>
        <span className="ml-auto flex items-center gap-1.5">
          <svg viewBox="0 0 16 10" className="h-2 w-3" fill="currentColor" aria-hidden>
            <path d="M0 10 5 3l3 4 2-2 6 5Z" />
          </svg>
          <input type="range" min={0} max={Math.log(MAX_ZOOM)} step={0.01} value={Math.log(zoom)} onChange={(e) => setZoom(Math.exp(Number(e.target.value)))} className="w-28 accent-[#2d8ceb]" aria-label="Zoom" />
          <svg viewBox="0 0 16 10" className="h-3 w-4" fill="currentColor" aria-hidden>
            <path d="M0 10 5 1l3 5 2-3 6 7Z" />
          </svg>
        </span>
      </div>
    </div>
  );
}

/** AE's blue timecode; click it to type a time (`5`, `5.4`, `0:05:12`). */
function GoToTime({ time, fps, duration }: { time: number; fps: number; duration: number }) {
  const [typing, setTyping] = useState<string | null>(null);
  const go = () => {
    const t = parseTime(typing ?? "", fps);
    setTyping(null);
    if (t !== null) {
      engineHost.pause();
      engineHost.seek(Math.min(duration, Math.max(0, t)));
    }
  };
  if (typing !== null)
    return (
      <input
        autoFocus
        value={typing}
        onChange={(e) => setTyping(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") go();
          if (e.key === "Escape") setTyping(null);
          e.stopPropagation();
        }}
        onBlur={go}
        className="w-32 rounded-sm bg-[#1b1b1b] px-1 text-lg text-[#4aa3f0] tabular-nums ring-1 ring-[#2d8ceb] focus:outline-none"
      />
    );
  return (
    <button type="button" onClick={() => setTyping(timecode(time, fps))} title="Go to time" className="text-lg text-[#4aa3f0] tabular-nums hover:underline">
      {timecode(time, fps)}
    </button>
  );
}

/** Seconds from `5`, `5.4` or a timecode `0:00:05:12` / `5:12` (seconds:frames). */
function parseTime(s: string, fps: number): number | null {
  const parts = s.trim().replace(",", ".").split(/[:;]/).map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 1) return parts[0]!;
  const frames = parts.pop()!;
  const [h = 0, m = 0, sec = 0] = parts.length === 3 ? parts : parts.length === 2 ? [0, ...parts] : [0, 0, ...parts];
  return h * 3600 + m * 60 + sec + frames / fps;
}

/** Steps of the effects volume controls. */
const VOLUME_STEP = 0.05;
const MAX_CUE_GAIN = 2;
const MAX_SFX_VOLUME = 1.5;
/** A burst of wheel ticks becomes one entry in the activity log. */
const WHEEL_COMMIT_MS = 400;
let wheelCommit: ReturnType<typeof setTimeout> | undefined;

/** Scroll over an effect to turn it down (or up). */
function cueVolume(cue: SfxCue, deltaY: number) {
  const gain = Math.min(MAX_CUE_GAIN, Math.max(0, +((cue.gain ?? 1) - Math.sign(deltaY) * VOLUME_STEP).toFixed(2)));
  preview([{ op: OpName.PutSfx, cue: { ...cue, gain } }]);
  clearTimeout(wheelCommit);
  wheelCommit = setTimeout(() => commit(`Effect ${cue.sound} volume ${Math.round(gain * 100)}%`), WHEEL_COMMIT_MS);
}

/** `width` only redraws it sharp when the timeline zooms. */
function Waveform({ peaks, from, to, width }: { peaks: Float32Array; from: number; to: number; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = c.clientHeight * devicePixelRatio);
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, w, h);
    g.fillStyle = "rgba(220,240,220,0.8)";
    const a = Math.floor(from * peaks.length);
    const b = Math.max(a + 1, Math.floor(to * peaks.length));
    for (let x = 0; x < w; x++) {
      const p = peaks[a + Math.floor(((b - a) * x) / w)] ?? 0;
      const bar = Math.max(1, p * h * 0.9);
      g.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [peaks, from, to, width]);
  return <canvas ref={ref} className="pointer-events-none h-full w-full" />;
}

