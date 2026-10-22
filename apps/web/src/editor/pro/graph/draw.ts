import type { Key } from "../keys";
import { AE } from "../theme";
import { fmt, type Channel } from "./channels";
import { bezierOf, hasBezier, isHold, progress } from "./evaluate";
import { segmentOf, Side } from "./edit";
import { CurveKind, type Curve } from "./sampling";

/** What the graph plots on its vertical axis. */
export const GraphMode = { Value: "value", Speed: "speed" } as const;
export type GraphMode = (typeof GraphMode)[keyof typeof GraphMode];

/** Something under the pointer: a keyframe or one of its bezier handles. */
export const HitKind = { Key: "key", Handle: "handle" } as const;
export type HitKind = (typeof HitKind)[keyof typeof HitKind];
export type Hit = { kind: HitKind; prop: string; index: number; side?: Side; x: number; y: number };

export type Entry = { channel: Channel; keys: Key[] | null; curve: Curve };

/** Vertical mapping of the plot: `lo..hi` (stored units, or units per second) over `top..top+h`. */
export type Plot = { top: number; h: number; lo: number; hi: number };
export const yOf = (p: Plot, v: number) => p.top + ((p.hi - v) / (p.hi - p.lo || 1)) * p.h;
export const vOf = (p: Plot, y: number) => p.hi - ((y - p.top) / p.h) * (p.hi - p.lo || 1);

export type DrawInput = {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  mode: GraphMode;
  entries: Entry[];
  /** Layer start and end, scene seconds (keys are relative to the start). */
  start: number;
  end: number;
  /** Scene time → canvas x. */
  x: (t: number) => number;
  plot: Plot;
  time: number;
  /** Shown-unit factor and unit of the axis labels (shared by every graphed prop, else 1 and ""). */
  factor: number;
  unit: string;
  selected: (prop: string, index: number) => boolean;
  hover: Hit | null;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  empty: string | null;
};

/** AE's selection yellow for keys and handle ends. */
const SELECTED = "#f2d23c";
const GRID = "#2a2a2a";
const ZERO = "#3a3a3a";
const HANDLE_LINE = "#a0a0a0";
const KEY_HALF = 3.5;
const FONT = "10px ui-sans-serif, system-ui, sans-serif";
/** Grid lines at least this far apart (px). */
const MIN_GRID_GAP = 28;

/** Speed leaving (out) or arriving at (in) key `i`, from the exact curve. */
export function sideSpeed(keys: readonly Key[], i: number, side: Side): number | null {
  const s = segmentOf(keys, i, side);
  if (s < 0) return null;
  const a = keys[s]!;
  const b = keys[s + 1]!;
  if (isHold(a)) return 0;
  const dt = b.t - a.t;
  if (dt <= 0) return 0;
  const e = 1e-5;
  const d = side === Side.Out ? (progress(a, e) - progress(a, 0)) / e : (progress(a, 1) - progress(a, 1 - e)) / e;
  return (d * (b.v - a.v)) / dt;
}

