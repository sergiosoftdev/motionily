import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Op } from "@motionily/protocol";
import { apply, commit, preview } from "../../../editing/direct";
import { engineHost } from "../../../engine/host";
import { useEditor } from "../../../store";
import type { SceneView } from "../../sceneView";
import { isKeys, setProp, snap, type Anim, type Key } from "../keys";
import { AE } from "../theme";
import { channelFor, fmt, type Channel } from "./channels";
import { GraphCommand, graphKeys } from "./commands";
import { drawGraph, GraphMode, HitKind, vOf, type Entry, type Hit, type Plot } from "./draw";
import { applyPreset, deleteKeys, EasePreset, moveKeys, sameT, segmentOf, setHandle, setSpeedHandle, Side, speedHandle } from "./edit";
import { bezierOf, sampleKeys } from "./evaluate";
import { sampleCurve } from "./sampling";

/** Props the timeline passes in: what to graph and how scene time maps to x in its keyframe area. */
export type GraphEditorProps = {
  scene: SceneView;
  fps: number;
  layerId: string | null;
  props: string[];
  timeToX: (t: number) => number;
  xToTime: (x: number) => number;
  width: number;
  height: number;
  time: number;
};

const TOOLBAR_H = 24;
const EASEBAR_H = 26;
/** Room above and below the curves inside the plot. */
const PAD_Y = 12;
/** Fit leaves this fraction of the range free above and below. */
const FIT_PAD = 0.08;
const HIT_R = 6;
const DRAG_THRESHOLD = 3;

/** A selected keyframe: prop and time relative to the layer start (indices shift as keys move). */
type KeyRef = { prop: string; t: number };

const DragKind = { Keys: "keys", Handle: "handle", Marquee: "marquee" } as const;
type Drag =
  | { kind: typeof DragKind.Keys; x0: number; y0: number; plot: Plot; base: Record<string, Key[]>; sel: Record<string, Set<number>>; now: Record<string, number[]>; moved: boolean }
  | { kind: typeof DragKind.Handle; prop: string; index: number; side: Side; base: Key[]; plot: Plot; moved: boolean }
  | { kind: typeof DragKind.Marquee; x0: number; y0: number; x1: number; y1: number; add: KeyRef[]; plot: Plot };

/** The ease buttons at the bottom: AE's converters, then its keyframe assistants (F9 family). */
const EASE_BUTTONS: { preset: EasePreset; label: string; title: string }[] = [
  { preset: EasePreset.Hold, label: "Hold", title: "Convert selected keyframes to Hold" },
  { preset: EasePreset.Linear, label: "Linear", title: "Convert selected keyframes to Linear" },
  { preset: EasePreset.AutoBezier, label: "Auto Bezier", title: "Convert selected keyframes to Auto Bezier" },
  { preset: EasePreset.EasyEase, label: "Easy Ease", title: "Easy Ease (F9)" },
  { preset: EasePreset.EaseIn, label: "Ease In", title: "Easy Ease In (⇧F9)" },
  { preset: EasePreset.EaseOut, label: "Ease Out", title: "Easy Ease Out (⌘⇧F9)" },
];
const ASSISTANT_START = 3;

/** The part of `el` its scrolling/clipping ancestors leave visible, in its own x coordinates. */
function visibleSpan(el: HTMLElement, width: number): [number, number] {
  const r = el.getBoundingClientRect();
  let left = Math.max(r.left, 0);
  let right = Math.min(r.right, window.innerWidth);
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowX === "visible") continue;
    const pr = p.getBoundingClientRect();
    left = Math.max(left, pr.left);
    right = Math.min(right, pr.right);
  }
  const a = Math.max(0, Math.floor(left - r.left));
  const b = Math.min(width, Math.ceil(right - r.left));
  return b > a ? [a, b] : [0, Math.min(width, 1)];
}

/** Value (or speed) range that shows every visible curve, never flat. */
function fitRange(entries: Entry[], mode: GraphMode, factor: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const { curve } of entries) {
    lo = Math.min(lo, mode === GraphMode.Value ? curve.vMin : curve.sMin);
    hi = Math.max(hi, mode === GraphMode.Value ? curve.vMax : curve.sMax);
  }
  if (mode === GraphMode.Speed) (lo = Math.min(lo, 0)), (hi = Math.max(hi, 0));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  const mid = (lo + hi) / 2;
  const least = Math.max(Math.abs(mid) * 0.2, 1 / factor);
  if (hi - lo < least) (lo = mid - least / 2), (hi = mid + least / 2);
  const pad = (hi - lo) * FIT_PAD;
  return [lo - pad, hi + pad];
}

