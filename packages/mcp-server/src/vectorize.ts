/**
 * add_vector: an SVG (logo, icon, illustration) as real path layers under one invisible parent, so
 * every piece can be animated like in After Effects (draw on with trim, letters flying in, colors
 * swapping) instead of a flat picture.
 */
import { bounds, pathData, subpaths, type Gradient, type Seg, type Vector, type VectorPart } from "./svg.js";

/** How the SVG is cut into layers. */
export const VectorSplit = {
  /** One layer per run of shapes painted alike (paint order kept). */
  Parts: "parts",
  /** Every separate island (a letter with its counters, a dot) its own layer, left to right. */
  Letters: "letters",
} as const;
export type VectorSplit = (typeof VectorSplit)[keyof typeof VectorSplit];

/** More layers than this and the vector is better as its PNG (image layer). */
export const MAX_VECTOR_LAYERS = 80;
const DEFAULT_WIDTH = 600;

export type VectorOptions = {
  id: string;
  start: number;
  end?: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
  group: string;
  split: VectorSplit;
  /** Recolor every part (palette slot or #hex): one-color logos and icons. */
  color?: string;
  /** Outline every part: `W:COLOR` (draw it on with te=0>1, then fade the fill in). */
  stroke?: string;
};

export type VectorPartInfo = { id: string; paint: string; box: [number, number, number, number] };
export type VectorBuild = { lines: string[]; parts: VectorPartInfo[]; size: [number, number]; warnings: string[] };

const paintKey = (p: VectorPart) => JSON.stringify([p.fill, p.gradient ?? null, p.stroke, p.nonzero]);

function mergeRuns(parts: VectorPart[]): VectorPart[] {
  const out: VectorPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && paintKey(last) === paintKey(p)) last.segs = [...last.segs, ...p.segs];
    else out.push({ ...p, segs: [...p.segs] });
  }
  return out;
}

/** Same paint anywhere = one layer (when there are too many runs; overlaps between colors may reorder). */
function mergeAll(parts: VectorPart[]): VectorPart[] {
  const by = new Map<string, VectorPart>();
  for (const p of parts) {
    const k = paintKey(p);
    const known = by.get(k);
    if (known) known.segs = [...known.segs, ...p.segs];
    else by.set(k, { ...p, segs: [...p.segs] });
  }
  return [...by.values()];
}

/** Signed area of a subpath's polygon (control points as vertices: enough for containment). */
function area(sp: Seg[]) {
  const pts = sp.flatMap((s) => (s.p.length ? [[s.p[s.p.length - 2]!, s.p[s.p.length - 1]!]] : []));
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    a += x0! * y1! - x1! * y0!;
  }
  return Math.abs(a / 2);
}

/** Islands: each outer subpath with the holes directly inside it (an "o" stays one piece). */
function islands(part: VectorPart): VectorPart[] {
  const subs = subpaths(part.segs).map((segs) => ({ segs, box: bounds(segs), area: area(segs) }));
  const inside = (a: (typeof subs)[number], b: (typeof subs)[number]) =>
    a !== b && a.box[0][0] >= b.box[0][0] - 0.01 && a.box[0][1] >= b.box[0][1] - 0.01 && a.box[1][0] <= b.box[1][0] + 0.01 && a.box[1][1] <= b.box[1][1] + 0.01 && a.area < b.area;
  const parent = subs.map((s) => {
    const containers = subs.filter((o) => inside(s, o));
    return { depth: containers.length, direct: containers.sort((p, q) => p.area - q.area)[0] };
  });
  const groups = new Map<(typeof subs)[number], Seg[]>();
  subs.forEach((s, i) => {
    const { depth, direct } = parent[i]!;
    // Even depth = an outline of its own; odd = a hole of the smallest shape around it.
    const owner = depth % 2 === 0 || !direct ? s : direct;
    groups.set(owner, [...(groups.get(owner) ?? []), ...s.segs]);
  });
  return [...groups.entries()].sort((a, b) => a[0].box[0][0] - b[0].box[0][0]).map(([, segs]) => ({ ...part, segs }));
}

