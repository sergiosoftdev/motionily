import { useEffect, useRef, useState, type RefObject } from "react";
import { OpName, type Op } from "@motionily/protocol";
import { apply, commit, preview } from "../../../editing/direct";
import { sceneLayers } from "../../../editing/groups";
import { engineHost } from "../../../engine/host";
import { ActivitySource, logActivity, useEditor } from "../../../store";
import { AE, labelColor } from "../theme";
import {
  add,
  anchorOps,
  axes,
  boxPoint,
  corners,
  dot,
  editable,
  isLocked,
  measure,
  moveOps,
  mul,
  penLayerOp,
  rotateOps,
  scaleOps,
  sceneFont,
  shapeLayerOp,
  snapAxis,
  snapTargets,
  sub,
  textLayerOp,
  TEXT_SIZE,
  unionBox,
  type Box,
  type Frame,
  type PenPoint,
  type SnapTargets,
  type Vec,
} from "./frame";
import { MAX_ZOOM, MIN_ZOOM, Overlay, Platform, selectedIds, setGuides, setSelection, stepZoom, Tool, useViewer } from "./state";

/** Screen px a pointer must travel before a press is a drag. */
const DRAG_PX = 3;
const HANDLE_PX = 7;
/** How far outside a corner still rotates. */
const ROTATE_PX = 24;
const SNAP_PX = 8;
const GUIDE_HIT_PX = 4;
const PEN_CLOSE_PX = 9;
/** A click (no drag) with the shape tool draws this size, in scene px. */
const CLICK_SHAPE = 240;
const RULER_PX = 20;
const GRID_PX = 100;
const GRID_SUB = 4;
const COVER_SHARE = 0.9;

const COLORS = {
  guide: "#27c6e8",
  snap: "#ff3df2",
  grid: "rgba(255,255,255,0.13)",
  gridSub: "rgba(255,255,255,0.05)",
  safe: "rgba(255,255,255,0.55)",
  appUi: "rgba(255,72,72,0.2)",
  appUiLine: "rgba(255,110,110,0.85)",
  textSafe: "rgba(80,220,140,0.9)",
  marquee: "rgba(45,140,235,0.12)",
} as const;

/** Where each app's UI sits on a 1080×1920 vertical video (approximate, from their current layouts). */
type Zone = [x0: number, y0: number, x1: number, y1: number, label: string];
const REF_W = 1080;
const REF_H = 1920;
const APP_UI: Record<Exclude<Platform, typeof Platform.None>, { zones: Zone[]; safe: [number, number, number, number] }> = {
  tiktok: {
    zones: [
      [0, 0, 1080, 150, "Top bar · Following / For You"],
      [940, 720, 1080, 1500, "Buttons"],
      [0, 1500, 1080, 1920, "Username · caption · sound · nav bar"],
    ],
    safe: [60, 150, 940, 1500],
  },
  reels: {
    zones: [
      [0, 0, 1080, 210, "Top bar · Reels · camera"],
      [950, 900, 1080, 1560, "Buttons"],
      [0, 1560, 1080, 1920, "Username · caption · audio · nav bar"],
    ],
    safe: [60, 210, 950, 1560],
  },
  shorts: {
    zones: [
      [0, 0, 1080, 140, "Top bar · search"],
      [900, 820, 1080, 1480, "Buttons"],
      [0, 1480, 1080, 1920, "Title · channel · sound · nav bar"],
    ],
    safe: [60, 140, 900, 1480],
  },
};

const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M6 15a7 7 0 1 1 9 4" fill="none" stroke="black" stroke-width="4"/><path d="M6 15a7 7 0 1 1 9 4" fill="none" stroke="white" stroke-width="2"/><path d="M2 12l4 4 4-4" fill="white" stroke="black"/></svg>',
)}") 12 12, alias`;

// ── shared between the overlay, the rulers and the keys ─────────────────

let dirty = true;
/** Repaint the overlay and rulers on the next frame. */
export const invalidate = () => {
  dirty = true;
};
const painters = new Set<() => void>();
/** Space held (hand tool) and whether the pointer is over the viewer. */
export const hold = { space: false, hover: false, panned: false };
let refreshCursor = () => {};
export function setSpace(on: boolean) {
  hold.space = on;
  refreshCursor();
}

/** Things drawn while a gesture is under way. */
const live: {
  marquee: [Vec, Vec] | null;
  shape: [Vec, Vec] | null;
  snap: { x?: number; y?: number };
  pen: PenPoint[];
  penHover: Vec | null;
  guide: { axis: "x" | "y"; at: number } | null;
} = { marquee: null, shape: null, snap: {}, pen: [], penHover: null, guide: null };

/** Mapping between scene px and the stage (the element the overlay covers). */
function viewOf(canvas: HTMLCanvasElement) {
  const stage = canvas.parentElement!;
  const sr = stage.getBoundingClientRect();
  const r = canvas.getBoundingClientRect();
  const [sw, sh] = engineHost.sceneSize();
  const k = r.width / sw;
  const ox = r.left - sr.left;
  const oy = r.top - sr.top;
  return {
    k,
    sw,
    sh,
    sr,
    r,
    toStage: (p: Vec): Vec => [ox + p[0] * k, oy + p[1] * k],
    toScene: (cx: number, cy: number): Vec => [(cx - r.left) / k, (cy - r.top) / k],
  };
}
type View = ReturnType<typeof viewOf>;

/** Current magnification (the fit one when fitting). */
export function currentScale(canvas: HTMLCanvasElement) {
  return useViewer.getState().zoom ?? viewOf(canvas).k;
}

