import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { DEFAULT_SFX_VOLUME, OpName, type Op } from "@motionily/protocol";
import { sfxPlayer, type SfxCue } from "../../audio/sfxPlayer";
import { apply, commit, preview } from "../../editing/direct";
import { retimeGroupOps } from "../../editing/groups";
import { engineHost } from "../../engine/host";
import { agentBridge } from "../../bridge";
import { useEditor } from "../../store";
import { loadPeaks } from "../../timeline/waveform";
import { groupEntries, landingTime, type AudioTrack, type SceneView } from "../sceneView";
import { GraphEditor } from "./graph/GraphEditor";
import { GraphCommand, graphKeys } from "./graph/commands";
import { isExpr, isKeys, keyAt, keyTimes, rowsFor, TRANSFORM, type Anim, type PropDef } from "./keys";
import {
  duplicateLayer,
  MIN_LAYER,
  moveInToPlayhead,
  moveOutToPlayhead,
  runOps,
  selectAllLayers,
  selectLayers,
  shiftLocalTime,
  splitLayerAtPlayhead,
  trimInToPlayhead,
  trimOutToPlayhead,
} from "./layerActions";
import { PropRow } from "./PropRow";
import { ShortcutAction, useProShortcuts } from "./shortcuts";
import { AUDIO_LABEL, CAPTIONS_LABEL, GROUP_LABEL, labelColor, SFX_LABEL, typeIcon } from "./theme";
import { TimecodeField } from "../../time/TimecodeField";
import { AnchorRow, COL, LockIcon, MatteCell, ModeSelect, ParentCell, ShyIcon, SoloIcon, SwitchButton, toggleSwitch } from "./timeline/columns";
import { isLocked, isShy, isSolo, LayerSwitch, type TimelineLayer, type TimelineScene } from "./timeline/contract";
import { copyKeys, EaseSide, keyInterp, pasteKeys, type ClipKey } from "./timeline/keyEdit";
import { KeyCommand, KeyMenu, KeyTrack, runKeyCommand } from "./timeline/KeyTrack";
import { addMarker, removeMarker, Ruler, RULER_H, setWorkAreaEnd, TimeIndicator } from "./timeline/Ruler";
import { clearTimelinePicks, setKeySelection, useTimelineSelection, type KeyRef } from "./timeline/selection";
import { ShortcutsHelp } from "./timeline/ShortcutsHelp";
import { audioEnd } from "../../audio/track";

/** Width of the layer columns (A/V switches, label, #, source name, shy, fx, mode, track matte, parent). */
const LEFT_W = 680;
const ROW_H = 24;
const MAX_ZOOM = 40;
const DRAG_THRESHOLD = 3;
/** Two U presses this close make UU (modified properties). */
const DOUBLE_TAP_MS = 400;

const LayerDrag = { Move: "move", TrimIn: "trim_in", TrimOut: "trim_out" } as const;
type LayerDrag = (typeof LayerDrag)[keyof typeof LayerDrag];

/** The property rows P/S/R/T/A reveal (labels of the Transform rows). */
const Reveal = { Anchor: "Anchor Point", Position: "Position", Scale: "Scale", Rotation: "Rotation", Opacity: "Opacity" } as const;
/** Values the engine starts a layer with; anything else counts as modified (UU). */
const DEFAULTS: Record<string, number> = { scale: 1, opacity: 1 };

/** Keyframes copied with ⌘C (scene seconds), pasted with ⌘V onto the selected layer. */
let clipboard: ClipKey[] = [];

type Marquee = { x0: number; y0: number; x1: number; y1: number };
type Menu = { x: number; y: number; current: string | null };

/**
 * Pro mode's timeline, After Effects style: layer columns on the left (switches, label, number,
 * source name, mode, track matte, parent), bars and keyframes on the right, markers and the work
 * area on the ruler, the graph editor on ⇧F3. Every edit is an ordinary op; the AE shortcuts are
 * the table in shortcuts.ts. Voice, captions and sound effects sit on top.
 */
