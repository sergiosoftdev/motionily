/**
 * SVG -> paths the engine can draw and animate. Any SVG (an Inkscape logo from Commons, an Iconify
 * icon, a web file) is flattened into parts: absolute M/L/C/Z geometry in one coordinate space,
 * each with one paint (fill color or gradient, optional stroke) and its fill rule, in paint order.
 * Shapes, <use>, nested transforms, CSS classes and inherited styles are resolved; text, images,
 * masks and clip paths cannot become paths and are reported instead.
 */

export type Seg = { c: "M" | "L" | "C" | "Z"; p: number[] };
export type Gradient = { kind: "linear"; angle: number; stops: [number, string][] } | { kind: "radial"; center: [number, number]; radius: number; stops: [number, string][] };
export type VectorPart = {
  segs: Seg[];
  /** #rrggbb[aa], or null for no fill. */
  fill: string | null;
  gradient?: Gradient;
  nonzero: boolean;
  stroke: { color: string; width: number } | null;
  /** The paint came from currentColor (a one-color icon: recolor freely). */
  current: boolean;
};
export type Vector = { box: [number, number, number, number]; parts: VectorPart[]; warnings: string[] };

type Node = { name: string; attrs: Record<string, string>; children: Node[]; text: string };
type M = [number, number, number, number, number, number];
type Style = Record<string, string>;

const IDENTITY: M = [1, 0, 0, 1, 0, 0];
const INHERITED = ["fill", "stroke", "stroke-width", "fill-rule", "fill-opacity", "stroke-opacity", "visibility", "color"];
const STYLE_PROPS = [...INHERITED, "opacity", "display", "stop-color", "stop-opacity", "clip-path", "mask"];
/** Containers whose children are never drawn directly. */
const NOT_DRAWN = new Set(["defs", "clipPath", "mask", "symbol", "linearGradient", "radialGradient", "pattern", "marker", "filter", "title", "desc", "metadata", "style", "script", "foreignObject"]);
const MAX_STOPS = 4;
const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", gray: "#808080", grey: "#808080",
  silver: "#c0c0c0", maroon: "#800000", purple: "#800080", navy: "#000080", teal: "#008080", lime: "#00ff00", aqua: "#00ffff", fuchsia: "#ff00ff", olive: "#808000",
  gold: "#ffd700", brown: "#a52a2a", pink: "#ffc0cb", transparent: "#00000000",
};

// ── XML ──
const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITY[e] ?? m)));
const localName = (n: string) => n.slice(n.lastIndexOf(":") + 1);

export function parseXml(text: string): Node {
  const root: Node = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of text.matchAll(re)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = decode(a[2] ?? a[3] ?? "");
      const node: Node = { name: localName(m[3]), attrs, children: [], text: "" };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6]) top.text += decode(m[6]);
  }
  return root;
}

// ── CSS (<style>: class, id and element selectors) ──
type Rule = { sel: string; spec: number; decls: Style };

function parseDecls(s: string): Style {
  const out: Style = {};
  for (const d of s.split(";")) {
    const at = d.indexOf(":");
    if (at > 0) out[d.slice(0, at).trim().toLowerCase()] = d.slice(at + 1).replace(/!important/g, "").trim();
  }
  return out;
}

