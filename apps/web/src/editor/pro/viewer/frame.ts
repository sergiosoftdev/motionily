import { OpName, type Op } from "@motionily/protocol";
import { shift, type Animated } from "../../../editing/direct";
import { sceneLayers } from "../../../editing/groups";
import { engineHost } from "../../../engine/host";
import { useEditor } from "../../../store";
import { isExpr, setAt, setProp, type Anim } from "../keys";
import { ShapeKind } from "./state";

/**
 * Geometry for the on-canvas gizmos: where a layer is on screen, how screen motion maps back to
 * its own x/y/scale/rotation/pivot, and the ops (the same ones Claude sends) that make each edit.
 */

export type Vec = [number, number];
/** An oriented box on screen, in scene px; `rot` in radians. */
export type Box = { cx: number; cy: number; w: number; h: number; rot: number };

/** How a layer's handles resize it. */
export const ResizeKind = {
  /** Shapes, images, videos, shaders, objects: the box (w/h) changes. */
  Box: "box",
  /** Text: sides change the text box, corners the scale. */
  Text: "text",
  /** Paths, instances, particles, characters: uniform scale. */
  Uniform: "uniform",
} as const;
export type ResizeKind = (typeof ResizeKind)[keyof typeof ResizeKind];

const BOX_TYPES = new Set(["shape", "image", "video", "shader", "object"]);

/** A selected layer measured at the current time. */
export type Frame = {
  id: string;
  layer: Record<string, unknown>;
  /** Sampled numbers now (x, y, w, h, scale, rotation…). */
  v: Record<string, number>;
  box: Box;
  /** Parent space → screen, as columns: screen Δ = [a·dx + c·dy, b·dx + d·dy]. */
  j: [number, number, number, number];
  /** The anchor point (pivot) on screen. */
  anchor: Vec;
  pivot: Vec;
  kind: ResizeKind;
};

export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
export const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k];
export const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1];
export const rot = (p: Vec, a: number): Vec => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
const DEG = Math.PI / 180;

/** Screen Δ → parent-space Δ. */
export function unmap(j: Frame["j"], d: Vec): Vec {
  const [a, b, c, e] = j;
  const det = a * e - c * b;
  if (Math.abs(det) < 1e-9) return [0, 0];
  return [(e * d[0] - c * d[1]) / det, (-b * d[0] + a * d[1]) / det];
}
const mapVec = (j: Frame["j"], p: Vec): Vec => [j[0] * p[0] + j[2] * p[1], j[1] * p[0] + j[3] * p[1]];

/** Unit axes of a box on screen. */
export const axes = (b: Box): [Vec, Vec] => [
  [Math.cos(b.rot), Math.sin(b.rot)],
  [-Math.sin(b.rot), Math.cos(b.rot)],
];
/** Point of a box at handle signs (sx, sy) ∈ {-1, 0, 1}. */
export function boxPoint(b: Box, sx: number, sy: number): Vec {
  const [u, v] = axes(b);
  return add([b.cx, b.cy], add(mul(u, (sx * b.w) / 2), mul(v, (sy * b.h) / 2)));
}
export function corners(b: Box): Vec[] {
  return [boxPoint(b, -1, -1), boxPoint(b, 1, -1), boxPoint(b, 1, 1), boxPoint(b, -1, 1)];
}
/** Axis-aligned box around oriented ones. */
export function unionBox(boxes: Box[]): Box | null {
  const pts = boxes.flatMap(corners);
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, rot: 0 };
}

const toBox = (b: number[]): Box => ({ cx: b[0] ?? 0, cy: b[1] ?? 0, w: b[2] ?? 0, h: b[3] ?? 0, rot: b[4] ?? 0 });

type RawEngine = { applyOps(json: string): void; layerBounds(id: string, t: number): Float32Array | undefined };
/**
 * The engine itself, to measure a layer by nudging it and putting it back in one synchronous
 * step: nothing renders, saves or reaches the agent in between. A stopgap until the engine
 * exposes a layer's screen transform; without it the gizmos assume no parent or camera.
 */