export function ProTimeline({ scene: view, audioUrl }: { scene: SceneView | null; audioUrl: string | null }) {
  const scene = view as TimelineScene | null;
  const duration = useEditor((s) => s.duration) || 1;
  const selected = useEditor((s) => s.selectedLayerId);
  const selectedGroup = useEditor((s) => s.selectedGroup);
  const sel = useTimelineSelection();
  const fps = scene?.fps ?? 30;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [reveal, setReveal] = useState<Record<string, string[]>>({});
  const [filter, setFilter] = useState("");
  const [hideShy, setHideShy] = useState(false);
  const [graph, setGraph] = useState(false);
  const [help, setHelp] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [zoom, setZoom] = useState(1);
  const [view2, setView2] = useState({ w: 800, h: 300, left: 0 });
  const [peaks, setPeaks] = useState<{ peaks: Float32Array; duration: number } | null>(null);
  const [audioDraft, setAudioDraft] = useState<AudioTrack | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const lastU = useRef(0);

  const viewW = view2.w;
  const trackW = Math.max(100, viewW * zoom);
  const pps = trackW / duration;
  const px = (t: number) => t * pps;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView2((v) => ({ ...v, w: Math.max(100, el.clientWidth - LEFT_W - 16), h: el.clientHeight })));
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

  const layers = useMemo(() => scene?.layers ?? [], [scene]);
  // AE lists the top layer first: the scene draws in array order, so numbers count from the end.
  const number = useMemo(() => new Map([...layers].reverse().map((l, i) => [l.id, i + 1])), [layers]);
  const selectedIds = useMemo(() => (selected && sel.layers.includes(selected) ? sel.layers : selected ? [selected] : []), [selected, sel.layers]);
  const anySolo = layers.some(isSolo);
  const now = () => useEditor.getState().time;
  const seekTo = (t: number) => (engineHost.pause(), engineHost.seek(Math.min(duration, Math.max(0, t))));

  const toTime = (clientX: number) => {
    const r = content.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - r.left - LEFT_W) / pps));
  };
  const scrub = (e: ReactPointerEvent) => {
    engineHost.pause();
    engineHost.scrub(toTime(e.clientX));
    const move = (ev: PointerEvent) => engineHost.scrub(toTime(ev.clientX));
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

  const selectGroup = (group: string, start: number, end: number) => {
    useEditor.setState({ selectedLayerId: null, selectedGroup: group });
    useTimelineSelection.setState({ layers: [], keys: [], marker: null });
    if (now() < start || now() >= end) engineHost.seek(landingTime(start, end));
  };
  /** Click a layer: select it (Shift/⌘ add or remove it); locked layers can't be selected. */
  const clickLayer = (e: ReactMouseEvent, l: TimelineLayer, start: number, end: number) => {
    if (isLocked(l)) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const ids = selectedIds.includes(l.id) ? selectedIds.filter((x) => x !== l.id) : [...selectedIds, l.id];
      return selectLayers(ids, ids.includes(l.id) ? l.id : ids[ids.length - 1]);
    }
    selectLayers([l.id], l.id);
    if (now() < start || now() >= end) engineHost.seek(landingTime(start, end));
  };
  const toggle = (key: string) => {
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
    setReveal(({ [key]: _gone, ...rest }) => rest);
  };

  // ── reveal (P S R T A U UU) ──────────────────────────────────────────

  const animatedLabels = (l: TimelineLayer) => TRANSFORM.filter((d) => d.props.some((p) => isKeys(l[p]) || isExpr(l[p]))).map((d) => d.label);
  const modifiedLabels = (l: TimelineLayer) => [
    ...(l.pivot && (l.pivot[0] || l.pivot[1]) ? [Reveal.Anchor] : []),
    ...TRANSFORM.filter((d) => d.props.some((p) => l[p] !== undefined && (typeof l[p] !== "number" || l[p] !== (DEFAULTS[p] ?? 0)))).map((d) => d.label),
  ];
  /** Show only `want(layer)` rows on the selected layers (all layers when none); `add` toggles them into what is shown. */
  const revealRows = (want: (l: TimelineLayer) => string[], add: boolean) => {
    const targets = selectedIds.length ? layers.filter((l) => selectedIds.includes(l.id)) : layers;
    const next = { ...reveal };
    const nextOpen = new Set(open);
    for (const l of targets) {
      const w = want(l);
      const cur = open.has(l.id) ? (reveal[l.id] ?? []) : [];
      let shown: string[];
      if (add) {
        const s = new Set(cur);
        for (const x of w) if (s.has(x)) s.delete(x);
        else s.add(x);
        shown = [...s];
      } else shown = cur.length === w.length && w.every((x) => cur.includes(x)) ? [] : w;
      next[l.id] = shown;
      if (shown.length) {
        nextOpen.add(l.id);
        if (l.group) nextOpen.add(`g:${l.group}`);
      } else nextOpen.delete(l.id);
    }
    setReveal(next);
    setOpen(nextOpen);
  };
  const reveal1 = (label: string) => (e: KeyboardEvent) => revealRows(() => [label], e.shiftKey);

  // ── keys ─────────────────────────────────────────────────────────────

  const keysCmd = (cmd: Parameters<typeof runKeyCommand>[3]) => !!scene && runKeyCommand(scene, useTimelineSelection.getState().keys, fps, cmd);
  const menuRef = useRef<(e: ReactMouseEvent, ref: KeyRef) => void>(() => {});
  menuRef.current = (e, ref) => {
    e.preventDefault();
    const picked = useTimelineSelection.getState().keys;
    if (!picked.some((k) => k.id === ref.id && k.props[0] === ref.props[0] && Math.abs(k.t - ref.t) < 0.5 / fps)) setKeySelection([ref]);
    const l = layers.find((x) => x.id === ref.id);
    const k = l && ref.props.map((p) => keyAt(l[p] as Anim, ref.t, fps)).find(Boolean);
    setMenu({ x: e.clientX, y: e.clientY, current: k ? keyInterp(k) : null });
  };
  const onKeyMenu = useCallback((e: ReactMouseEvent, ref: KeyRef) => menuRef.current(e, ref), []);

  /** Keyframes, markers and work area ends J/K step through (keys of the selected layers, or all). */
  const stops = () => {
    const ts: number[] = [...(scene?.markers ?? []).map((m) => m.t), ...(scene?.work_area ?? [])];
    for (const l of selectedIds.length ? layers.filter((x) => selectedIds.includes(x.id)) : layers)
      for (const k of keyTimes(TRANSFORM.flatMap((d) => d.props.map((p) => l[p] as Anim)), fps)) ts.push((l.start ?? 0) + k.t);
    return ts.sort((a, b) => a - b);
  };
  const primary = () => (selected ? layers.find((l) => l.id === selected) : undefined);

  useProShortcuts({
    [ShortcutAction.RevealPosition]: reveal1(Reveal.Position),
    [ShortcutAction.RevealScale]: reveal1(Reveal.Scale),
    [ShortcutAction.RevealRotation]: reveal1(Reveal.Rotation),
    [ShortcutAction.RevealOpacity]: reveal1(Reveal.Opacity),
    [ShortcutAction.RevealAnchor]: reveal1(Reveal.Anchor),
    [ShortcutAction.RevealAnimated]: () => {
      const double = performance.now() - lastU.current < DOUBLE_TAP_MS;
      lastU.current = double ? 0 : performance.now();
      revealRows(double ? modifiedLabels : animatedLabels, false);
    },
    [ShortcutAction.PrevItem]: () => {
      const t = [...stops()].reverse().find((x) => x < now() - 0.5 / fps);
      if (t !== undefined) seekTo(t);
    },
    [ShortcutAction.NextItem]: () => {
      const t = stops().find((x) => x > now() + 0.5 / fps);
      if (t !== undefined) seekTo(t);
    },
    [ShortcutAction.GoToIn]: () => {
      const l = primary();
      if (!l) return false;
      seekTo(l.start ?? 0);
    },
    [ShortcutAction.GoToOut]: () => {
      const l = primary();
      if (!l) return false;
      seekTo((l.end ?? duration) - 1 / fps);
    },
    [ShortcutAction.MoveIn]: () => void moveInToPlayhead(),
    [ShortcutAction.MoveOut]: () => void moveOutToPlayhead(),
    [ShortcutAction.TrimIn]: () => void trimInToPlayhead(),
    [ShortcutAction.TrimOut]: () => void trimOutToPlayhead(),
    [ShortcutAction.Duplicate]: () => void duplicateLayer(),
    [ShortcutAction.Split]: () => void splitLayerAtPlayhead(),
    [ShortcutAction.SelectAll]: () => selectAllLayers(),
    [ShortcutAction.WorkAreaIn]: () => setWorkAreaEnd(scene?.work_area, "in", Math.round(now() * fps) / fps, duration),
    [ShortcutAction.WorkAreaOut]: () => setWorkAreaEnd(scene?.work_area, "out", Math.round(now() * fps) / fps, duration),
    [ShortcutAction.AddMarker]: () => {
      const i = addMarker(scene?.markers ?? [], Math.round(now() * fps) / fps, fps);
      if (i !== null) useTimelineSelection.setState({ marker: i, keys: [] });
    },
    [ShortcutAction.CopyKeys]: () => {
      const picked = useTimelineSelection.getState().keys;
      if (!scene || !picked.length) return false;
      clipboard = copyKeys(scene, picked, fps);
    },
    [ShortcutAction.PasteKeys]: () => {
      const l = primary();
      if (!scene || !l || isLocked(l) || !clipboard.length) return false;
      runOps(pasteKeys(scene, clipboard, l.id, now(), fps), `Pastes ${clipboard.length} key${clipboard.length > 1 ? "s" : ""} on ${l.id} at ${now().toFixed(2)} s`);
    },
    // Keys selected in the open graph editor take these first (it answers true when it handled them).
    [ShortcutAction.EasyEase]: () => (graphKeys.run?.(GraphCommand.EasyEase) ? undefined : keysCmd({ kind: KeyCommand.Ease, side: EaseSide.Both })),
    [ShortcutAction.EasyEaseIn]: () => (graphKeys.run?.(GraphCommand.EaseIn) ? undefined : keysCmd({ kind: KeyCommand.Ease, side: EaseSide.In })),
    [ShortcutAction.EasyEaseOut]: () => (graphKeys.run?.(GraphCommand.EaseOut) ? undefined : keysCmd({ kind: KeyCommand.Ease, side: EaseSide.Out })),
    [ShortcutAction.Delete]: () => {
      if (graphKeys.run?.(GraphCommand.Delete)) return;
      const { keys, marker } = useTimelineSelection.getState();
      if (keys.length) return keysCmd({ kind: KeyCommand.Delete });
      if (marker !== null && scene?.markers?.[marker]) {
        removeMarker(scene.markers, marker);
        useTimelineSelection.setState({ marker: null });
        return;
      }
      // A locked layer refuses to be deleted; anything else falls through to the canvas selection.
      return isLocked(primary());
    },
    [ShortcutAction.Deselect]: () => {
      clearTimelinePicks();
      setMenu(null);
      return false;
    },
    [ShortcutAction.GraphEditor]: () => setGraph((g) => !g),
    [ShortcutAction.Help]: () => setHelp((h) => !h),
  });

  // ── marquee over the keyframe area ──────────────────────────────────

  const startMarquee = (e: ReactPointerEvent) => {
    if (e.button !== 0 || !(e.target as HTMLElement).closest("[data-track]")) return;
    const r = content.current!.getBoundingClientRect();
    const x0 = e.clientX - r.left;
    const y0 = e.clientY - r.top;
    let box: Marquee | null = null;
    const move = (ev: PointerEvent) => {
      if (!box && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < DRAG_THRESHOLD) return;
      box = { x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top };
      setMarquee(box);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      setMarquee(null);
      if (!box) return clearTimelinePicks();
      const [left, right] = [Math.min(box.x0, box.x1) + r.left, Math.max(box.x0, box.x1) + r.left];
      const [top, bottom] = [Math.min(box.y0, box.y1) + r.top, Math.max(box.y0, box.y1) + r.top];
      const hits: KeyRef[] = [];
      content.current!.querySelectorAll<HTMLElement>("[data-key-t]").forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.right < left || b.left > right || b.bottom < top || b.top > bottom) return;
        const l = layers.find((x) => x.id === el.dataset.keyId);
        if (l && !isLocked(l)) hits.push({ id: el.dataset.keyId!, props: el.dataset.keyProps!.split(","), t: Number(el.dataset.keyT) });
      });
      setKeySelection(e.shiftKey ? [...useTimelineSelection.getState().keys, ...hits] : hits);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  // ── rows ─────────────────────────────────────────────────────────────

  const row = (key: string, left: ReactNode, right: ReactNode, opts: { selected?: boolean; tall?: boolean; layer?: string; track?: boolean } = {}) => (
    <div key={key} data-layer-row={opts.layer} className="flex border-b border-[#151515]" style={{ height: opts.tall ? ROW_H + 8 : ROW_H }}>
      <div className={`sticky left-0 z-20 flex shrink-0 items-center gap-1 pr-2 ${opts.selected ? "bg-[#3e3e3e] text-white" : "bg-[#232323]"}`} style={{ width: LEFT_W }}>
        {left}
      </div>
      <div data-track={opts.track ? "" : undefined} className="relative shrink-0" style={{ width: trackW }}>
        {!graph && right}
      </div>
    </div>
  );

  const eye = (visible: boolean, onClick: () => void, dim = false) => (
    <button
      type="button"
      onClick={onClick}
      title={visible ? "Hide" : "Show"}
      className={`flex shrink-0 justify-center ${visible ? (dim ? "text-[#555]" : "text-[#c9c9c9]") : "text-[#3a3a3a]"} hover:text-white`}
      style={{ width: COL.eye }}
    >
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

  const bar = (start: number, end: number, color: string, isSel: boolean, onDown: ((kind: LayerDrag) => (e: ReactPointerEvent) => void) | null, onClick: () => void, title: string) => (
    <div
      onPointerDown={onDown?.(LayerDrag.Move)}
      onClick={onClick}
      title={title}
      className={`absolute inset-y-[3px] rounded-[2px] ${onDown ? "cursor-grab active:cursor-grabbing" : "cursor-not-allowed"}`}
      style={{ left: px(start), width: Math.max(2, px(end - start)), background: color, opacity: isSel ? 0.95 : 0.6, boxShadow: isSel ? "inset 0 0 0 1px rgba(255,255,255,.55)" : undefined }}
    >
      {onDown && (
        <>
          <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/40" onPointerDown={onDown(LayerDrag.TrimIn)} />
          <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-white/40" onPointerDown={onDown(LayerDrag.TrimOut)} />
        </>
      )}
    </div>
  );

  /** Move a layer in time (keys ride along) or trim its in/out by hand (keys stay put in time, as in AE). */
  const dragLayer = (l: TimelineLayer, start: number, end: number) => (kind: LayerDrag) => (e: ReactPointerEvent) => {
    const id = l.id;
    let last: [number, number] = [start, end];
    dragX(
      e,
      (dt) => {
        if (kind === LayerDrag.Move) {
          const s = Math.min(Math.max(0, start + dt), duration - (end - start));
          last = [s, s + (end - start)];
          return preview([{ op: OpName.SetTiming, id, start: last[0], end: last[1] }]);
        }
        if (kind === LayerDrag.TrimOut) {
          last = [start, Math.max(start + MIN_LAYER, Math.min(duration, end + dt))];
          return preview([{ op: OpName.SetTiming, id, start, end: last[1] }]);
        }
        const s = Math.round(Math.min(Math.max(0, start + dt), end - MIN_LAYER) * fps) / fps;
        last = [s, end];
        const fields = shiftLocalTime(l, s - start);
        preview([{ op: OpName.SetTiming, id, start: s, end: l.end ?? null }, ...(Object.keys(fields).length ? [{ op: OpName.Patch, id, fields }] : [])]);
      },
      (moved) => moved && commit(`Timing of ${id}: ${last[0].toFixed(2)}–${last[1].toFixed(2)} s`),
    );
  };

  const dragGroup = (group: string) => (kind: LayerDrag) => (e: ReactPointerEvent) => {
    if (kind !== LayerDrag.Move) return e.stopPropagation();
    const base = layers.map((l) => ({ ...l }));
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

  const q = filter.trim().toLowerCase();
  const matches = (l: TimelineLayer) => (!hideShy || !isShy(l)) && (!q || l.id.toLowerCase().includes(q) || (l.group ?? "").toLowerCase().includes(q));
  const pickedOn = (id: string, prop: string) =>
    sel.keys
      .filter((k) => k.id === id && k.props[0] === prop)
      .map((k) => k.t)
      .join(",");

  const layerRows = (l: TimelineLayer, nested: boolean): ReactNode[] => {
    const start = l.start ?? 0;
    const end = l.end ?? duration;
    const isSel = selectedIds.includes(l.id);
    const visible = l.visible !== false;
    const locked = isLocked(l);
    const fx = Array.isArray(l.effects) && l.effects.length > 0;
    const indent = nested ? 118 : 102;
    const out = [
      row(
        l.id,
        <>
          {eye(visible, () => apply([{ op: OpName.Patch, id: l.id, fields: { visible: visible ? false : null } }], `${visible ? "Hides" : "Shows"} ${l.id}`), anySolo && !isSolo(l))}
          <SwitchButton on={isSolo(l)} title={isSolo(l) ? "Unsolo" : "Solo: only solo layers draw"} onClick={() => toggleSwitch(l, LayerSwitch.Solo)}>
            <SoloIcon on={isSolo(l)} />
          </SwitchButton>
          <SwitchButton on={locked} title={locked ? "Unlock" : "Lock: can't be selected or edited"} onClick={() => toggleSwitch(l, LayerSwitch.Locked)}>
            <LockIcon on={locked} />
          </SwitchButton>
          {swatch(labelColor(l))}
          <span className="w-6 shrink-0 text-right text-[#8a8a8a] tabular-nums">{number.get(l.id)}</span>
          <span className={nested ? "w-4 shrink-0" : "w-1 shrink-0"} />
          {twirl(l.id)}
          <button
            type="button"
            onClick={(e) => clickLayer(e, l, start, end)}
            className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${locked ? "cursor-not-allowed text-[#777]" : ""}`}
            title={locked ? `${l.id} is locked` : l.type === "text" && l.text ? `“${l.text}”` : l.id}
          >
            <span className="w-3 shrink-0 text-center text-[#8a8a8a]">{typeIcon(l)}</span>
            <span className="truncate">{l.id}</span>
          </button>
          <SwitchButton on={isShy(l)} title={isShy(l) ? "Shy (hidden while the shy filter is on)" : "Make shy"} onClick={() => toggleSwitch(l, LayerSwitch.Shy)}>
            <ShyIcon on={isShy(l)} />
          </SwitchButton>
          <span className={`w-5 shrink-0 text-center text-[10px] italic ${fx ? "text-[#c9c9c9]" : "text-transparent"}`}>fx</span>
          <ModeSelect layer={l} />
          {scene && <MatteCell scene={scene} layer={l} numbers={number} />}
          {scene && <ParentCell scene={scene} layer={l} numbers={number} />}
        </>,
        bar(start, end, labelColor(l), isSel, locked ? null : dragLayer(l, start, end), () => clickLayer({ shiftKey: false, metaKey: false, ctrlKey: false } as ReactMouseEvent, l, start, end), `${l.id} · ${start.toFixed(2)}–${end.toFixed(2)} s${locked ? " · locked" : ""}`),
        { selected: isSel, layer: l.id },
      ),
    ];
    if (!open.has(l.id)) return out;
    const shown = reveal[l.id];
    const defs: PropDef[] = shown?.length ? TRANSFORM.filter((d) => shown.includes(d.label)) : rowsFor(l);
    if (!shown?.length)
      out.push(
        row(
          `${l.id}:transform`,
          <span className="flex items-center gap-1.5 text-[#c9c9c9]" style={{ paddingLeft: indent + 18 }}>
            <span className="text-[9px] text-[#8a8a8a]">▼</span> Transform
          </span>,
          null,
          { layer: l.id },
        ),
      );
    const lockCls = locked ? "pointer-events-none w-full opacity-50" : "w-full";
    if (!shown?.length || shown.includes(Reveal.Anchor))
      out.push(
        row(
          `${l.id}:anchor`,
          <div className={lockCls}>
            <AnchorRow layer={l} indent={indent} />
          </div>,
          null,
          { layer: l.id },
        ),
      );
    for (const def of defs)
      out.push(
        row(
          `${l.id}:${def.label}`,
          <div className={lockCls}>
            <PropRow id={l.id} layer={l} def={def} fps={fps} indent={indent} />
          </div>,
          scene && <KeyTrack scene={scene} layer={l} def={def} fps={fps} pps={pps} picked={pickedOn(l.id, def.props[0]!)} locked={locked} onMenu={onKeyMenu} />,
          { layer: l.id, track: true },
        ),
      );
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
      (moved) => (moved ? commit(`Moves the effect ${cue.sound} to ${at.toFixed(2)} s`) : void sfxPlayer.preview(cue)),
    );
  };

  const words = scene?.captions?.words ?? [];
  const sfx = scene?.sfx ?? [];
  const sfxVolume = scene?.sfx_volume ?? DEFAULT_SFX_VOLUME;
  const audioLeft = (color: string, name: string, extra?: ReactNode) => (
    <>
      <span className="flex shrink-0 justify-center text-[#8a8a8a]" style={{ width: COL.eye }}>
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
          <path d="M2.5 6v4h3l3.5 3V3L5.5 6h-3ZM11 5.5a3.5 3.5 0 0 1 0 5" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="shrink-0" style={{ width: COL.sw * 2 + 4 }} />
      {swatch(color)}
      <span className="w-6 shrink-0" />
      <span className="w-[18px] shrink-0" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {extra}
    </>
  );

  // Graph editor: the selected layer, with its picked keys' props (or the revealed / animated ones).
  const graphLayer = selected ? layers.find((l) => l.id === selected && !isLocked(l)) : undefined;
  const graphProps = graphLayer
    ? (() => {
        const picked = [...new Set(sel.keys.filter((k) => k.id === graphLayer.id).flatMap((k) => k.props))];
        if (picked.length) return picked;
        const shown = reveal[graphLayer.id];
        return TRANSFORM.filter((d) => !shown?.length || shown.includes(d.label))
          .flatMap((d) => d.props)
          .filter((p) => isKeys(graphLayer[p]));
      })()
    : [];

  const headerBtn = (on: boolean) => `flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] ${on ? "bg-[#2d8ceb]/25 text-[#4aa3f0]" : "text-[#8a8a8a] hover:bg-[#1b1b1b] hover:text-[#c9c9c9]"}`;

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-4 border-b border-[#151515] px-3">
        <TimecodeField fps={fps} duration={duration} listens className="text-lg text-[#4aa3f0]" inputClassName="bg-[#1b1b1b] text-lg text-[#4aa3f0] ring-1 ring-[#2d8ceb]" />
        <FrameCount fps={fps} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search layers"
          className="w-44 rounded-sm bg-[#1b1b1b] px-2 py-1 text-[12px] placeholder:text-[#666] focus:ring-1 focus:ring-[#2d8ceb] focus:outline-none"
        />
        <span className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => setHideShy((h) => !h)} className={headerBtn(hideShy)} title={hideShy ? "Show shy layers" : "Hide shy layers"} aria-pressed={hideShy}>
            <ShyIcon on={hideShy} /> Shy
          </button>
          <button type="button" onClick={() => setGraph((g) => !g)} className={headerBtn(graph)} title="Graph Editor (⇧F3)" aria-pressed={graph}>
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
              <path d="M1.5 14.5h13M1.5 14.5v-13M2.5 12c3 0 3.5-8 6-8s3 4 6 4" />
            </svg>
            Graph
          </button>
          <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setHelp((h) => !h)} className={headerBtn(help)} title="Keyboard shortcuts (?)" aria-pressed={help}>
            ?
          </button>
          <span className="pl-2 text-[11px] text-[#8a8a8a]">{layers.length} layers</span>
        </span>
      </div>
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={graph ? (e) => setView2((v) => ({ ...v, left: (e.target as HTMLElement).scrollLeft })) : undefined}
          className="absolute inset-0 overflow-auto text-[12px]"
        >
          <div ref={content} onPointerDown={startMarquee} className="relative min-h-full" style={{ width: LEFT_W + trackW + 16 }}>
            <div className="sticky top-0 z-30 flex border-b border-[#151515] bg-[#232323]" style={{ height: RULER_H }}>
              <div className="sticky left-0 z-30 flex shrink-0 items-end gap-1 bg-[#232323] pr-2 pb-1 text-[11px] text-[#8a8a8a]" style={{ width: LEFT_W }}>
                <span className="flex shrink-0 justify-center" style={{ width: COL.eye }} title="Video">
                  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
                    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" />
                    <circle cx="8" cy="8" r="2" />
                  </svg>
                </span>
                <span className="flex shrink-0 justify-center" style={{ width: COL.sw }} title="Solo">
                  <SoloIcon on />
                </span>
                <span className="flex shrink-0 justify-center" style={{ width: COL.sw }} title="Lock">
                  <LockIcon on />
                </span>
                <span className="w-[18px] shrink-0" />
                <span className="w-6 shrink-0 text-right">#</span>
                <span className="w-[22px] shrink-0" />
                <span className="flex-1">Source Name</span>
                <span className="flex shrink-0 justify-center" style={{ width: COL.sw }} title="Shy">
                  <ShyIcon on />
                </span>
                <span className="w-5 shrink-0 text-center">fx</span>
                <span className="shrink-0" style={{ width: COL.mode }}>
                  Mode
                </span>
                <span className="shrink-0" style={{ width: COL.matte }}>
                  TrkMat
                </span>
                <span className="shrink-0" style={{ width: COL.parent }}>
                  Parent &amp; Link
                </span>
              </div>
              <Ruler duration={duration} fps={fps} pps={pps} trackW={trackW} markers={scene?.markers ?? []} workArea={scene?.work_area ?? null} onScrub={scrub} />
            </div>

            {row(
              "voice",
              audioLeft(AUDIO_LABEL, "Voice"),
              audio && audioUrl ? (
                <div
                  onPointerDown={dragAudio(LayerDrag.Move)}
                  className="absolute inset-y-[3px] flex cursor-grab overflow-hidden rounded-[2px] active:cursor-grabbing"
                  style={{ left: px(audio.start), width: Math.max(4, px(audioEnd(audio, audioOut) - audio.start)), background: `${AUDIO_LABEL}55` }}
                >
                  {peaks && <Waveform peaks={peaks.peaks} from={audio.trim_in / peaks.duration} to={audioOut / peaks.duration} width={px(audioEnd(audio, audioOut) - audio.start)} />}
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
              if (!shown.length && (hideShy || !group.toLowerCase().includes(q))) return [];
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
                    <span className="shrink-0" style={{ width: COL.sw * 2 + 4 }} />
                    {swatch(GROUP_LABEL)}
                    <span className="w-6 shrink-0" />
                    <span className="w-1 shrink-0" />
                    {twirl(`g:${group}`)}
                    <button type="button" onClick={() => selectGroup(group, start, end)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                      <span className="w-3 shrink-0 text-center text-[#8a8a8a]">▣</span>
                      <span className="truncate font-medium">{group}</span>
                      <span className="shrink-0 text-[#8a8a8a]">{e.layers.length}</span>
                    </button>
                  </>,
                  bar(start, end, GROUP_LABEL, isSel, dragGroup(group), () => selectGroup(group, start, end), `${group} · ${e.layers.length} layers · ${start.toFixed(2)}–${end.toFixed(2)} s`),
                  { selected: isSel },
                ),
                ...(open.has(`g:${group}`) || q ? [...shown].reverse().flatMap((l) => layerRows(l, true)) : []),
              ];
            })}

            {marquee && (
              <span
                className="pointer-events-none absolute z-40 border border-[#4aa3f0] bg-[#4aa3f0]/10"
                style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
              />
            )}
            {!graph && <TimeIndicator left={LEFT_W} pps={pps} />}
          </div>
        </div>
        {graph && scene && (
          <div className="absolute bottom-0 z-[25] overflow-hidden border-l border-[#151515]" style={{ left: LEFT_W, top: RULER_H, width: viewW + 16 }}>
            <GraphMount
              scene={scene as SceneView}
              fps={fps}
              layerId={graphLayer?.id ?? null}
              props={graphProps}
              timeToX={(t) => t * pps - view2.left}
              xToTime={(x) => (x + view2.left) / pps}
              width={viewW + 16}
              height={Math.max(60, view2.h - RULER_H)}
            />
          </div>
        )}
      </div>

      {menu && scene && <KeyMenu x={menu.x} y={menu.y} current={menu.current} onPick={(c) => keysCmd(c)} onClose={() => setMenu(null)} />}

      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-[#151515] px-3 text-[#8a8a8a]">
        <span className="text-[11px]">Drag a bar to retime it · right-click a key for its interpolation · drag on keys to select · ? for shortcuts · ⌘ + scroll to zoom</span>
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

/** The GRAPH agent's editor, fed the playhead here so only it re-renders while playing. */
function GraphMount(props: Omit<Parameters<typeof GraphEditor>[0], "time">) {
  const time = useEditor((s) => s.time);
  return <GraphEditor {...props} time={time} />;
}

/** Current frame and frame rate (re-renders with the playhead, alone). */
function FrameCount({ fps }: { fps: number }) {
  const time = useEditor((s) => s.time);
  return (
    <span className="text-[11px] text-[#8a8a8a] tabular-nums">
      {Math.round(time * fps)} f · {fps} fps
    </span>
  );
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
