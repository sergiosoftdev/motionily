/**
 * Compact layer lines: the agent writes one short line per layer instead of JSON
 * (a fraction of the output tokens), and reads layers back the same way.
 *
 *   id type start-end key=value… "text"
 *   hook_w1 text 0-3 g=hook x=540 y=420>380@0-.4:b w=900 h=180 o=0>1@0-.3 size=140 fill=text "Tu agenda"
 *   bar rect .2-3 g=hook x=540 y=980 w=0>800@.1-.6:o h=6 fill=#FF5A36
 *   dot ellipse 1-3 g=hook x=300 y=600 w=40 h=40 s=0:0,.3:1.2:b,.5:1 fill=accent
 *
 * Values: number · tween `from>to@t0-t1[:ease]` · keys `t:v[:ease],t:v…` (times from the layer start).
 * Eases: l linear, i ease_in, o ease_out, io ease_in_out, b back, h hold.
 * Colors: palette slot (background|surface|primary|accent|text) or #rrggbb[aa].
 */

type Keyframe = { t: number; v: number; ease?: string };
type Animated = number | Keyframe[];
type Layer = Record<string, unknown>;

const EASE: Record<string, string> = { l: "linear", i: "ease_in", o: "ease_out", io: "ease_in_out", b: "back", h: "hold" };
const EASE_SHORT: Record<string, string> = Object.fromEntries(Object.entries(EASE).map(([k, v]) => [v, k]));
const SHAPES = ["rect", "ellipse"];
const TYPES = [...SHAPES, "text", "image"];
/** Short keys for animated numbers. */
const NUM: Record<string, string> = { x: "x", y: "y", w: "w", h: "h", s: "scale", r: "rotation", o: "opacity", rad: "radius" };
const NUM_SHORT: Record<string, string> = Object.fromEntries(Object.entries(NUM).map(([k, v]) => [v, k]));
/** Plain keys copied as numbers or strings. */
const PLAIN_NUM = ["size", "lh"];
const PLAIN_STR = ["role", "align", "src", "fit", "anchor"];
const DEFAULTS: Record<string, unknown> = { scale: 1, rotation: 0, opacity: 1, radius: 0, x: 0, y: 0 };

function num(s: string, line: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`bad number '${s}' in: ${line}`);
  return n;
}

function ease(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const e = EASE[s] ?? (Object.values(EASE).includes(s) ? s : undefined);
  if (!e) throw new Error(`unknown ease '${s}' (use l, i, o, io, b, h)`);
  return e;
}

export function parseValue(v: string, line: string): Animated {
  const tween = /^(-?[\d.]+)>(-?[\d.]+)@([\d.]+)-([\d.]+)(?::(\w+))?$/.exec(v);
  if (tween) {
    const [, a, b, t0, t1, e] = tween;
    return [{ t: num(t0!, line), v: num(a!, line), ease: ease(e) ?? "ease_in_out" }, { t: num(t1!, line), v: num(b!, line) }];
  }
  if (v.includes(":")) {
    return v.split(",").map((k) => {
      const [t, val, e] = k.split(":");
      const key: Keyframe = { t: num(t!, line), v: num(val!, line) };
      const es = ease(e);
      if (es) key.ease = es;
      return key;
    });
  }
  return num(v, line);
}

function color(v: string): unknown {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
  if (!hex) return v;
  const n = parseInt(hex[1]!, 16);
  const a = hex[2] ? parseInt(hex[2], 16) / 255 : 1;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, +a.toFixed(3)].map((c) => +c.toFixed(3));
}