function rawEngine(): RawEngine | null {
  const e = (engineHost as unknown as { engine?: RawEngine | null }).engine;
  return e && typeof e.applyOps === "function" ? e : null;
}

/** Probe distance in parent px. */
const PROBE = 100;

/** Where layer `id` is now and how its x/y and scale move it on screen (parents, camera and all). */
export function measure(id: string): Frame | null {
  const layer = engineHost.layer(id);
  const v = engineHost.propValues(id);
  const b = engineHost.layerBounds(id);
  if (!layer || !v || !b) return null;
  const box = toBox(b);
  const pivot = (Array.isArray(layer.pivot) ? layer.pivot : [0, 0]) as Vec;
  const kind = BOX_TYPES.has(String(layer.type)) ? ResizeKind.Box : layer.type === "text" ? ResizeKind.Text : ResizeKind.Uniform;
  const s = v.scale ?? 1;
  const r = (v.rotation ?? 0) * DEG;
  // Without probing: flat, unparented.
  let j: Frame["j"] = [1, 0, 0, 1];
  let anchor = add([box.cx, box.cy], rot(mul(pivot, s), r));
  const e = rawEngine();
  if (e) {
    const t = useEditor.getState().time;
    const fixed = (prop: string, value: number) => setProp(id, prop, value);
    const at = (ops: Op[]): Vec | null => {
      e.applyOps(JSON.stringify(ops));
      const q = e.layerBounds(id, t);
      return q ? [q[0] ?? 0, q[1] ?? 0] : null;
    };
    try {
      const c0 = at([fixed("x", v.x ?? 0), fixed("y", v.y ?? 0)]);
      const cx = at([fixed("x", (v.x ?? 0) + PROBE)]);
      const cy = at([fixed("x", v.x ?? 0), fixed("y", (v.y ?? 0) + PROBE)]);
      const s1 = at([fixed("y", v.y ?? 0), fixed("scale", 1)]);
      const s2 = at([fixed("scale", 2)]);
      if (c0 && cx && cy) j = [(cx[0] - c0[0]) / PROBE, (cx[1] - c0[1]) / PROBE, (cy[0] - c0[0]) / PROBE, (cy[1] - c0[1]) / PROBE];
      // Scaling about the anchor moves everything linearly: anchor = 2·c(1) − c(2).
      if (s1 && s2) anchor = sub(mul(s1, 2), s2);
    } catch {
      // Leave the flat estimate.
    } finally {
      try {
        e.applyOps(JSON.stringify([setProp(id, "x", (layer.x as Anim) ?? 0), setProp(id, "y", (layer.y as Anim) ?? 0), setProp(id, "scale", (layer.scale as Anim) ?? 1)]));
      } catch {
        // The original values were valid a moment ago.
      }
    }
  }
  return { id, layer, v, box, j, anchor, pivot, kind };
}

/** Top-level layers only (component internals are edited through their instance). */
export const editable = (id: string) => !id.includes("/");

export function isLocked(id: string) {
  return engineHost.layer(id)?.locked === true;
}

// ── ops ────────────────────────────────────────────────────────────────

const fps = () => {
  const f = (JSON.parse(engineHost.sceneJson()) as { fps?: number }).fps;
  return f ?? 30;
};

/** `prop` = `value` now: a key at the current time when animated, the value otherwise; formulas stay. */
function setNow(f: Frame, prop: string, value: number, rate: number): Op | null {
  const a = f.layer[prop] as Anim | undefined;
  if (isExpr(a)) return null;
  const lt = useEditor.getState().time - ((f.layer.start as number | undefined) ?? 0);
  return setProp(f.id, prop, setAt(a, lt, value, rate));
}

const compact = (ops: (Op | null)[]): Op[] => ops.filter((o): o is Op => o !== null);

/** Move by a screen delta. */
export function moveOps(frames: Frame[], d: Vec): Op[] {
  const rate = fps();
  return frames.flatMap((f) => {
    const p = unmap(f.j, d);
    return compact([setNow(f, "x", (f.v.x ?? 0) + p[0], rate), setNow(f, "y", (f.v.y ?? 0) + p[1], rate)]);
  });
}