const r1 = (v: number) => +v.toFixed(1);

function gradientValue(g: Gradient) {
  const stops = g.stops.map(([p, c]) => `${c}@${+p.toFixed(3)}`).join(",");
  return g.kind === "linear" ? `lin:${g.angle}:${stops}` : `rad:${g.center[0]},${g.center[1]}:${g.radius}:${stops}`;
}

export function vectorLines(v: Vector, o: VectorOptions): VectorBuild {
  const warnings = [...v.warnings];
  let parts = mergeRuns(v.parts.filter((p) => p.segs.length));
  if (!parts.length) throw new Error("nothing drawable in this SVG (use its PNG src in an image layer)");
  if (o.split === VectorSplit.Letters) parts = parts.flatMap(islands);
  if (parts.length > MAX_VECTOR_LAYERS) {
    if (o.split === VectorSplit.Letters) throw new Error(`${parts.length} separate pieces is too many layers (max ${MAX_VECTOR_LAYERS}): use split=parts`);
    parts = mergeAll(parts);
    warnings.push("many shapes: parts with the same paint were merged (stacking between colors may differ from the original)");
    if (parts.length > MAX_VECTOR_LAYERS) throw new Error(`${parts.length} colors is too many layers (max ${MAX_VECTOR_LAYERS}): use the PNG src in an image layer`);
  }
  const all = parts.flatMap((p) => p.segs);
  const [[x0, y0], [x1, y1]] = bounds(all);
  const bw = Math.max(1e-6, x1 - x0);
  const bh = Math.max(1e-6, y1 - y0);
  // Fit inside the box asked for, keeping the drawing's aspect.
  const k = o.w && o.h ? Math.min(o.w / bw, o.h / bh) : o.w ? o.w / bw : o.h ? o.h / bh : DEFAULT_WIDTH / bw;
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const map = (x: number, y: number): [number, number] => [(x - cx) * k, (y - cy) * k];
  const size: [number, number] = [r1(bw * k), r1(bh * k)];
  const span = `${o.start}${o.end !== undefined ? `-${o.end}` : ""}`;
  const lines = [`${o.id} rect ${span} x=${r1(o.x)} y=${r1(o.y)} w=${size[0]} h=${size[1]} vis=0 g=${o.group}`];
  const info: VectorPartInfo[] = [];
  parts.forEach((p, i) => {
    const id = `${o.id}_${i + 1}`;
    const keys = [`parent=${o.id}`, "x=0", "y=0", `g=${o.group}`];
    const fill = o.color ?? p.fill;
    if (fill) {
      keys.push("filled=1", `fill=${fill}`);
      if (p.nonzero) keys.push("rule=nonzero");
      if (p.gradient && !o.color) keys.push(`grad=${gradientValue(p.gradient)}`);
    }
    const stroke = o.stroke ?? (p.stroke ? `${r1(Math.max(0.5, p.stroke.width * k))}:${o.color ?? p.stroke.color}` : undefined);
    if (stroke) keys.push(`stroke=${stroke}`);
    lines.push(`${id} path ${span} ${keys.join(" ")} "${pathData(p.segs, map)}"`);
    const [[px0, py0], [px1, py1]] = bounds(p.segs);
    const [ax, ay] = map(px0, py0);
    const [bx, by] = map(px1, py1);
    const paint = [fill ? (p.gradient && !o.color ? `gradient ${p.gradient.kind}` : `fill ${fill}`) : "", stroke ? `stroke ${stroke}` : ""].filter(Boolean).join(" + ");
    info.push({ id, paint, box: [r1((ax + bx) / 2), r1((ay + by) / 2), r1(bx - ax), r1(by - ay)] });
  });
  return { lines, parts: info, size, warnings };
}