/** Influence (0..1) of a side; the speed graph draws the handle that long. */
function sideInfluence(keys: readonly Key[], i: number, side: Side) {
  const s = segmentOf(keys, i, side);
  const b = s >= 0 ? bezierOf(keys[s]!) : null;
  if (!b) return null;
  return side === Side.Out ? b[0] : 1 - b[2];
}

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** Paint the whole graph; returns where keys and handles landed, for hit-testing. */
export function drawGraph(d: DrawInput): Hit[] {
  const { ctx, w, h, mode, plot, x } = d;
  const y = (v: number) => yOf(plot, v);
  const hits: Hit[] = [];
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = AE.field;
  ctx.fillRect(0, 0, w, h);
  // The layer's own span is a shade lighter, like its bar in the timeline.
  const ls = Math.max(0, x(d.start));
  const le = Math.min(w, x(d.end));
  if (le > ls) {
    ctx.fillStyle = "#1f1f1f";
    ctx.fillRect(ls, 0, le - ls, h);
  }

  // Horizontal grid in shown units.
  const step = niceStep((MIN_GRID_GAP / plot.h) * (plot.hi - plot.lo) * d.factor) / d.factor;
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  const labels: [number, string][] = [];
  if (Number.isFinite(step) && step > 0) {
    for (let v = Math.ceil(plot.lo / step) * step, n = 0; v <= plot.hi && n < 200; v += step, n++) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = Math.abs(v) < step / 2 && mode === GraphMode.Speed ? ZERO : GRID;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
      labels.push([yy, `${fmt(v * d.factor)}${d.unit}${mode === GraphMode.Speed ? "/s" : ""}`]);
    }
  }

  // Curves.
  ctx.lineJoin = "round";
  for (const e of d.entries) {
    const c = e.curve;
    ctx.strokeStyle = e.channel.color;
    ctx.lineWidth = c.kind === CurveKind.Keys ? 1.5 : 1;
    ctx.globalAlpha = c.kind === CurveKind.Keys ? 1 : c.kind === CurveKind.Formula ? 0.75 : 0.45;
    ctx.setLineDash(c.kind === CurveKind.Fixed ? [4, 4] : []);
    ctx.beginPath();
    for (const r of c.runs) {
      const ys = mode === GraphMode.Value ? r.v : r.s;
      for (let i = 0; i < r.t.length; i++) {
        const px = x(r.t[i]!);
        const py = y(ys[i]!);
        // Value: one continuous path (a hold's jump is the vertical between runs). Speed breaks at keys.
        if (i === 0 && (mode === GraphMode.Speed || r === c.runs[0])) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
    // Speed: in and out speeds meet at each key with a thin vertical.
    if (mode === GraphMode.Speed && e.keys) {
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      e.keys.forEach((_, i) => {
        const a = sideSpeed(e.keys!, i, Side.In);
        const b = sideSpeed(e.keys!, i, Side.Out);
        if (a === null || b === null) return;
        const px = x(d.start + e.keys![i]!.t);
        ctx.beginPath();
        ctx.moveTo(px, y(a));
        ctx.lineTo(px, y(b));
        ctx.stroke();
      });
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }

  // Handles of selected keys, then the keys.
  for (const e of d.entries) {
    const keys = e.keys;
    if (!keys) continue;
    keys.forEach((k, i) => {
      if (!d.selected(e.channel.prop, i)) return;
      for (const side of [Side.In, Side.Out]) {
        const s = segmentOf(keys, i, side);
        if (s < 0 || isHold(keys[s]!)) continue;
        const a = keys[s]!;
        const b = keys[s + 1]!;
        const Ta = d.start + a.t;
        const dt = b.t - a.t;
        const bz = bezierOf(a)!;
        let kx: number, ky: number, hx: number, hy: number;
        if (mode === GraphMode.Value) {
          kx = x(d.start + k.t);
          ky = y(k.v);
          const [bx, by] = side === Side.Out ? [bz[0], bz[1]] : [bz[2], bz[3]];
          hx = x(Ta + bx * dt);
          hy = y(a.v + by * (b.v - a.v));
        } else {
          const sp = sideSpeed(keys, i, side) ?? 0;
          const infl = sideInfluence(keys, i, side) ?? 0;
          kx = x(d.start + k.t);
          ky = y(sp);
          hx = x(d.start + k.t + (side === Side.Out ? 1 : -1) * infl * dt);
          hy = ky;
        }
        ctx.strokeStyle = HANDLE_LINE;
        ctx.lineWidth = 1;
        // Dashed: a named ease shown as its bezier (dragging turns it into one).
        ctx.setLineDash(hasBezier(a) ? [] : [3, 3]);
        ctx.beginPath();
        ctx.moveTo(kx, ky);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.setLineDash([]);
        const hot = d.hover?.kind === HitKind.Handle && d.hover.prop === e.channel.prop && d.hover.index === i && d.hover.side === side;
        ctx.fillStyle = hot ? "#ffffff" : SELECTED;
        ctx.beginPath();
        ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
        ctx.fill();
        hits.push({ kind: HitKind.Handle, prop: e.channel.prop, index: i, side, x: hx, y: hy });
      }
    });
  }
  for (const e of d.entries) {
    const keys = e.keys;
    if (!keys) continue;
    keys.forEach((k, i) => {
      const kx = x(d.start + k.t);
      const v = mode === GraphMode.Value ? k.v : (sideSpeed(keys, i, Side.Out) ?? sideSpeed(keys, i, Side.In) ?? 0);
      const ky = y(v);
      if (kx < -10 || kx > w + 10) return;
      const sel = d.selected(e.channel.prop, i);
      const hot = d.hover?.kind === HitKind.Key && d.hover.prop === e.channel.prop && d.hover.index === i;
      ctx.fillStyle = sel ? SELECTED : AE.field;
      ctx.strokeStyle = hot ? "#ffffff" : sel ? "#1b1b1b" : e.channel.color;
      ctx.lineWidth = 1.25;
      ctx.fillRect(kx - KEY_HALF, ky - KEY_HALF, KEY_HALF * 2, KEY_HALF * 2);
      ctx.strokeRect(kx - KEY_HALF + 0.5, ky - KEY_HALF + 0.5, KEY_HALF * 2 - 1, KEY_HALF * 2 - 1);
      hits.push({ kind: HitKind.Key, prop: e.channel.prop, index: i, x: kx, y: ky });
    });
  }

  // Axis labels on top, left edge.
  ctx.fillStyle = AE.dim;
  ctx.textAlign = "left";
  for (const [yy, s] of labels) if (yy > 6 && yy < h - 6) ctx.fillText(s, 4, yy - 6);

  // Playhead.
  const px = Math.round(x(d.time)) + 0.5;
  if (px >= 0 && px <= w) {
    ctx.strokeStyle = AE.cti;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }

  if (d.marquee) {
    const m = d.marquee;
    ctx.fillStyle = "rgba(45,140,235,0.12)";
    ctx.strokeStyle = AE.blue;
    ctx.fillRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    ctx.strokeRect(Math.min(m.x0, m.x1) + 0.5, Math.min(m.y0, m.y1) + 0.5, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
  }

  if (d.empty) {
    ctx.fillStyle = AE.dim;
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(d.empty, w / 2, h / 2);
  }
  return hits;
}