/** One line -> one layer JSON. */
export function parseLine(line: string): Layer {
  const quoted = /"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
  const head = quoted ? line.slice(0, quoted.index) : line;
  const [id, type, span, ...rest] = head.trim().split(/\s+/);
  if (!id || !type || !span) throw new Error(`expected 'id type start-end …': ${line}`);
  if (!TYPES.includes(type)) throw new Error(`unknown type '${type}' (rect, ellipse, text, image): ${line}`);
  const [start, end] = span.split("-");
  const layer: Layer = SHAPES.includes(type) ? { id, type: "shape", shape: type } : { id, type };
  layer.start = num(start!, line);
  if (end) layer.end = num(end, line);
  if (quoted) layer.text = quoted[1]!.replace(/\\"/g, '"');
  for (const kv of rest) {
    const eq = kv.indexOf("=");
    if (eq < 1) throw new Error(`expected key=value, got '${kv}': ${line}`);
    const [k, v] = [kv.slice(0, eq), kv.slice(eq + 1)];
    if (NUM[k]) layer[NUM[k]] = parseValue(v, line);
    else if (k === "fill") layer.fill = color(v);
    else if (k === "g") layer.group = v;
    else if (PLAIN_NUM.includes(k)) layer[k === "lh" ? "line_height" : k] = num(v, line);
    else if (PLAIN_STR.includes(k)) layer[k] = v;
    else throw new Error(`unknown key '${k}': ${line}`);
  }
  if (layer.w === undefined || layer.h === undefined) throw new Error(`w and h are required: ${line}`);
  return layer;
}

export function parseLines(text: string): Layer[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map(parseLine);
}

const r3 = (n: number) => +n.toFixed(3);

function formatValue(v: Animated): string {
  if (!Array.isArray(v)) return String(r3(v));
  // The last key's ease never plays, so two keys are always a tween.
  if (v.length === 2) {
    const e = v[0]!.ease && v[0]!.ease !== "ease_in_out" ? `:${EASE_SHORT[v[0]!.ease] ?? v[0]!.ease}` : "";
    return `${r3(v[0]!.v)}>${r3(v[1]!.v)}@${r3(v[0]!.t)}-${r3(v[1]!.t)}${e}`;
  }
  return v.map((k, i) => `${r3(k.t)}:${r3(k.v)}${k.ease && i < v.length - 1 ? `:${EASE_SHORT[k.ease] ?? k.ease}` : ""}`).join(",");
}

function formatColor(c: unknown): string {
  if (!Array.isArray(c)) return String(c);
  const hex = c
    .slice(0, 3)
    .map((x: number) => Math.round(x * 255).toString(16).padStart(2, "0"))
    .join("");
  const a = c[3] ?? 1;
  return `#${hex}${a < 1 ? Math.round(a * 255).toString(16).padStart(2, "0") : ""}`;
}

/** One layer JSON -> one line (what the agent reads back). Unknown extras are appended as JSON. */
export function formatLayer(l: Layer): string {
  const type = l.type === "shape" ? String(l.shape ?? "rect") : String(l.type);
  const parts = [String(l.id), type, `${r3(Number(l.start ?? 0))}${l.end == null ? "" : `-${r3(Number(l.end))}`}`];
  if (l.group) parts.push(`g=${l.group}`);
  for (const [long, short] of Object.entries(NUM_SHORT)) {
    const v = l[long] as Animated | undefined;
    if (v === undefined || v === DEFAULTS[long]) continue;
    parts.push(`${short}=${formatValue(v)}`);
  }
  if (l.fill !== undefined) parts.push(`fill=${formatColor(l.fill)}`);
  for (const k of [...PLAIN_NUM, ...PLAIN_STR]) {
    const key = k === "lh" ? "line_height" : k;
    if (l[key] !== undefined) parts.push(`${k}=${l[key]}`);
  }
  const known = new Set(["id", "type", "shape", "start", "end", "group", "fill", "text", "line_height", ...Object.keys(NUM_SHORT), ...PLAIN_NUM, ...PLAIN_STR]);
  const extra = Object.fromEntries(Object.entries(l).filter(([k]) => !known.has(k)));
  if (l.text !== undefined) parts.push(`"${String(l.text).replace(/"/g, '\\"')}"`);
  if (Object.keys(extra).length) parts.push(`# ${JSON.stringify(extra)}`);
  return parts.join(" ");
}