/** Nudge by parent px (arrow keys). */
export function nudgeOps(frames: Frame[], d: Vec): Op[] {
  const rate = fps();
  return frames.flatMap((f) => compact([setNow(f, "x", (f.v.x ?? 0) + d[0], rate), setNow(f, "y", (f.v.y ?? 0) + d[1], rate)]));
}

/** Rotate each layer about its own anchor by `deg` on screen (snapped to 45° steps with `snap`). */
export function rotateOps(frames: Frame[], deg: number, snap: boolean): Op[] {
  const rate = fps();
  return compact(
    frames.map((f) => {
      const mirrored = f.j[0] * f.j[3] - f.j[2] * f.j[1] < 0;
      let r = (f.v.rotation ?? 0) + (mirrored ? -deg : deg);
      if (snap) r = Math.round(r / 45) * 45;
      return setNow(f, "rotation", r, rate);
    }),
  );
}

/**
 * Scale the selection: `gizmo` is the box the handles sit on, (fu, fv) the factors along its axes,
 * `origin` the screen point that stays put (opposite handle, or the anchor with Alt).
 * `byAnchor` (Alt on one layer) keeps that layer's anchor and scales the box around it.
 */
export function scaleOps(frames: Frame[], gizmo: Box, fu: number, fv: number, origin: Vec, byAnchor: boolean): Op[] {
  const rate = fps();
  const [u, v] = axes(gizmo);
  const around = (p: Vec, o: Vec, a: number, b: number): Vec => {
    const q = sub(p, o);
    return add(o, add(mul(u, dot(q, u) * a), mul(v, dot(q, v) * b)));
  };
  return frames.flatMap((f) => {
    const c: Vec = [f.box.cx, f.box.cy];
    const delta = (f.box.rot - gizmo.rot) / (Math.PI / 2);
    const aligned = Math.abs(delta - Math.round(delta)) < 0.01;
    const swap = aligned && Math.abs(Math.round(delta)) % 2 === 1;
    const uniformF = Math.sqrt(Math.abs(fu * fv));
    const sides = f.kind === ResizeKind.Box || (f.kind === ResizeKind.Text && (fu === 1 || fv === 1) && fu !== fv);
    if (sides && aligned) {
      const [fx, fy] = swap ? [fv, fu] : [fu, fv];
      const ops: (Op | null)[] = [setNow(f, "w", (f.v.w ?? 0) * fx, rate), setNow(f, "h", (f.v.h ?? 0) * fy, rate)];
      if (byAnchor && frames.length === 1) {
        // The anchor stays where it is on screen and keeps its place in the box.
        if (f.pivot[0] || f.pivot[1]) {
          const p2: Vec = [f.pivot[0] * fx, f.pivot[1] * fy];
          ops.push({ op: OpName.Patch, id: f.id, fields: { pivot: p2 } });
          ops.push(setNow(f, "x", (f.v.x ?? 0) + f.pivot[0] - p2[0], rate), setNow(f, "y", (f.v.y ?? 0) + f.pivot[1] - p2[1], rate));
        }
        return compact(ops);
      }
      // A new size keeps the box centered where it was: slide it so `origin` stays.
      const t = unmap(f.j, sub(around(c, origin, fu, fv), c));
      return compact([...ops, setNow(f, "x", (f.v.x ?? 0) + t[0], rate), setNow(f, "y", (f.v.y ?? 0) + t[1], rate)]);
    }
    // Uniform: scale grows about the layer's anchor, then slide so `origin` stays.
    const k = frames.length === 1 && fu === fv ? fu : uniformF;
    const ops: (Op | null)[] = [setNow(f, "scale", (f.v.scale ?? 1) * k, rate)];
    if (byAnchor && frames.length === 1) return compact(ops);
    const grown = add(f.anchor, mul(sub(c, f.anchor), k));
    const t = unmap(f.j, sub(around(c, origin, fu === fv ? k : fu, fu === fv ? k : fv), grown));
    return compact([...ops, setNow(f, "x", (f.v.x ?? 0) + t[0], rate), setNow(f, "y", (f.v.y ?? 0) + t[1], rate)]);
  });
}