function Btn({ on, disabled, title, onClick, children }: { on?: boolean; disabled?: boolean; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`h-[18px] shrink-0 rounded-sm px-1.5 leading-none hover:bg-[#3a3a3a] disabled:opacity-35 disabled:hover:bg-transparent ${on ? "bg-[#3e3e3e] text-[#4aa3f0]" : "text-[#c9c9c9]"}`}
    >
      {children}
    </button>
  );
}

/**
 * After Effects' Graph Editor for one layer's props: the Value graph (curves through the keys,
 * bezier handles you can pull) and the Speed graph (units per second, handles set speed and
 * influence). Every edit is a plain `set_prop` op with the new key list, previewed while dragging
 * and committed once on release, so Claude makes the very same edits through MCP.
 */
export function GraphEditor({ scene, fps, layerId, props, timeToX, xToTime, width, height, time }: GraphEditorProps) {
  const layer = layerId ? scene.layers.find((l) => l.id === layerId) : undefined;
  const start = layer?.start ?? 0;
  const end = layer?.end ?? scene.duration;
  // The playhead follows the store live, even when the parent re-renders lazily.
  const now = useEditor((s) => s.time) ?? time;
  const [mode, setMode] = useState<GraphMode>(GraphMode.Value);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<KeyRef[]>([]);
  const [autoZoom, setAutoZoom] = useState(true);
  const [span, setSpan] = useState<[number, number]>([0, width]);

  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Key lists being dragged (already previewed in the engine), drawn instead of the scene's. */
  const draft = useRef<Record<string, Key[]> | null>(null);
  const drag = useRef<Drag | null>(null);
  const hover = useRef<Hit | null>(null);
  const hits = useRef<Hit[]>([]);
  const plotRef = useRef<Plot>({ top: PAD_Y, h: 1, lo: 0, hi: 1 });
  const entriesRef = useRef<Entry[]>([]);
  /** Height range set by hand (Fit, ⌥ + scroll) per graph, used while auto-zoom is off. */
  const manual = useRef<Record<GraphMode, [number, number] | null>>({ [GraphMode.Value]: null, [GraphMode.Speed]: null });
  const rev = useRef({ scene, n: 0 });
  if (rev.current.scene !== scene) rev.current = { scene, n: rev.current.n + 1 };

  const propsKey = props.join("|");
  const channels = useMemo(() => propsKey.split("|").filter(Boolean).map(channelFor), [propsKey]);
  const shown = channels.filter((c) => !hidden.has(c.prop));
  const lead = shown[0];
  const sameUnit = !!lead && shown.every((c) => c.factor === lead.factor && c.unit === lead.unit);
  const factor = sameUnit && lead ? lead.factor : 1;
  const unit = sameUnit && lead ? lead.unit : "";
  const viewW = Math.max(0, span[1] - span[0]);
  const plotH = Math.max(0, height - TOOLBAR_H - EASEBAR_H);

  useEffect(() => setSelection([]), [layerId]);

  const animOf = (prop: string): Anim | undefined => draft.current?.[prop] ?? (layer?.[prop] as Anim | undefined);
  const keysOf = (prop: string): Key[] | null => {
    const a = animOf(prop);
    return isKeys(a) && a.length ? a : null;
  };
  const isSelected = (prop: string, t: number) => selection.some((r) => r.prop === prop && sameT(r.t, t, fps));
  const selectedIn = (prop: string, keys: readonly Key[]) => new Set(keys.flatMap((k, i) => (isSelected(prop, k.t) ? [i] : [])));

  // Keep the canvas on the visible part when the timeline scrolls a wide keyframe area.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => {
      const s = visibleSpan(root, width);
      setSpan((p) => (p[0] === s[0] && p[1] === s[1] ? p : s));
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const ro = new ResizeObserver(update);
    ro.observe(root);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, [width]);

  // --- drawing -------------------------------------------------------------------------------
  const buildEntries = (): Entry[] => {
    if (!layer || !layerId || viewW <= 0) return [];
    const t0 = xToTime(span[0]);
    const t1 = xToTime(span[1]);
    const pps = viewW / Math.max(1e-6, t1 - t0);
    let current: Record<string, number> | undefined;
    return shown.map((channel) => {
      let anim = animOf(channel.prop);
      if (anim === undefined) {
        try {
          current ??= engineHost.propValues(layerId);
        } catch {
          current = {};
        }
        anim = current?.[channel.prop] ?? 0;
      }
      const curve = sampleCurve({ layerId, prop: channel.prop, anim, start, t0, t1, pps, revision: rev.current.n });
      return { channel, keys: isKeys(anim) && anim.length ? anim : null, curve };
    });
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas || viewW <= 0 || plotH <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(viewW * dpr);
    const ph = Math.round(plotH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) (canvas.width = pw), (canvas.height = ph);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const entries = buildEntries();
    entriesRef.current = entries;
    const d = drag.current;
    const [lo, hi] = d ? [d.plot.lo, d.plot.hi] : autoZoom ? fitRange(entries, mode, factor) : (manual.current[mode] ?? fitRange(entries, mode, factor));
    const plot: Plot = { top: PAD_Y, h: Math.max(1, plotH - 2 * PAD_Y), lo, hi };
    plotRef.current = plot;
    const moving = d?.kind === DragKind.Keys ? d.now : null;
    hits.current = drawGraph({
      ctx,
      w: viewW,
      h: plotH,
      mode,
      entries,
      start,
      end,
      x: (t) => timeToX(t) - span[0],
      plot,
      time: now,
      factor,
      unit,
      selected: (prop, i) => {
        const k = entries.find((e) => e.channel.prop === prop)?.keys?.[i];
        if (!k) return false;
        return moving ? (moving[prop]?.some((t) => sameT(t, k.t, fps)) ?? false) : isSelected(prop, k.t);
      },
      hover: hover.current,
      marquee: d?.kind === DragKind.Marquee ? { x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 } : null,
      empty: !layer ? "Select a layer property to see its graph" : shown.length ? null : "No properties shown",
    });
  };
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const raf = useRef(0);
  const requestDraw = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      drawRef.current();
    });
  }, []);
  useEffect(() => requestDraw());
  // Reset the guard too: StrictMode's mount → unmount → mount would otherwise leave it stuck and never draw.
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );

  const modeRef = useRef(mode);
  modeRef.current = mode;
  // ⌥ + scroll zooms the graph height around the pointer (and turns auto-zoom off).
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      const p = plotRef.current;
      const v = vOf(p, e.offsetY);
      const k = Math.exp(e.deltaY * 0.002);
      manual.current[modeRef.current] = [v - (v - p.lo) * k, v + (p.hi - v) * k];
      setAutoZoom(false);
      requestDraw();
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [requestDraw]);

  // --- pointer ------------------------------------------------------------------------------
  const point = (e: ReactPointerEvent) => {
    const r = rootRef.current!.getBoundingClientRect();
    const c = canvasRef.current!.getBoundingClientRect();
    return { xr: e.clientX - r.left, xc: e.clientX - c.left, y: e.clientY - c.top };
  };
  const hitAt = (x: number, y: number): Hit | null => {
    const near = (kind: HitKind) =>
      hits.current
        .filter((h) => h.kind === kind)
        .map((h) => ({ h, d: Math.hypot(h.x - x, h.y - y) }))
        .filter((o) => o.d <= HIT_R)
        .sort((a, b) => a.d - b.d)[0]?.h ?? null;
    return near(HitKind.Handle) ?? near(HitKind.Key);
  };
  const channelOf = (prop: string): Channel | undefined => channels.find((c) => c.prop === prop);
  const clampFor = (prop: string) => {
    const c = channelOf(prop);
    return (v: number) => Math.min(c?.max ?? Infinity, Math.max(c?.min ?? -Infinity, v));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    // The graph owns its clicks: the timeline underneath must not deselect the layer or start its own marquee.
    e.stopPropagation();
    if (e.button !== 0 || !layer) return;
    viewRef.current?.focus();
    const p = point(e);
    const hit = hitAt(p.xc, p.y);
    const plot = plotRef.current;
    if (hit?.kind === HitKind.Handle && hit.side) {
      const base = keysOf(hit.prop);
      if (base) drag.current = { kind: DragKind.Handle, prop: hit.prop, index: hit.index, side: hit.side, base, plot, moved: false };
    } else if (hit?.kind === HitKind.Key) {
      const t = keysOf(hit.prop)![hit.index]!.t;
      const already = isSelected(hit.prop, t);
      const sel: KeyRef[] = e.shiftKey
        ? already
          ? selection.filter((r) => !(r.prop === hit.prop && sameT(r.t, t, fps)))
          : [...selection, { prop: hit.prop, t }]
        : already
          ? selection
          : [{ prop: hit.prop, t }];
      setSelection(sel);
      if (!(e.shiftKey && already)) {
        const base: Record<string, Key[]> = {};
        const idx: Record<string, Set<number>> = {};
        const now: Record<string, number[]> = {};
        for (const c of shown) {
          const keys = keysOf(c.prop);
          if (!keys) continue;
          const set = new Set(keys.flatMap((k, i) => (sel.some((r) => r.prop === c.prop && sameT(r.t, k.t, fps)) ? [i] : [])));
          if (!set.size) continue;
          base[c.prop] = keys;
          idx[c.prop] = set;
          now[c.prop] = [...set].map((i) => keys[i]!.t);
        }
        drag.current = { kind: DragKind.Keys, x0: p.xr, y0: p.y, plot, base, sel: idx, now, moved: false };
      }
    } else {
      drag.current = { kind: DragKind.Marquee, x0: p.xc, y0: p.y, x1: p.xc, y1: p.y, add: e.shiftKey ? selection : [], plot };
      if (!e.shiftKey) setSelection([]);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    requestDraw();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const p = point(e);
    if (!d) {
      const h = hitAt(p.xc, p.y);
      if (h?.kind !== hover.current?.kind || h?.prop !== hover.current?.prop || h?.index !== hover.current?.index || h?.side !== hover.current?.side) {
        hover.current = h;
        e.currentTarget.style.cursor = h ? (h.kind === HitKind.Handle ? "grab" : "move") : "default";
        requestDraw();
      }
      return;
    }
    if (!layerId) return;
    if (d.kind === DragKind.Marquee) {
      d.x1 = p.xc;
      d.y1 = p.y;
      requestDraw();
      return;
    }
    if (d.kind === DragKind.Keys) {
      const dx = p.xr - d.x0;
      const dy = p.y - d.y0;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      let dt = Math.round((xToTime(p.xr) - xToTime(d.x0)) * fps) / fps;
      let dv = mode === GraphMode.Value ? vOf(d.plot, p.y) - vOf(d.plot, d.y0) : 0;
      // Shift keeps the drag on one axis.
      if (e.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dv = 0;
        else dt = 0;
      }
      const first = Math.min(...Object.entries(d.sel).flatMap(([prop, set]) => [...set].map((i) => d.base[prop]![i]!.t)));
      if (first + dt < 0) dt = -snap(first, fps);
      const next: Record<string, Key[]> = {};
      const ops: Op[] = [];
      for (const [prop, set] of Object.entries(d.sel)) {
        next[prop] = moveKeys(d.base[prop]!, set, dt, dv, fps, clampFor(prop));
        d.now[prop] = [...set].map((i) => (dt !== 0 ? snap(d.base[prop]![i]!.t + dt, fps) : d.base[prop]![i]!.t));
        ops.push(setProp(layerId, prop, next[prop]));
      }
      draft.current = next;
      preview(ops);
      requestDraw();
      return;
    }
    // A bezier handle.
    const s = segmentOf(d.base, d.index, d.side);
    if (s < 0) return;
    d.moved = true;
    const a = d.base[s]!;
    const b = d.base[s + 1]!;
    const span = b.t - a.t;
    const t = xToTime(p.xr) - start;
    let keys: Key[];
    if (mode === GraphMode.Value) {
      const dvs = b.v - a.v;
      const bz = bezierOf(a);
      const y = dvs !== 0 ? (vOf(d.plot, p.y) - a.v) / dvs : d.side === Side.Out ? (bz?.[1] ?? 0) : (bz?.[3] ?? 1);
      keys = setHandle(d.base, d.index, d.side, (t - a.t) / span, y);
    } else {
      const tk = d.base[d.index]!.t;
      const influence = (d.side === Side.Out ? t - tk : tk - t) / span;
      keys = setSpeedHandle(d.base, d.index, d.side, vOf(d.plot, p.y), influence);
    }
    draft.current = { [d.prop]: keys };
    preview([setProp(layerId, d.prop, keys)]);
    requestDraw();
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && layerId) {
      if (d.kind === DragKind.Keys && d.moved) {
        const n = Object.values(d.sel).reduce((s, set) => s + set.size, 0);
        commit(`Moves ${n} keyframe${n > 1 ? "s" : ""} of ${layerId} in the graph editor`);
        setSelection(Object.entries(d.now).flatMap(([prop, ts]) => ts.map((t) => ({ prop, t }))));
      } else if (d.kind === DragKind.Handle && d.moved) {
        commit(`Reshapes the ${d.side} ease of a ${channelOf(d.prop)?.label ?? d.prop} keyframe of ${layerId}`);
      } else if (d.kind === DragKind.Marquee) {
        const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
        const [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
        const inside = hits.current
          .filter((h) => h.kind === HitKind.Key && h.x >= x0 && h.x <= x1 && h.y >= y0 && h.y <= y1)
          .map((h) => ({ prop: h.prop, t: keysOf(h.prop)![h.index]!.t }));
        setSelection([...d.add, ...inside.filter((r) => !d.add.some((a) => a.prop === r.prop && sameT(a.t, r.t, fps)))]);
      }
    }
    draft.current = null;
    requestDraw();
  };

  // --- readout of a single selected key -----------------------------------------------------
  const selectedKeys = shown.flatMap((c) => (keysOf(c.prop) ?? []).flatMap((k, i, keys) => (isSelected(c.prop, k.t) ? [{ c, k, i, keys }] : [])));
  let readout = selectedKeys.length > 1 ? `${selectedKeys.length} keyframes` : "";
  if (selectedKeys.length === 1) {
    const { c, k, i, keys } = selectedKeys[0]!;
    const head = `${c.label} · ${(start + k.t).toFixed(2)} s · ${fmt(k.v * c.factor)}${c.unit}`;
    if (mode === GraphMode.Speed) {
      const side = (s: Side) => {
        const h = speedHandle(keys, i, s);
        return h ? `${s} ${fmt(h.speed * c.factor)}${c.unit}/s ${fmt(h.influence * 100)}%` : null;
      };
      readout = [head, side(Side.In), side(Side.Out)].filter(Boolean).join(" · ");
    } else readout = head;
  }
  const anySelected = selectedKeys.length > 0;

  // --- commands ------------------------------------------------------------------------------
  /** One op per prop that has selected keys, applied as one edit. */
  const editSelected = (what: (keys: Key[], sel: Set<number>, prop: string) => Anim, label: (n: number) => string) => {
    if (!layerId) return;
    const ops: Op[] = [];
    let n = 0;
    for (const c of shown) {
      const keys = keysOf(c.prop);
      if (!keys) continue;
      const sel = selectedIn(c.prop, keys);
      if (!sel.size) continue;
      n += sel.size;
      ops.push(setProp(layerId, c.prop, what(keys, sel, c.prop)));
    }
    if (ops.length) apply(ops, label(n));
  };
  const plural = (n: number) => `${n} keyframe${n > 1 ? "s" : ""}`;
  const runPreset = (preset: EasePreset) => {
    const name = EASE_BUTTONS.find((b) => b.preset === preset)?.label ?? preset;
    editSelected((keys, sel) => applyPreset(keys, sel, preset), (n) => `${name} on ${plural(n)} of ${layerId}`);
  };
  const removeSelected = () => {
    // With every key gone the prop keeps the value it has now, as in AE.
    editSelected((keys, sel) => deleteKeys(keys, sel, sampleKeys(keys, now - start)), (n) => `Deletes ${plural(n)} of ${layerId} in the graph editor`);
    setSelection([]);
  };
  const fitNow = () => {
    manual.current[mode] = fitRange(entriesRef.current, mode, factor);
    requestDraw();
  };

  // Pro's shortcut table hears keys first; it hands F9 / Delete to the graph while keys are selected here.
  const commandRef = useRef<(cmd: GraphCommand) => boolean>(() => false);
  commandRef.current = (cmd) => {
    if (!anySelected) return false;
    if (cmd === GraphCommand.Delete) removeSelected();
    else runPreset(cmd === GraphCommand.EaseIn ? EasePreset.EaseIn : cmd === GraphCommand.EaseOut ? EasePreset.EaseOut : EasePreset.EasyEase);
    return true;
  };
  useEffect(() => {
    const run = (cmd: GraphCommand) => commandRef.current(cmd);
    graphKeys.run = run;
    return () => {
      if (graphKeys.run === run) graphKeys.run = null;
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey;
    let handled = true;
    if (e.key === "Delete" || e.key === "Backspace") removeSelected();
    else if (e.key === "F9") runPreset(meta && e.shiftKey ? EasePreset.EaseOut : e.shiftKey ? EasePreset.EaseIn : EasePreset.EasyEase);
    else if (e.key === "Escape") setSelection([]);
    else if (meta && e.key.toLowerCase() === "a") setSelection(shown.flatMap((c) => (keysOf(c.prop) ?? []).map((k) => ({ prop: c.prop, t: k.t }))));
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };


  return (
    <div ref={rootRef} className="relative select-none" style={{ width, height }}>
      <div
        ref={viewRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="absolute top-0 flex flex-col overflow-hidden text-[11px] outline-none"
        style={{ left: span[0], width: viewW, height, background: AE.field, color: AE.text }}
      >
        <div className="flex shrink-0 items-center gap-1 overflow-hidden px-1.5" style={{ height: TOOLBAR_H, background: AE.panel, borderBottom: `1px solid ${AE.line}` }}>
          <Btn on={mode === GraphMode.Value} onClick={() => setMode(GraphMode.Value)} title="Value graph">
            Value
          </Btn>
          <Btn on={mode === GraphMode.Speed} onClick={() => setMode(GraphMode.Speed)} title="Speed graph">
            Speed
          </Btn>
          <span className="mx-1 h-3 w-px shrink-0" style={{ background: "#3a3a3a" }} />
          {channels.map((c) => (
            <button
              key={c.prop}
              type="button"
              title={hidden.has(c.prop) ? `Show ${c.label}` : `Hide ${c.label}`}
              onClick={() =>
                setHidden((h) => {
                  const n = new Set(h);
                  if (n.has(c.prop)) n.delete(c.prop);
                  else n.add(c.prop);
                  return n;
                })
              }
              className={`flex h-[18px] shrink-0 items-center gap-1 rounded-sm px-1 hover:bg-[#3a3a3a] ${hidden.has(c.prop) ? "opacity-40" : ""}`}
            >
              <span className="size-2 rounded-full" style={{ background: c.color }} />
              {c.label}
            </button>
          ))}
          <span className="ml-auto min-w-0 truncate px-1 tabular-nums" style={{ color: AE.value }}>
            {readout}
          </span>
          <Btn on={autoZoom} onClick={() => setAutoZoom((z) => !z)} title="Auto-zoom graph height (⌥ + scroll zooms by hand)">
            Auto-zoom
          </Btn>
          <Btn onClick={fitNow} title="Fit all graphs to view">
            Fit
          </Btn>
        </div>
        <canvas
          ref={canvasRef}
          className="block shrink-0 touch-none"
          style={{ width: viewW, height: plotH }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            if (!drag.current && hover.current) (hover.current = null), requestDraw();
          }}
        />
        <div className="flex shrink-0 items-center gap-1 overflow-hidden px-1.5" style={{ height: EASEBAR_H, background: AE.panel, borderTop: `1px solid ${AE.line}` }}>
          {EASE_BUTTONS.map((b, i) => (
            <span key={b.preset} className="flex items-center">
              {i === ASSISTANT_START && <span className="mx-1 h-3 w-px" style={{ background: "#3a3a3a" }} />}
              <Btn disabled={!anySelected} title={b.title} onClick={() => runPreset(b.preset)}>
                {b.label}
              </Btn>
            </span>
          ))}
          <span className="ml-auto truncate pl-2" style={{ color: AE.dim }}>
            Drag keys and handles · Shift adds · Delete removes
          </span>
        </div>
      </div>
    </div>
  );
}