/** Zoom to `next` (null = fit) keeping the scene point under `client` (default: the stage center) in place. */
export function zoomTo(canvas: HTMLCanvasElement, next: number | null, client?: Vec) {
  if (next === null) return useViewer.setState({ zoom: null, pan: [0, 0] });
  const v = viewOf(canvas);
  if (!(v.k > 0)) return;
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  const p = client ?? [v.sr.left + v.sr.width / 2, v.sr.top + v.sr.height / 2];
  const s = v.toScene(p[0], p[1]);
  useViewer.setState({
    zoom: z,
    pan: [p[0] - v.sr.left - v.sr.width / 2 + (v.sw / 2 - s[0]) * z, p[1] - v.sr.top - v.sr.height / 2 + (v.sh / 2 - s[1]) * z],
  });
}

/** Apply ops by hand; a refused op is reported instead of thrown. */
function run(ops: Op[], what: string) {
  if (!ops.length) return;
  try {
    apply(ops, what);
  } catch (e) {
    logActivity(ActivitySource.System, `${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const nameOf = (ids: string[]) => (ids.length === 1 ? ids[0]! : `${ids.length} layers`);

/** Layers under a scene point that the canvas may pick (not locked, not inside instances). */
function stack(p: Vec) {
  return engineHost.pickStack(p[0], p[1]).filter((h) => editable(h.id) && !isLocked(h.id));
}

function measureAll(ids: string[]): Frame[] {
  return ids.filter(editable).flatMap((id) => measure(id) ?? []);
}

/** Box-local position of `p` (scene) relative to `b`. */
function local(b: Box, p: Vec): Vec {
  const [u, v] = axes(b);
  const q = sub(p, [b.cx, b.cy]);
  return [dot(q, u), dot(q, v)];
}

/** Drag a guide (new from a ruler, or an existing one); dropped off the stage it is removed. */
function dragGuide(canvas: HTMLCanvasElement, axis: "x" | "y", e: PointerEvent | React.PointerEvent) {
  e.preventDefault();
  const at = (ev: { clientX: number; clientY: number }) => {
    const p = viewOf(canvas).toScene(ev.clientX, ev.clientY);
    return Math.round(axis === "x" ? p[0] : p[1]);
  };
  live.guide = { axis, at: at(e) };
  invalidate();
  const move = (ev: PointerEvent) => {
    live.guide = { axis, at: at(ev) };
    invalidate();
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    live.guide = null;
    const sr = canvas.parentElement!.getBoundingClientRect();
    const inside = ev.clientX >= sr.left && ev.clientX <= sr.right && ev.clientY >= sr.top && ev.clientY <= sr.bottom;
    const g = useViewer.getState().guides;
    if (inside) setGuides({ ...g, [axis]: [...g[axis], at(ev)] });
    invalidate();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}

type TextEdit = { id: string | null; at: Vec; text: string; size: number; box: Box | null };

/**
 * The Composition panel's canvas tools, drawn over the engine canvas: transform gizmos (move,
 * scale, rotate, anchor), marquee and Shift selection, snapping, shape/pen/type tools, zoom and
 * pan, grid, guides, safe areas and app UI zones. Every edit is an op, previewed while dragging
 * and committed once on release.
 */
export function ViewerOverlay({ canvas }: { canvas: RefObject<HTMLCanvasElement | null> }) {
  const root = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLCanvasElement>(null);
  const model = useRef<{ frames: Frame[]; gizmo: Box | null }>({ frames: [], gizmo: null });
  const tool = useViewer((s) => s.tool);
  const [edit, setEdit] = useState<TextEdit | null>(null);

  // One paint loop for the gizmos and rulers, only when something changed.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!dirty) return;
      dirty = false;
      paint();
      painters.forEach((p) => p());
    };
    raf = requestAnimationFrame(loop);
    const offs = [useEditor.subscribe(invalidate), useViewer.subscribe(invalidate), engineHost.onSceneChange(invalidate)];
    const ro = new ResizeObserver(invalidate);
    if (root.current) ro.observe(root.current);
    if (canvas.current) ro.observe(canvas.current);
    invalidate();
    return () => {
      cancelAnimationFrame(raf);
      offs.forEach((off) => void off());
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas]);

  // Leaving the pen tool finishes the path being drawn.
  useEffect(() => {
    if (tool !== Tool.Pen) finishPen(false);
    refreshCursor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // Pen keys: Enter or Escape finish an open path (before the panel's own Escape deselects).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!live.pen.length || (e.key !== "Enter" && e.key !== "Escape")) return;
      e.preventDefault();
      finishPen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll pans when zoomed; ⌘/Ctrl + scroll (and trackpad pinch) zooms at the pointer.
  useEffect(() => {
    const el = root.current;
    const c = canvas.current;
    if (!el || !c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) return zoomTo(c, currentScale(c) * Math.exp(-e.deltaY * 0.01), [e.clientX, e.clientY]);
      const { zoom, pan } = useViewer.getState();
      if (zoom === null) return;
      useViewer.setState({ pan: [pan[0] - e.deltaX, pan[1] - e.deltaY] });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [canvas]);

  // ── painting ────────────────────────────────────────────────────────

  function paint() {
    const el = root.current;
    const out = paper.current;
    const c = canvas.current;
    if (!el || !out || !c) return;
    const dpr = window.devicePixelRatio || 1;
    const [cw, ch] = [el.clientWidth, el.clientHeight];
    if (out.width !== Math.round(cw * dpr) || out.height !== Math.round(ch * dpr)) {
      out.width = Math.round(cw * dpr);
      out.height = Math.round(ch * dpr);
    }
    const g = out.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const v = viewOf(c);
    if (!(v.k > 0) || c.style.visibility === "hidden") return;
    const { overlays, platform, guides } = useViewer.getState();

    const frames = measureAll(selectedIds());
    model.current = { frames, gizmo: frames.length === 1 ? frames[0]!.box : unionBox(frames.map((f) => f.box)) };

    const [fx0, fy0] = v.toStage([0, 0]);
    const [fx1, fy1] = v.toStage([v.sw, v.sh]);
    const line = (a: Vec, b: Vec) => {
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.stroke();
    };
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      const [a, b] = [v.toStage([x0, y0]), v.toStage([x1, y1])];
      return [a[0], a[1], b[0] - a[0], b[1] - a[1]] as const;
    };

    // App UI zones (vertical videos only).
    if (platform !== Platform.None && v.sh > v.sw) {
      const ui = APP_UI[platform];
      const [kx, ky] = [v.sw / REF_W, v.sh / REF_H];
      g.font = "500 11px Inter, system-ui, sans-serif";
      for (const [x0, y0, x1, y1, label] of ui.zones) {
        const r = rect(x0 * kx, y0 * ky, x1 * kx, y1 * ky);
        g.fillStyle = COLORS.appUi;
        g.fillRect(...r);
        g.strokeStyle = COLORS.appUiLine;
        g.setLineDash([4, 3]);
        g.strokeRect(...r);
        g.setLineDash([]);
        g.fillStyle = "#fff";
        g.save();
        g.beginPath();
        g.rect(...r);
        g.clip();
        g.fillText(label, r[0] + 6, r[1] + 15);
        g.restore();
      }
      const [s0, s1, s2, s3] = ui.safe;
      const r = rect(s0 * kx, s1 * ky, s2 * kx, s3 * ky);
      g.strokeStyle = COLORS.textSafe;
      g.setLineDash([6, 4]);
      g.strokeRect(...r);
      g.setLineDash([]);
      g.fillStyle = COLORS.textSafe;
      g.fillText("Safe for text", r[0] + 6, r[1] + r[3] - 6);
    }

    // Grid, inside the frame.
    if (overlays[Overlay.Grid]) {
      g.save();
      g.beginPath();
      g.rect(fx0, fy0, fx1 - fx0, fy1 - fy0);
      g.clip();
      g.lineWidth = 1;
      const sub = GRID_PX / GRID_SUB;
      for (const [step, color] of [
        [sub, COLORS.gridSub],
        [GRID_PX, COLORS.grid],
      ] as const) {
        if (step * v.k < 6) continue;
        g.strokeStyle = color;
        for (let x = step; x < v.sw; x += step) line(v.toStage([x, 0]), v.toStage([x, v.sh]));
        for (let y = step; y < v.sh; y += step) line(v.toStage([0, y]), v.toStage([v.sw, y]));
      }
      g.restore();
    }

    // Title/action safe (AE: 80% and 90%) with the center cross.
    if (overlays[Overlay.Safe]) {
      g.strokeStyle = COLORS.safe;
      g.lineWidth = 1;
      for (const m of [0.05, 0.1]) g.strokeRect(...rect(v.sw * m, v.sh * m, v.sw * (1 - m), v.sh * (1 - m)));
      const c0 = v.toStage([v.sw / 2, v.sh / 2]);
      line([c0[0] - 10, c0[1]], [c0[0] + 10, c0[1]]);
      line([c0[0], c0[1] - 10], [c0[0], c0[1] + 10]);
    }

    // Guides cross the whole stage.
    g.lineWidth = 1;
    g.strokeStyle = COLORS.guide;
    if (overlays[Overlay.Guides]) {
      for (const x of guides.x) line([v.toStage([x, 0])[0], 0], [v.toStage([x, 0])[0], ch]);
      for (const y of guides.y) line([0, v.toStage([0, y])[1]], [cw, v.toStage([0, y])[1]]);
    }
    if (live.guide) {
      g.setLineDash([5, 3]);
      const p = v.toStage(live.guide.axis === "x" ? [live.guide.at, 0] : [0, live.guide.at]);
      if (live.guide.axis === "x") line([p[0], 0], [p[0], ch]);
      else line([0, p[1]], [cw, p[1]]);
      g.setLineDash([]);
    }

    // Selection: each layer's box in its label color, handles on the gizmo box, the anchor.
    const poly = (pts: Vec[]) => {
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
      g.closePath();
      g.stroke();
    };
    for (const f of frames) {
      g.strokeStyle = labelColor({ type: String(f.layer.type), camera: f.layer.camera });
      g.lineWidth = 1;
      poly(corners(f.box).map(v.toStage));
    }
    const giz = model.current.gizmo;
    if (giz && (tool === Tool.Select || tool === Tool.Rotate || tool === Tool.PanBehind)) {
      const color = frames.length === 1 ? labelColor({ type: String(frames[0]!.layer.type), camera: frames[0]!.layer.camera }) : AE.blue;
      if (frames.length > 1) {
        g.strokeStyle = color;
        poly(corners(giz).map(v.toStage));
      }
      if (tool === Tool.Select)
        for (const [sx, sy] of handles(giz, v)) {
          const p = v.toStage(boxPoint(giz, sx, sy));
          g.fillStyle = color;
          g.strokeStyle = "#111";
          g.fillRect(p[0] - 3.5, p[1] - 3.5, 7, 7);
          g.strokeRect(p[0] - 3.5, p[1] - 3.5, 7, 7);
        }
      const primary = frames[0];
      if (primary) {
        const a = v.toStage(primary.anchor);
        g.lineWidth = 3;
        g.strokeStyle = "rgba(0,0,0,0.7)";
        drawAnchor(g, a);
        g.lineWidth = 1;
        g.strokeStyle = "#fff";
        drawAnchor(g, a);
      }
    }

    // Snap lines.
    g.strokeStyle = COLORS.snap;
    g.lineWidth = 1;
    if (live.snap.x !== undefined) line([v.toStage([live.snap.x, 0])[0], 0], [v.toStage([live.snap.x, 0])[0], ch]);
    if (live.snap.y !== undefined) line([0, v.toStage([0, live.snap.y])[1]], [cw, v.toStage([0, live.snap.y])[1]]);

    // Marquee, the shape being drawn, the pen path.
    if (live.marquee) {
      const [a, b] = live.marquee;
      g.fillStyle = COLORS.marquee;
      g.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      g.strokeStyle = AE.blue;
      g.setLineDash([4, 3]);
      g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      g.setLineDash([]);
    }
    if (live.shape) {
      const [a, b] = live.shape.map(v.toStage) as [Vec, Vec];
      g.strokeStyle = AE.blue;
      g.lineWidth = 1.5;
      const ellipse = useViewer.getState().shape !== "rect" && useViewer.getState().shape !== "round_rect";
      g.beginPath();
      if (ellipse) g.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
      else g.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      g.stroke();
    }
    if (live.pen.length) {
      g.strokeStyle = AE.blue;
      g.lineWidth = 1.5;
      g.beginPath();
      live.pen.forEach((q, i) => {
        const p = v.toStage(q.p);
        if (!i) return g.moveTo(p[0], p[1]);
        const prev = live.pen[i - 1]!;
        const h1 = v.toStage(prev.hout ?? prev.p);
        const h2 = v.toStage(q.hin ?? q.p);
        g.bezierCurveTo(h1[0], h1[1], h2[0], h2[1], p[0], p[1]);
      });
      if (live.penHover) {
        const h = v.toStage(live.penHover);
        g.lineTo(h[0], h[1]);
      }
      g.stroke();
      live.pen.forEach((q, i) => {
        const p = v.toStage(q.p);
        g.fillStyle = i ? "#fff" : AE.blue;
        g.fillRect(p[0] - 3, p[1] - 3, 6, 6);
        for (const h of [q.hin, q.hout]) {
          if (!h) continue;
          const hp = v.toStage(h);
          g.strokeStyle = "rgba(255,255,255,0.6)";
          line(p, hp);
          g.beginPath();
          g.arc(hp[0], hp[1], 2.5, 0, Math.PI * 2);
          g.fill();
        }
      });
    }
  }

  // ── pointer ─────────────────────────────────────────────────────────

  /** Handles worth showing: sides only when the box is big enough to tell them apart. */
  function handles(b: Box, v: View): [number, number][] {
    const big = Math.min(b.w, b.h) * v.k > 28;
    const out: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    if (big)
      out.push(
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      );
    return out;
  }

  /** What the select tool would grab at stage point `s`. */
  function zoneAt(v: View, s: Vec): { handle?: [number, number]; rotate?: boolean; guide?: "x" | "y" } {
    const giz = model.current.gizmo;
    if (giz) {
      for (const [sx, sy] of handles(giz, v)) {
        const p = v.toStage(boxPoint(giz, sx, sy));
        if (Math.hypot(p[0] - s[0], p[1] - s[1]) <= HANDLE_PX) return { handle: [sx, sy] };
      }
      const [lu, lv] = local(giz, sub(s, v.toStage([0, 0])).map((n) => n / v.k) as Vec);
      const outside = Math.abs(lu) > giz.w / 2 || Math.abs(lv) > giz.h / 2;
      if (outside)
        for (const p of corners(giz).map(v.toStage))
          if (Math.hypot(p[0] - s[0], p[1] - s[1]) <= ROTATE_PX) return { rotate: true };
    }
    const { overlays, guides } = useViewer.getState();
    if (overlays[Overlay.Guides]) {
      if (guides.x.some((x) => Math.abs(v.toStage([x, 0])[0] - s[0]) <= GUIDE_HIT_PX)) return { guide: "x" };
      if (guides.y.some((y) => Math.abs(v.toStage([0, y])[1] - s[1]) <= GUIDE_HIT_PX)) return { guide: "y" };
    }
    return {};
  }

  function cursorAt(e: { clientX: number; clientY: number; altKey: boolean } | null) {
    const t = useViewer.getState().tool;
    if (hold.space || t === Tool.Hand) return "grab";
    if (t === Tool.Zoom) return e?.altKey ? "zoom-out" : "zoom-in";
    if (t === Tool.Shape || t === Tool.Pen) return "crosshair";
    if (t === Tool.Type) return "text";
    if (t === Tool.Rotate) return ROTATE_CURSOR;
    if (t === Tool.PanBehind) return "move";
    const c = canvas.current;
    if (!e || !c) return "default";
    const v = viewOf(c);
    const s: Vec = [e.clientX - v.sr.left, e.clientY - v.sr.top];
    const z = zoneAt(v, s);
    if (z.rotate) return ROTATE_CURSOR;
    if (z.guide) return z.guide === "x" ? "col-resize" : "row-resize";
    if (z.handle && model.current.gizmo) {
      const g = model.current.gizmo;
      const dir = sub(boxPoint(g, z.handle[0], z.handle[1]), [g.cx, g.cy]);
      const a = ((Math.atan2(dir[1], dir[0]) * 180) / Math.PI + 360) % 180;
      return a < 22.5 || a >= 157.5 ? "ew-resize" : a < 67.5 ? "nwse-resize" : a < 112.5 ? "ns-resize" : "nesw-resize";
    }
    return "default";
  }

  const lastPointer = useRef<{ clientX: number; clientY: number; altKey: boolean } | null>(null);
  refreshCursor = () => {
    if (root.current) root.current.style.cursor = cursorAt(lastPointer.current);
  };

  function finishPen(closed: boolean) {
    const pts = live.pen;
    live.pen = [];
    live.penHover = null;
    invalidate();
    if (pts.length < 2) return;
    const { op, id } = penLayerOp(pts, closed);
    run([op], `Draws ${id}`);
    setSelection([id]);
  }

  /** Window-level drag helper: `move` gets the client delta once past the threshold. */
  function track(e: React.PointerEvent, move: (ev: PointerEvent, moved: boolean) => void, up: (ev: PointerEvent, moved: boolean) => void) {
    const [x0, y0] = [e.clientX, e.clientY];
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_PX) return;
      moved = true;
      move(ev, moved);
      invalidate();
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      up(ev, moved);
      live.snap = {};
      invalidate();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function onPointerDown(e: React.PointerEvent) {
    const c = canvas.current;
    if (!c || (e.button !== 0 && e.button !== 1)) return;
    e.preventDefault();
    root.current?.focus({ preventScroll: true });
    const v = viewOf(c);
    if (!(v.k > 0)) return;
    const { tool: t, guides, overlays } = useViewer.getState();
    const p0 = v.toScene(e.clientX, e.clientY);
    const s0: Vec = [e.clientX - v.sr.left, e.clientY - v.sr.top];

    // Hand (tool, Space or middle button): pan, from the fit position when fitting.
    if (e.button === 1 || hold.space || t === Tool.Hand) {
      if (useViewer.getState().zoom === null) useViewer.setState({ zoom: v.k, pan: [0, 0] });
      const pan0 = useViewer.getState().pan;
      hold.panned = true;
      if (root.current) root.current.style.cursor = "grabbing";
      return track(
        e,
        (ev) => useViewer.setState({ pan: [pan0[0] + ev.clientX - e.clientX, pan0[1] + ev.clientY - e.clientY] }),
        () => refreshCursor(),
      );
    }
    if (t === Tool.Zoom) return zoomTo(c, stepZoom(currentScale(c), e.altKey ? -1 : 1), [e.clientX, e.clientY]);
    if (t === Tool.Shape) return drawShape(e, v, p0);
    if (t === Tool.Pen) return penDown(e, v, p0);
    if (t === Tool.Type) {
      const hit = stack(p0).find((h) => engineHost.layer(h.id)?.type === "text");
      return void setTimeout(() => (hit ? editText(hit.id) : setEdit({ id: null, at: p0, text: "", size: TEXT_SIZE, box: null })));
    }

    const zone = t === Tool.Select ? zoneAt(v, s0) : {};
    if (zone.handle) return scaleDrag(e, v, p0, zone.handle);
    if (zone.rotate) return rotateDrag(e, p0);
    if (zone.guide && overlays[Overlay.Guides]) {
      const axis = zone.guide;
      const pos = axis === "x" ? s0[0] : s0[1];
      const at = (n: number) => (axis === "x" ? v.toStage([n, 0])[0] : v.toStage([0, n])[1]);
      const i = guides[axis].findIndex((n) => Math.abs(at(n) - pos) <= GUIDE_HIT_PX);
      setGuides({ ...guides, [axis]: guides[axis].filter((_, j) => j !== i) });
      return dragGuide(c, axis, e);
    }

    const hits = stack(p0);
    const content = hits.filter((h) => !h.cover);
    const front = content[0];
    let sel = selectedIds();
    if (t === Tool.Rotate || t === Tool.PanBehind) {
      if (front && !sel.includes(front.id)) setSelection((sel = [front.id]));
      if (!sel.length) return;
      return t === Tool.Rotate ? rotateDrag(e, p0) : anchorDrag(e, v, p0);
    }
    if (front) {
      let only: string | null = null;
      if (e.shiftKey) {
        if (sel.includes(front.id)) return setSelection(sel.filter((id) => id !== front.id));
        setSelection((sel = [...sel, front.id]));
      } else if (!sel.includes(front.id)) setSelection((sel = [front.id]));
      else only = front.id;
      return moveDrag(e, v, p0, sel, only);
    }
    const giz = model.current.gizmo;
    if (giz && sel.length) {
      const [lu, lv] = local(giz, p0);
      if (Math.abs(lu) <= giz.w / 2 && Math.abs(lv) <= giz.h / 2) return moveDrag(e, v, p0, sel, null);
    }
    marquee(e, v, s0, hits[0]?.id ?? null);
  }

  function moveDrag(e: React.PointerEvent, v: View, p0: Vec, ids: string[], only: string | null) {
    const base = measureAll(ids);
    if (!base.length) return;
    const u = unionBox(base.map((f) => f.box))!;
    const { guides, overlays } = useViewer.getState();
    const targets: SnapTargets | null = overlays[Overlay.Snap] ? snapTargets(new Set(ids), overlays[Overlay.Guides] ? guides : { x: [], y: [] }) : null;
    let last: Op[] = [];
    track(
      e,
      (ev) => {
        let d = sub(v.toScene(ev.clientX, ev.clientY), p0);
        // Shift keeps the move horizontal or vertical.
        if (ev.shiftKey) d = Math.abs(d[0]) > Math.abs(d[1]) ? [d[0], 0] : [0, d[1]];
        live.snap = {};
        if (targets && !(ev.metaKey || ev.ctrlKey)) {
          const reach = SNAP_PX / v.k;
          const sx = snapAxis([u.cx - u.w / 2 + d[0], u.cx + d[0], u.cx + u.w / 2 + d[0]], targets.x, reach);
          const sy = snapAxis([u.cy - u.h / 2 + d[1], u.cy + d[1], u.cy + u.h / 2 + d[1]], targets.y, reach);
          if (sx && !(ev.shiftKey && d[0] === 0)) (d = [d[0] + sx.d, d[1]]), (live.snap.x = sx.at);
          if (sy && !(ev.shiftKey && d[1] === 0)) (d = [d[0], d[1] + sy.d]), (live.snap.y = sy.at);
        }
        preview((last = moveOps(base, d)));
      },
      (_, moved) => {
        if (moved && last.length) return commit(`Moves ${nameOf(ids)}`);
        if (!moved && only) setSelection([only]);
      },
    );
  }

  function scaleDrag(e: React.PointerEvent, v: View, p0: Vec, [sx, sy]: [number, number]) {
    const base = measureAll(selectedIds());
    const g = base.length === 1 ? base[0]!.box : unionBox(base.map((f) => f.box));
    if (!g) return;
    const single = base.length === 1 ? base[0]! : null;
    const [u, w] = axes(g);
    const h0 = boxPoint(g, sx, sy);
    const { guides, overlays } = useViewer.getState();
    const targets = overlays[Overlay.Snap] ? snapTargets(new Set(base.map((f) => f.id)), overlays[Overlay.Guides] ? guides : { x: [], y: [] }) : null;
    const straight = Math.abs(Math.sin(2 * g.rot)) < 1e-3;
    let last: Op[] = [];
    track(
      e,
      (ev) => {
        let d = sub(v.toScene(ev.clientX, ev.clientY), p0);
        live.snap = {};
        if (targets && straight && !(ev.metaKey || ev.ctrlKey)) {
          const h = add(h0, d);
          const reach = SNAP_PX / v.k;
          const tx = sx ? snapAxis([h[0]], targets.x, reach) : null;
          const ty = sy ? snapAxis([h[1]], targets.y, reach) : null;
          if (tx) (d = [d[0] + tx.d, d[1]]), (live.snap.x = tx.at);
          if (ty) (d = [d[0], d[1] + ty.d]), (live.snap.y = ty.at);
        }
        const byAnchor = ev.altKey;
        const origin: Vec = byAnchor ? (single ? single.anchor : [g.cx, g.cy]) : boxPoint(g, -sx, -sy);
        const reach0 = sub(h0, origin);
        const [hu, hv] = [dot(reach0, u), dot(reach0, w)];
        let fu = sx && Math.abs(hu) > 1e-3 ? (hu + dot(d, u)) / hu : 1;
        let fv = sy && Math.abs(hv) > 1e-3 ? (hv + dot(d, w)) / hv : 1;
        const uniform = single && (single.kind === "uniform" || (single.kind === "text" && sx !== 0 && sy !== 0));
        if (ev.shiftKey || uniform) {
          const f = sx && sy ? dot(add(reach0, d), reach0) / Math.max(1e-6, dot(reach0, reach0)) : sx ? fu : fv;
          fu = fv = f;
        }
        fu = Math.max(0.01, fu);
        fv = Math.max(0.01, fv);
        preview((last = scaleOps(base, g, fu, fv, origin, byAnchor && !!single)));
      },
      (_, moved) => moved && last.length && commit(`Scales ${nameOf(base.map((f) => f.id))}`),
    );
  }

  function rotateDrag(e: React.PointerEvent, p0: Vec) {
    const base = measureAll(selectedIds());
    const g = base.length === 1 ? null : unionBox(base.map((f) => f.box));
    const center: Vec = base.length === 1 ? base[0]!.anchor : g ? [g.cx, g.cy] : p0;
    const a0 = Math.atan2(p0[1] - center[1], p0[0] - center[0]);
    const c = canvas.current!;
    let last: Op[] = [];
    track(
      e,
      (ev) => {
        const p = viewOf(c).toScene(ev.clientX, ev.clientY);
        let deg = ((Math.atan2(p[1] - center[1], p[0] - center[0]) - a0) * 180) / Math.PI;
        deg = ((deg + 540) % 360) - 180;
        preview((last = rotateOps(base, deg, ev.shiftKey)));
      },
      (_, moved) => moved && last.length && commit(`Rotates ${nameOf(base.map((f) => f.id))}`),
    );
  }

  function anchorDrag(e: React.PointerEvent, v: View, p0: Vec) {
    const f = measureAll(selectedIds().slice(0, 1))[0];
    if (!f) return;
    const points = [-1, 0, 1].flatMap((sx) => [-1, 0, 1].map((sy) => boxPoint(f.box, sx, sy)));
    let last: Op[] = [];
    track(
      e,
      (ev) => {
        let to = add(f.anchor, sub(v.toScene(ev.clientX, ev.clientY), p0));
        // Snaps to the box's corners, edge middles and center (⌘ to place freely).
        if (!(ev.metaKey || ev.ctrlKey)) {
          const near = points.find((p) => Math.hypot(p[0] - to[0], p[1] - to[1]) * v.k <= SNAP_PX);
          if (near) to = near;
        }
        preview((last = anchorOps(f, to)));
      },
      (_, moved) => moved && last.length && commit(`Moves the anchor point of ${f.id}`),
    );
  }

  function marquee(e: React.PointerEvent, v: View, s0: Vec, under: string | null) {
    const before = selectedIds();
    track(
      e,
      (ev) => {
        live.marquee = [s0, [ev.clientX - v.sr.left, ev.clientY - v.sr.top]];
      },
      (ev, moved) => {
        live.marquee = null;
        if (!moved) {
          // A click on a backdrop selects it; on nothing, clears.
          if (under) return setSelection(ev.shiftKey ? (before.includes(under) ? before.filter((id) => id !== under) : [...before, under]) : [under]);
          if (!ev.shiftKey) setSelection([]);
          return;
        }
        const a = v.toScene(v.sr.left + s0[0], v.sr.top + s0[1]);
        const b = v.toScene(ev.clientX, ev.clientY);
        const [x0, x1, y0, y1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
        const ids = sceneLayers()
          .filter((l) => editable(l.id) && (l as { visible?: boolean }).visible !== false && !isLocked(l.id) && !(l as { camera?: unknown }).camera)
          .filter((l) => {
            const bb = engineHost.layerBounds(l.id);
            const u = bb && unionBox([{ cx: bb[0] ?? 0, cy: bb[1] ?? 0, w: bb[2] ?? 0, h: bb[3] ?? 0, rot: bb[4] ?? 0 }]);
            if (!u) return false;
            const [l0, l1, t0, t1] = [u.cx - u.w / 2, u.cx + u.w / 2, u.cy - u.h / 2, u.cy + u.h / 2];
            if (l1 < x0 || l0 > x1 || t1 < y0 || t0 > y1) return false;
            // Backdrops only when the marquee holds them whole.
            const cover = u.w * u.h >= COVER_SHARE * v.sw * v.sh;
            return !cover || (l0 >= x0 && l1 <= x1 && t0 >= y0 && t1 <= y1);
          })
          .map((l) => l.id)
          .reverse();
        setSelection(ev.shiftKey ? [...before, ...ids.filter((id) => !before.includes(id))] : ids);
      },
    );
  }

  function drawShape(e: React.PointerEvent, v: View, p0: Vec) {
    const kind = useViewer.getState().shape;
    let b: Vec = p0;
    track(
      e,
      (ev) => {
        b = v.toScene(ev.clientX, ev.clientY);
        if (ev.shiftKey) {
          const side = Math.max(Math.abs(b[0] - p0[0]), Math.abs(b[1] - p0[1]));
          b = [p0[0] + Math.sign(b[0] - p0[0] || 1) * side, p0[1] + Math.sign(b[1] - p0[1] || 1) * side];
        }
        live.shape = [p0, b];
      },
      (_, moved) => {
        live.shape = null;
        const [a, z]: [Vec, Vec] = moved ? [p0, b] : [sub(p0, [CLICK_SHAPE / 2, CLICK_SHAPE / 2]), add(p0, [CLICK_SHAPE / 2, CLICK_SHAPE / 2])];
        if (Math.abs(z[0] - a[0]) < 2 || Math.abs(z[1] - a[1]) < 2) return;
        const { op, id } = shapeLayerOp(kind, a, z);
        run([op], `Draws ${id}`);
        setSelection([id]);
      },
    );
  }

  function penDown(e: React.PointerEvent, v: View, p0: Vec) {
    const first = live.pen[0];
    if (first && live.pen.length >= 2 && Math.hypot(first.p[0] - p0[0], first.p[1] - p0[1]) * v.k <= PEN_CLOSE_PX) return finishPen(true);
    const point: PenPoint = { p: p0 };
    live.pen = [...live.pen, point];
    invalidate();
    // Dragging pulls out smooth Bézier handles.
    track(
      e,
      (ev) => {
        const h = v.toScene(ev.clientX, ev.clientY);
        point.hout = h;
        point.hin = sub(mul(p0, 2), h);
      },
      () => {},
    );
  }

  function editText(id: string) {
    const l = engineHost.layer(id);
    const b = engineHost.layerBounds(id);
    if (!l || !b) return;
    const box = unionBox([{ cx: b[0] ?? 0, cy: b[1] ?? 0, w: b[2] ?? 0, h: b[3] ?? 0, rot: b[4] ?? 0 }]);
    setEdit({ id, at: [0, 0], text: String(l.text ?? ""), size: Number(l.size ?? TEXT_SIZE) * (engineHost.propValues(id)?.scale ?? 1), box });
    setSelection([id]);
  }

  function commitText(t: TextEdit) {
    setEdit(null);
    if (t.id) {
      const before = String(engineHost.layer(t.id)?.text ?? "");
      if (t.text.trim() && t.text !== before) run([{ op: OpName.SetText, id: t.id, text: t.text }], `Text of ${t.id}: ${t.text}`);
      return;
    }
    if (!t.text.trim()) return;
    const { op, id } = textLayerOp(t.text, t.at, sceneFont());
    run([op], `Types ${id}: ${t.text}`);
    setSelection([id]);
  }

  // Position of the inline text editor on the stage.
  let editorStyle: React.CSSProperties | undefined;
  const c = canvas.current;
  if (edit && c) {
    const v = viewOf(c);
    const fontSize = Math.max(10, edit.size * v.k);
    if (edit.box) {
      const p = v.toStage([edit.box.cx - edit.box.w / 2, edit.box.cy - edit.box.h / 2]);
      editorStyle = { left: p[0], top: p[1], minWidth: edit.box.w * v.k, minHeight: edit.box.h * v.k, fontSize };
    } else {
      const p = v.toStage(edit.at);
      editorStyle = { left: p[0], top: p[1] - fontSize * 0.9, minWidth: 40, fontSize };
    }
  }

  return (
    <div
      ref={root}
      tabIndex={-1}
      className="absolute inset-0 touch-none outline-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        lastPointer.current = { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey };
        hold.hover = true;
        if (e.buttons === 0) refreshCursor();
        if (live.pen.length && canvas.current) {
          live.penHover = viewOf(canvas.current).toScene(e.clientX, e.clientY);
          invalidate();
        }
      }}
      onPointerLeave={() => {
        hold.hover = false;
        if (live.penHover) (live.penHover = null), invalidate();
      }}
      onDoubleClick={(e) => {
        const cv = canvas.current;
        if (!cv || useViewer.getState().tool !== Tool.Select) return;
        const p = viewOf(cv).toScene(e.clientX, e.clientY);
        const hit = stack(p).find((h) => engineHost.layer(h.id)?.type === "text");
        if (hit) editText(hit.id);
      }}
    >
      <canvas ref={paper} className="pointer-events-none absolute inset-0 size-full" />
      {edit && editorStyle && (
        <textarea
          autoFocus
          value={edit.text}
          placeholder="Type"
          onChange={(e) => setEdit({ ...edit, text: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            // AE: Escape or ⌘Enter commits; Enter is a new line.
            if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
              e.preventDefault();
              commitText(edit);
            }
          }}
          onBlur={() => commitText(edit)}
          style={editorStyle}
          className="absolute z-10 resize-none overflow-hidden rounded-sm bg-black/70 px-1 leading-[1.2] font-semibold whitespace-pre text-white ring-1 ring-[#2d8ceb] outline-none [field-sizing:content]"
        />
      )}
    </div>
  );
}

function drawAnchor(g: CanvasRenderingContext2D, a: Vec) {
  g.beginPath();
  g.arc(a[0], a[1], 5, 0, Math.PI * 2);
  g.moveTo(a[0] - 9, a[1]);
  g.lineTo(a[0] + 9, a[1]);
  g.moveTo(a[0], a[1] - 9);
  g.lineTo(a[0], a[1] + 9);
  g.stroke();
}

/** Nice ruler steps (scene px). */
const RULER_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
const LABEL_GAP_PX = 64;

/** AE rulers along the top and left of the viewer, in scene px; drag out of them to make guides. */
export function Rulers({ canvas }: { canvas: RefObject<HTMLCanvasElement | null> }) {
  const top = useRef<HTMLCanvasElement>(null);
  const left = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const paint = () => {
      const c = canvas.current;
      if (!c) return;
      const v = viewOf(c);
      const dpr = window.devicePixelRatio || 1;
      for (const [el, axis] of [
        [top.current, "x"],
        [left.current, "y"],
      ] as const) {
        if (!el) continue;
        const rr = el.getBoundingClientRect();
        el.width = Math.round(rr.width * dpr);
        el.height = Math.round(rr.height * dpr);
        const g = el.getContext("2d");
        if (!g || !(v.k > 0)) continue;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.fillStyle = AE.panel;
        g.fillRect(0, 0, rr.width, rr.height);
        const step = RULER_STEPS.find((s) => s * v.k >= LABEL_GAP_PX) ?? RULER_STEPS[RULER_STEPS.length - 1]!;
        const minor = step / (step % 5 === 0 ? 5 : 2);
        const origin = axis === "x" ? v.r.left - rr.left : v.r.top - rr.top;
        const length = axis === "x" ? rr.width : rr.height;
        const n0 = Math.floor(-origin / v.k / minor);
        const n1 = Math.ceil((length - origin) / v.k / minor);
        g.strokeStyle = AE.dim;
        g.fillStyle = AE.dim;
        g.font = "9px Inter, system-ui, sans-serif";
        g.lineWidth = 1;
        for (let n = n0; n <= n1; n++) {
          const value = n * minor;
          const pos = Math.round(origin + value * v.k) + 0.5;
          const major = Math.abs(value / step - Math.round(value / step)) < 1e-6;
          const len = major ? RULER_PX : RULER_PX * 0.3;
          g.beginPath();
          if (axis === "x") {
            g.moveTo(pos, RULER_PX);
            g.lineTo(pos, RULER_PX - len);
          } else {
            g.moveTo(RULER_PX, pos);
            g.lineTo(RULER_PX - len, pos);
          }
          g.stroke();
          if (!major) continue;
          if (axis === "x") g.fillText(String(Math.round(value)), pos + 3, 9);
          else {
            g.save();
            g.translate(9, pos + 3);
            g.rotate(-Math.PI / 2);
            g.textAlign = "right";
            g.fillText(String(Math.round(value)), 0, 0);
            g.restore();
          }
        }
      }
    };
    painters.add(paint);
    invalidate();
    return () => void painters.delete(paint);
  }, [canvas]);

  const start = (axis: "x" | "y") => (e: React.PointerEvent) => canvas.current && dragGuide(canvas.current, axis, e);
  return (
    <>
      <span className="absolute top-0 left-0 z-10 bg-[#232323]" style={{ width: RULER_PX, height: RULER_PX }} />
      <canvas
        ref={top}
        onPointerDown={start("y")}
        title="Drag down to add a horizontal guide"
        className="absolute top-0 right-0 z-10 cursor-row-resize border-b border-[#151515]"
        style={{ left: RULER_PX, height: RULER_PX }}
      />
      <canvas
        ref={left}
        onPointerDown={start("x")}
        title="Drag right to add a vertical guide"
        className="absolute bottom-0 left-0 z-10 cursor-col-resize border-r border-[#151515]"
        style={{ top: RULER_PX, width: RULER_PX }}
      />
    </>
  );
}

export { RULER_PX };