/**
 * Pan Behind: the anchor moves to screen point `to` and x/y compensate so the layer stays put.
 * The pivot is one value for the whole layer, so x/y shift as a whole (every key).
 */
export function anchorOps(f: Frame, to: Vec): Op[] {
  const s = f.v.scale ?? 1;
  if (Math.abs(s) < 1e-4 || isExpr(f.layer.x) || isExpr(f.layer.y)) return [];
  const r = (f.v.rotation ?? 0) * DEG;
  const dq = mul(rot(unmap(f.j, sub(to, f.anchor)), -r), 1 / s);
  const p2 = add(f.pivot, dq);
  const comp = add(mul(dq, -1), rot(mul(dq, s), r));
  return [
    { op: OpName.Patch, id: f.id, fields: { pivot: Math.hypot(p2[0], p2[1]) < 1e-3 ? null : p2 } },
    setProp(f.id, "x", shift(f.layer.x as Animated, comp[0])),
    setProp(f.id, "y", shift(f.layer.y as Animated, comp[1])),
  ];
}

// ── new layers (shape, pen and type tools) ──────────────────────────────

/** Default look of drawn layers: palette slots, so they follow the video's colors. */
const SHAPE_FILL = "primary";
const TEXT_FILL = "text";
const LINE_COLOR = "text";
const LINE_WIDTH = 8;
const ROUND_SHARE = 0.15;
const POLYGON_SIDES = 5;
const STAR_POINTS = 5;
const STAR_INNER = 0.5;

/** First free id like `rect1`, `rect2`… */
export function freeId(prefix: string): string {
  const taken = new Set(sceneLayers().map((l) => l.id));
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Polygon or star points around (0, 0) inside a w×h box, starting at the top. */
function ring(count: number, w: number, h: number, inner: number | null): Vec[] {
  const pts: Vec[] = [];
  const n = inner === null ? count : count * 2;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const k = inner !== null && i % 2 === 1 ? inner : 1;
    pts.push([r1((Math.cos(a) * w * k) / 2), r1((Math.sin(a) * h * k) / 2)]);
  }
  return pts;
}

const polyline = (pts: Vec[]) => pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" ") + " Z";

/** add_layer for a shape drawn over the scene box (x0, y0)-(x1, y1). */
export function shapeLayerOp(kind: ShapeKind, a: Vec, b: Vec): { op: Op; id: string } {
  const [x, y] = [r1((a[0] + b[0]) / 2), r1((a[1] + b[1]) / 2)];
  const [w, h] = [r1(Math.abs(b[0] - a[0])), r1(Math.abs(b[1] - a[1]))];
  const base = { start: 0, x, y, fill: SHAPE_FILL };
  let layer: Record<string, unknown>;
  if (kind === ShapeKind.Polygon || kind === ShapeKind.Star) {
    const d = polyline(kind === ShapeKind.Star ? ring(STAR_POINTS, w, h, STAR_INNER) : ring(POLYGON_SIDES, w, h, null));
    layer = { ...base, id: freeId(kind), type: "path", d, filled: true };
  } else {
    const shape = kind === ShapeKind.Ellipse ? "ellipse" : "rect";
    layer = { ...base, id: freeId(kind === ShapeKind.Ellipse ? "ellipse" : "rect"), type: "shape", shape, w, h };
    if (kind === ShapeKind.RoundRect) layer.radius = r1(Math.min(w, h) * ROUND_SHARE);
  }
  return { op: { op: OpName.AddLayer, layer }, id: String(layer.id) };
}

/** A pen point: position and optional Bézier handles (scene px). */
export type PenPoint = { p: Vec; hin?: Vec; hout?: Vec };