function parseCss(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const decls = parseDecls(m[2]!);
    for (const sel of m[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!/^[\w-]*(?:[.#][\w-]+)*$/.test(sel)) continue;
      rules.push({ sel, spec: (sel.match(/#/g)?.length ?? 0) * 100 + (sel.match(/\./g)?.length ?? 0) * 10 + (/^[\w-]/.test(sel) ? 1 : 0), decls });
    }
  }
  return rules.sort((a, b) => a.spec - b.spec);
}

function matches(sel: string, n: Node) {
  const tag = /^[\w-]+/.exec(sel)?.[0];
  if (tag && tag !== n.name) return false;
  const classes = (n.attrs.class ?? "").split(/\s+/);
  for (const part of sel.matchAll(/([.#])([\w-]+)/g)) {
    if (part[1] === "." && !classes.includes(part[2]!)) return false;
    if (part[1] === "#" && n.attrs.id !== part[2]) return false;
  }
  return true;
}

// ── transforms ──
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const nums = (s: string) => (s.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? []).map(Number);

export function parseTransform(s: string | undefined): M {
  let m = IDENTITY;
  for (const t of (s ?? "").matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const v = nums(t[2]!);
    let n: M = IDENTITY;
    if (t[1] === "matrix" && v.length === 6) n = v as M;
    else if (t[1] === "translate") n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (t[1] === "scale") n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    else if (t[1] === "rotate") {
      const a = ((v[0] ?? 0) * Math.PI) / 180;
      const [cx, cy] = [v[1] ?? 0, v[2] ?? 0];
      n = mul(mul([1, 0, 0, 1, cx, cy], [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (t[1] === "skewX") n = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (t[1] === "skewY") n = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    m = mul(m, n);
  }
  return m;
}

// ── path data -> absolute M/L/C/Z ──
const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Arc flags may be written without separators ("a1 1 0 011 1"): read them one digit at a time. */
function pathTokens(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?)/gi;
  let cmd = "";
  let argi = 0;
  for (const m of d.matchAll(re)) {
    if (m[1]) {
      cmd = m[1];
      argi = 0;
      out.push(cmd);
      continue;
    }
    const k = argi % (ARGS[cmd.toUpperCase()] || 1);
    if ((cmd === "a" || cmd === "A") && (k === 3 || k === 4) && /^[01]{2,}/.test(m[2]!)) {
      // "011" = flag 0, flag 1, then the rest of the number.
      let s = m[2]!;
      while ((argi % 7 === 3 || argi % 7 === 4) && /^[01]/.test(s)) {
        out.push(Number(s[0]));
        s = s.slice(1);
        argi++;
      }
      if (s) {
        out.push(Number(s));
        argi++;
      }
      continue;
    }
    out.push(Number(m[2]));
    argi++;
  }
  return out;
}

/** Endpoint arc -> cubic Béziers (SVG implementation notes, F.6). */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, phiDeg: number, large: number, sweep: number, x2: number, y2: number): number[][] {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: number[][] = [];
  const pt = (t: number) => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos] as const;
  const dpt = (t: number) => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos] as const;
  for (let i = 0; i < n; i++) {
    const a = t1 + i * step;
    const b = a + step;
    const [ax, ay] = pt(a);
    const [bx, by] = pt(b);
    const [dax, day] = dpt(a);
    const [dbx, dby] = dpt(b);
    out.push([ax + k * dax, ay + k * day, bx - k * dbx, by - k * dby, bx, by]);
  }
  return out;
}

export function parsePath(d: string): Seg[] {
  const t = pathTokens(d);
  const out: Seg[] = [];
  let i = 0;
  let [x, y, sx, sy] = [0, 0, 0, 0];
  let prevCtrl: [number, number] | null = null;
  let prevQ: [number, number] | null = null;
  let cmd = "";
  const n = () => {
    const v = t[i++];
    if (typeof v !== "number") throw new Error("bad path data");
    return v;
  };
  while (i < t.length) {
    if (typeof t[i] === "string") cmd = t[i++] as string;
    else if (!cmd) throw new Error("path data must start with a command");
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (C === "Z") {
      out.push({ c: "Z", p: [] });
      [x, y] = [sx, sy];
      prevCtrl = prevQ = null;
      continue;
    }
    if (C === "M") {
      [x, y] = [ox + n(), oy + n()];
      [sx, sy] = [x, y];
      out.push({ c: "M", p: [x, y] });
      cmd = rel ? "l" : "L";
      prevCtrl = prevQ = null;
    } else if (C === "L") {
      [x, y] = [ox + n(), oy + n()];
      out.push({ c: "L", p: [x, y] });
      prevCtrl = prevQ = null;
    } else if (C === "H") {
      x = ox + n();
      out.push({ c: "L", p: [x, y] });
      prevCtrl = prevQ = null;
    } else if (C === "V") {
      y = oy + n();
      out.push({ c: "L", p: [x, y] });
      prevCtrl = prevQ = null;
    } else if (C === "C") {
      const p = [ox + n(), oy + n(), ox + n(), oy + n(), ox + n(), oy + n()];
      out.push({ c: "C", p });
      prevCtrl = [p[2]!, p[3]!];
      [x, y] = [p[4]!, p[5]!];
      prevQ = null;
    } else if (C === "S") {
      const [c1x, c1y]: [number, number] = prevCtrl ? [2 * x - prevCtrl[0], 2 * y - prevCtrl[1]] : [x, y];
      const p: number[] = [c1x, c1y, ox + n(), oy + n(), ox + n(), oy + n()];
      out.push({ c: "C", p });
      prevCtrl = [p[2]!, p[3]!];
      [x, y] = [p[4]!, p[5]!];
      prevQ = null;
    } else if (C === "Q" || C === "T") {
      let qx: number = x;
      let qy: number = y;
      if (C === "Q") [qx, qy] = [ox + n(), oy + n()];
      else if (prevQ) [qx, qy] = [2 * x - prevQ[0], 2 * y - prevQ[1]];
      const [ex, ey] = [ox + n(), oy + n()];
      out.push({ c: "C", p: [x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey] });
      prevQ = [qx, qy];
      prevCtrl = null;
      [x, y] = [ex, ey];
    } else if (C === "A") {
      const [rx, ry, rot, large, sweep] = [n(), n(), n(), n(), n()];
      const [ex, ey] = [ox + n(), oy + n()];
      for (const c of arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey)) out.push({ c: "C", p: c });
      [x, y] = [ex, ey];
      prevCtrl = prevQ = null;
    } else throw new Error(`unknown path command ${cmd}`);
  }
  return out;
}

// ── shapes ──
const f = (v: string | undefined, d = 0) => (v === undefined || v === "" ? d : parseFloat(v) || d);

function shapePath(n: Node): string | null {
  const a = n.attrs;
  switch (n.name) {
    case "path":
      return a.d ?? null;
    case "rect": {
      const [x, y, w, h] = [f(a.x), f(a.y), f(a.width), f(a.height)];
      if (w <= 0 || h <= 0) return null;
      let rx = a.rx !== undefined ? f(a.rx) : a.ry !== undefined ? f(a.ry) : 0;
      let ry = a.ry !== undefined ? f(a.ry) : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case "circle":
    case "ellipse": {
      const [cx, cy] = [f(a.cx), f(a.cy)];
      const rx = n.name === "circle" ? f(a.r) : f(a.rx);
      const ry = n.name === "circle" ? f(a.r) : f(a.ry);
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case "line":
      return `M${f(a.x1)} ${f(a.y1)}L${f(a.x2)} ${f(a.y2)}`;
    case "polyline":
    case "polygon": {
      const v = nums(a.points ?? "");
      if (v.length < 4) return null;
      const pts = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push(`${v[i]} ${v[i + 1]}`);
      return `M${pts.join("L")}${n.name === "polygon" ? "Z" : ""}`;
    }
    default:
      return null;
  }
}

// ── colors ──
const hex2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");

/** A CSS color as [#rrggbb, alpha]; null for none; "current" for currentColor. */
function parseColor(v: string | undefined, color: string): [string, number] | null | "url" {
  const s = (v ?? "").trim().toLowerCase();
  if (!s || s === "none" || s === "transparent") return null;
  if (s.startsWith("url(")) return "url";
  if (s === "currentcolor") return parseColor(color, "#000000");
  if (s[0] === "#") {
    const h = s.slice(1);
    if (h.length === 3 || h.length === 4) return [`#${[...h.slice(0, 3)].map((c) => c + c).join("")}`, h.length === 4 ? parseInt(h[3]! + h[3]!, 16) / 255 : 1];
    if (h.length === 6 || h.length === 8) return [`#${h.slice(0, 6)}`, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
    return ["#000000", 1];
  }
  const fn = /^rgba?\(([^)]*)\)/.exec(s);
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean);
    const ch = parts.slice(0, 3).map((p) => (p.endsWith("%") ? (parseFloat(p) * 255) / 100 : parseFloat(p)));
    const a = parts[3] ? (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    return [`#${ch.map(hex2).join("")}`, a];
  }
  const named = NAMED[s];
  return named ? [named.slice(0, 7), named.length === 9 ? 0 : 1] : ["#000000", 1];
}

const withAlpha = (hex: string, a: number) => (a >= 0.999 ? hex : `${hex}${hex2(a * 255)}`);
const isCurrent = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "currentcolor";

// ── the walk ──
type Ctx = { m: M; style: Style; opacity: number };

export function svgToVector(text: string): Vector {
  const root = parseXml(text);
  const svg = findFirst(root, "svg");
  if (!svg) throw new Error("not an SVG (no <svg> element)");
  const ids = new Map<string, Node>();
  const styles: string[] = [];
  const index = (n: Node) => {
    if (n.attrs.id) ids.set(n.attrs.id, n);
    if (n.name === "style") styles.push(n.text);
    n.children.forEach(index);
  };
  index(svg);
  const rules = parseCss(styles.join("\n"));
  const warnings = new Set<string>();
  const parts: VectorPart[] = [];

  const vb = nums(svg.attrs.viewBox ?? "");
  const width = f(svg.attrs.width?.replace(/px$/, ""), 0);
  const height = f(svg.attrs.height?.replace(/px$/, ""), 0);
  const box: [number, number, number, number] = vb.length === 4 ? (vb as [number, number, number, number]) : [0, 0, width || 100, height || 100];

  const styleOf = (n: Node, parent: Style): Style => {
    const own: Style = {};
    for (const p of STYLE_PROPS) if (n.attrs[p] !== undefined) own[p] = n.attrs[p]!;
    for (const r of rules) if (matches(r.sel, n)) Object.assign(own, r.decls);
    if (n.attrs.style) Object.assign(own, parseDecls(n.attrs.style));
    const out: Style = {};
    for (const p of INHERITED) if (parent[p] !== undefined) out[p] = parent[p]!;
    for (const [k, v] of Object.entries(own)) if (v !== "inherit") out[k] = v;
    return out;
  };

  const gradientOf = (ref: string, segs: Seg[], ctm: M): { gradient: Gradient; fallback: string } | null => {
    const id = /url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(ref)?.[1];
    const first = id ? ids.get(id) : undefined;
    if (!first || (first.name !== "linearGradient" && first.name !== "radialGradient")) return null;
    // Stops and attributes may come from a referenced gradient (href chains).
    const chain: Node[] = [first];
    let at: Node = first;
    for (let k = 0; k < 8; k++) {
      const href: string = (at.attrs.href ?? at.attrs["xlink:href"] ?? "").replace(/^#/, "");
      const next: Node | undefined = href ? ids.get(href) : undefined;
      if (!next) break;
      chain.push(next);
      at = next;
    }
    const attr = (name: string) => chain.find((c) => c.attrs[name] !== undefined)?.attrs[name];
    const stopsNode = chain.find((c) => c.children.some((s) => s.name === "stop"));
    const stops = (stopsNode?.children ?? [])
      .filter((s) => s.name === "stop")
      .map((s): [number, string] => {
        const st = styleOf(s, {});
        const off = s.attrs.offset ?? "0";
        const c = parseColor(st["stop-color"] ?? "#000000", st.color ?? "#000000");
        const [hex, a] = c && c !== "url" ? c : ["#000000", 1];
        const pos = off.endsWith("%") ? parseFloat(off) / 100 : parseFloat(off) || 0;
        return [Math.max(0, Math.min(1, pos)), withAlpha(hex, a * f(st["stop-opacity"], 1))];
      });
    if (!stops.length) return null;
    const sampled = stops.length <= MAX_STOPS ? stops : Array.from({ length: MAX_STOPS }, (_, k) => stops[Math.round((k * (stops.length - 1)) / (MAX_STOPS - 1))]!);
    // Bounding box of the shape in user space, to express the gradient in box fractions.
    const [lo, hi] = bounds(segs);
    const bw = hi[0] - lo[0] || 1;
    const bh = hi[1] - lo[1] || 1;
    const userSpace = attr("gradientUnits") === "userSpaceOnUse";
    const gt = mul(ctm, parseTransform(attr("gradientTransform")));
    const toBox = (x: number, y: number): [number, number] => {
      if (userSpace) {
        const [ux, uy] = apply(gt, x, y);
        return [(ux - lo[0]) / bw, (uy - lo[1]) / bh];
      }
      const [px, py] = apply(parseTransform(attr("gradientTransform")), x, y);
      return [px, py];
    };
    const pct = (v: string | undefined, d: number, span: number) => (v === undefined ? d : v.endsWith("%") ? (parseFloat(v) / 100) * (userSpace ? span : 1) : parseFloat(v));
    const fallback = sampled[0]![1];
    if (first.name === "linearGradient") {
      const [x1, y1] = toBox(pct(attr("x1"), 0, bw), pct(attr("y1"), 0, bh));
      const [x2, y2] = toBox(pct(attr("x2"), userSpace ? bw : 1, bw), pct(attr("y2"), 0, bh));
      return { gradient: { kind: "linear", angle: +((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI).toFixed(1), stops: sampled }, fallback };
    }
    const [cx, cy] = toBox(pct(attr("cx"), userSpace ? bw / 2 : 0.5, bw), pct(attr("cy"), userSpace ? bh / 2 : 0.5, bh));
    const r = pct(attr("r"), userSpace ? Math.max(bw, bh) / 2 : 0.5, Math.max(bw, bh));
    return { gradient: { kind: "radial", center: [+cx.toFixed(3), +cy.toFixed(3)], radius: +(userSpace ? r / Math.max(bw, bh) : r).toFixed(3), stops: sampled }, fallback };
  };

  const draw = (n: Node, ctx: Ctx, depth: number) => {
    if (depth > 64) return;
    const style = styleOf(n, ctx.style);
    if (style.display === "none" || style.visibility === "hidden") return;
    if (NOT_DRAWN.has(n.name)) return;
    if (n.name === "text" || n.name === "tspan") {
      warnings.add("has <text>: those words are not in the vector (use the PNG src, or set them again as a text layer)");
      return;
    }
    if (n.name === "image") {
      warnings.add("embeds a bitmap <image>: it is not in the vector (use the PNG src)");
      return;
    }
    if (style["clip-path"] && style["clip-path"] !== "none") warnings.add("uses clip paths: the vector may show parts the original hides (compare with the PNG)");
    if (style.mask && style.mask !== "none") warnings.add("uses masks: the vector may differ from the original (compare with the PNG)");
    let m = mul(ctx.m, parseTransform(n.attrs.transform));
    const opacity = ctx.opacity * f(style.opacity, 1);
    if (n.name === "use") {
      const href = (n.attrs.href ?? n.attrs["xlink:href"] ?? "").replace(/^#/, "");
      const target = ids.get(href);
      if (!target) return;
      m = mul(m, [1, 0, 0, 1, f(n.attrs.x), f(n.attrs.y)]);
      const inner = target.name === "symbol" ? { ...target, name: "g" } : target;
      draw(inner, { m, style, opacity }, depth + 1);
      return;
    }
    if (n.name === "svg" && depth > 0) {
      m = mul(m, [1, 0, 0, 1, f(n.attrs.x), f(n.attrs.y)]);
    }
    const d = shapePath(n);
    if (d) {
      let segs: Seg[];
      try {
        segs = parsePath(d);
      } catch {
        warnings.add("has broken path data (skipped)");
        return;
      }
      segs = segs.map((s) => ({ c: s.c, p: transformPoints(m, s.p) }));
      if (!segs.length) return;
      const fillRaw = style.fill ?? "#000000";
      const strokeRaw = style.stroke;
      const isLine = n.name === "line" || n.name === "polyline";
      let fill: string | null = null;
      let gradient: Gradient | undefined;
      const fc = isLine ? null : parseColor(fillRaw, style.color ?? "#000000");
      if (fc === "url") {
        const g = gradientOf(fillRaw, segs, m);
        if (g) {
          gradient = g.gradient;
          fill = g.fallback;
        } else {
          fill = withAlpha("#000000", opacity);
          warnings.add("uses a pattern fill (drawn black)");
        }
      } else if (fc) fill = withAlpha(fc[0], fc[1] * f(style["fill-opacity"], 1) * opacity);
      let stroke: VectorPart["stroke"] = null;
      const sc = parseColor(strokeRaw, style.color ?? "#000000");
      if (sc && sc !== "url") {
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        const w = f(style["stroke-width"], 1) * scale;
        if (w > 0) stroke = { color: withAlpha(sc[0], sc[1] * f(style["stroke-opacity"], 1) * opacity), width: +w.toFixed(2) };
      } else if (sc === "url") {
        const g = gradientOf(strokeRaw!, segs, m);
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        stroke = { color: g?.fallback ?? "#000000", width: +(f(style["stroke-width"], 1) * scale).toFixed(2) };
      }
      if (!fill && !stroke) return;
      // Fills close open subpaths implicitly, like SVG.
      if (fill) segs = closeSubpaths(segs);
      parts.push({
        segs,
        fill,
        ...(gradient ? { gradient } : {}),
        nonzero: (style["fill-rule"] ?? "nonzero") !== "evenodd",
        stroke,
        current: isCurrent(style.fill) || isCurrent(style.stroke) || (!style.fill && !style.stroke && false),
      });
      return;
    }
    for (const c of n.children) draw(c, { m, style, opacity }, depth + 1);
  };

  draw(svg, { m: IDENTITY, style: { color: "#000000" }, opacity: 1 }, 0);
  return { box, parts, warnings: [...warnings] };
}

function findFirst(n: Node, name: string): Node | null {
  if (n.name === name) return n;
  for (const c of n.children) {
    const hit = findFirst(c, name);
    if (hit) return hit;
  }
  return null;
}

function transformPoints(m: M, p: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < p.length; i += 2) out.push(...apply(m, p[i]!, p[i + 1]!));
  return out;
}

function closeSubpaths(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s.c === "M" && out.length && out[out.length - 1]!.c !== "Z") out.push({ c: "Z", p: [] });
    out.push(s);
  }
  if (out.length && out[out.length - 1]!.c !== "Z") out.push({ c: "Z", p: [] });
  return out;
}

/** Bounding box of the points (control points included: close enough for layout). */
export function bounds(segs: Seg[]): [[number, number], [number, number]] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of segs)
    for (let i = 0; i + 1 < s.p.length; i += 2) {
      x0 = Math.min(x0, s.p[i]!);
      x1 = Math.max(x1, s.p[i]!);
      y0 = Math.min(y0, s.p[i + 1]!);
      y1 = Math.max(y1, s.p[i + 1]!);
    }
  return [
    [x0, y0],
    [x1, y1],
  ];
}

/** Subpaths of a part (each starts at an M). */
export function subpaths(segs: Seg[]): Seg[][] {
  const out: Seg[][] = [];
  for (const s of segs) {
    if (s.c === "M" || !out.length) out.push([]);
    out[out.length - 1]!.push(s);
  }
  return out;
}

/** Path data for the engine (absolute M/L/C/Z), points mapped by `map`. */
export function pathData(segs: Seg[], map: (x: number, y: number) => [number, number]): string {
  const r = (v: number) => +v.toFixed(2);
  return segs
    .map((s) => {
      if (s.c === "Z") return "Z";
      const pts: number[] = [];
      for (let i = 0; i + 1 < s.p.length; i += 2) pts.push(...map(s.p[i]!, s.p[i + 1]!).map(r));
      return s.c + pts.join(" ");
    })
    .join("");
}