/** add_layer for a pen path: closed paths are filled, open ones stroked. Path data is relative to its center. */
export function penLayerOp(points: PenPoint[], closed: boolean): { op: Op; id: string } {
  const all = points.flatMap((q) => [q.p, ...(q.hin ? [q.hin] : []), ...(q.hout ? [q.hout] : [])]);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const c: Vec = [r1((Math.min(...xs) + Math.max(...xs)) / 2), r1((Math.min(...ys) + Math.max(...ys)) / 2)];
  const rel = (p: Vec) => `${r1(p[0] - c[0])} ${r1(p[1] - c[1])}`;
  const seg = (from: PenPoint, to: PenPoint) =>
    from.hout || to.hin ? `C${rel(from.hout ?? from.p)} ${rel(to.hin ?? to.p)} ${rel(to.p)}` : `L${rel(to.p)}`;
  let d = `M${rel(points[0]!.p)}`;
  for (let i = 1; i < points.length; i++) d += ` ${seg(points[i - 1]!, points[i]!)}`;
  if (closed) d += ` ${seg(points[points.length - 1]!, points[0]!)} Z`;
  const id = freeId("path");
  const layer: Record<string, unknown> = { id, type: "path", start: 0, x: c[0], y: c[1], d };
  if (closed) Object.assign(layer, { filled: true, fill: SHAPE_FILL });
  else layer.stroke = { width: LINE_WIDTH, color: LINE_COLOR };
  return { op: { op: OpName.AddLayer, layer }, id };
}

/** Default type size for new text (scene px) and its line height. */
export const TEXT_SIZE = 96;
const LINE_HEIGHT = 1.3;
/** The engine widens text boxes below this share of the frame width. */
const MIN_TEXT_SHARE = 0.2;

/** add_layer for text typed at scene point `at` (the first line's baseline starts there). */
export function textLayerOp(text: string, at: Vec, family: string): { op: Op; id: string } {
  const [sw] = engineHost.sceneSize();
  const ctx = document.createElement("canvas").getContext("2d");
  const lines = text.split("\n");
  let widest = text.length * TEXT_SIZE * 0.6;
  if (ctx) {
    ctx.font = `600 ${TEXT_SIZE}px "${family}", Inter, sans-serif`;
    widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  }
  const w = r1(Math.max(widest * 1.12 + TEXT_SIZE * 0.2, sw * MIN_TEXT_SHARE));
  const h = r1(lines.length * TEXT_SIZE * LINE_HEIGHT + TEXT_SIZE * 0.2);
  const top = at[1] - TEXT_SIZE * 0.9;
  const id = freeId("text");
  const layer = { id, type: "text", start: 0, text, size: TEXT_SIZE, align: "left", x: r1(at[0] + w / 2), y: r1(top + h / 2), w, h, fill: TEXT_FILL };
  return { op: { op: OpName.AddLayer, layer }, id };
}

// ── snapping ───────────────────────────────────────────────────────────

/** Lines things snap to, in scene px. */
export type SnapTargets = { x: number[]; y: number[] };

/** Frame center and edges, guides, and the edges and centers of other visible layers now. */
export function snapTargets(exclude: Set<string>, guides: SnapTargets): SnapTargets {
  const [sw, sh] = engineHost.sceneSize();
  const x = [0, sw / 2, sw, ...guides.x];
  const y = [0, sh / 2, sh, ...guides.y];
  for (const l of sceneLayers()) {
    if (exclude.has(l.id)) continue;
    const b = engineHost.layerBounds(l.id);
    if (!b) continue;
    const u = unionBox([toBox(b)]);
    if (!u || u.w * u.h >= sw * sh * 0.9) continue;
    x.push(u.cx - u.w / 2, u.cx, u.cx + u.w / 2);
    y.push(u.cy - u.h / 2, u.cy, u.cy + u.h / 2);
  }
  return { x, y };
}

/** Best correction (≤ `reach`) that puts one of `values` on one of `lines`, and the line hit. */
export function snapAxis(values: number[], lines: number[], reach: number): { d: number; at: number } | null {
  let best: { d: number; at: number } | null = null;
  for (const v of values)
    for (const l of lines) {
      const d = l - v;
      if (Math.abs(d) <= reach && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: l };
    }
  return best;
}

/** Where a vector of the scene's typography lives, for text measuring. */
export function sceneFont(): string {
  const t = (JSON.parse(engineHost.sceneJson()) as { typography?: { family?: string } | null }).typography;
  return t?.family ?? "Inter";
}

export { mapVec };
