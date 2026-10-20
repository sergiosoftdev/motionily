/**
 * Compact layer lines: the agent writes one short line per layer instead of JSON (a fraction of
 * the output tokens) and reads layers back the same way. Nothing is out of reach: a trailing
 * `{...}` merges any JSON field into the layer.
 *
 *   id type start-end key=value… "text or path data" {json}
 *
 *   bg_a ellipse 0 x=(420+60*sin(t*0.6)) y=260 w=1100 h=900 fill=#f7b9e0 soft=260 o=.85
 *   card rect .3-8 x=960 y=560 w=820 h=420 rad=32 fill=surface s=.9>1@0-.8:eo shadow=0,30,70,#ff6f91,.35
 *   title text .6 x=960 y=900 w=1500 h=180 size=140 grad=lin:0:#0f1733@0,#ff3d5a@.45,#ffa23d@1 "is the problem" {"animate":{"by":"char","stagger":0.035,"from":{"y":70,"opacity":0}}}
 *   link path 1.2 x=0 y=0 stroke=3:text:10,10 te=0>1@0-.9:o "M330 260 C480 260 520 420 560 470"
 *   dots ellipse 0 x=160 y=140 w=6 h=6 fill=text o=(0.12+0.1*sin(T*2+i)) rep=60:145,160:cols=12
 *
 * Values: number · tween `from>to@t0-t1[:ease]` · keys `t:v[:ease],t:v…` (t from the layer start)
 *   · expression `(…)` with t, T, i, n, sin, noise, wiggle, spring… (see docs/scene-reference.md).
 * Eases: l i o io b h · eo ei eio (expo) · el (elastic) · bo (bounce).
 * Colors: palette slot (background|surface|primary|accent|text) or #rrggbb[aa].
 */

type Keyframe = { t: number; v: number; ease?: string; bezier?: number[] };
type Animated = number | string | Keyframe[];
type Layer = Record<string, unknown>;

const EASE: Record<string, string> = {
  l: "linear",
  i: "ease_in",
  o: "ease_out",
  io: "ease_in_out",
  b: "back",
  h: "hold",
  eo: "expo_out",
  ei: "expo_in",
  eio: "expo_in_out",
  el: "elastic",
  bo: "bounce",
};
const EASE_SHORT: Record<string, string> = Object.fromEntries(Object.entries(EASE).map(([k, v]) => [v, k]));
const SHAPES = ["rect", "ellipse"];
const TYPES = [...SHAPES, "text", "image", "path"];
/** Short keys for animated numbers. */
const NUM: Record<string, string> = {
  x: "x",
  y: "y",
  w: "w",
  h: "h",
  s: "scale",
  r: "rotation",
  o: "opacity",
  rad: "radius",
  soft: "soft",
  ts: "trim_start",
  te: "trim_end",
  to: "trim_offset",
};
const NUM_SHORT: Record<string, string> = Object.fromEntries(Object.entries(NUM).map(([k, v]) => [v, k]));
/** Plain keys copied as numbers or strings. */
const PLAIN_NUM: Record<string, string> = { size: "size", lh: "line_height", ls: "letter_spacing" };
const PLAIN_STR = ["role", "align", "src", "fit", "anchor", "parent", "blend"];
const DEFAULTS: Record<string, unknown> = { scale: 1, rotation: 0, opacity: 1, radius: 0, x: 0, y: 0, soft: 0, trim_start: 0, trim_end: 1, trim_offset: 0 };

function num(s: string, line: string): number {
  const n = Number(s);
  if (s.trim() === "" || !Number.isFinite(n)) throw new Error(`bad number '${s}' in: ${line}`);
  return n;
}

function ease(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const e = EASE[s] ?? (Object.values(EASE).includes(s) ? s : undefined);
  if (!e) throw new Error(`unknown ease '${s}' (use ${Object.keys(EASE).join(", ")})`);
  return e;
}

export function parseValue(v: string, line: string): Animated {
  if (v.startsWith("(") && v.endsWith(")")) return v.slice(1, -1).trim();
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

/** Colors go through as written: palette slots and #hex are both understood by the engine. */
function color(v: string): string {
  return v;
}

/** Split a line into tokens, keeping "quoted", (parenthesized) and {braced} parts whole. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      cur += c;
      if (c === "\\" && i + 1 < line.length) cur += line[++i];
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"' && depth === 0) {
      quote = true;
      cur += c;
    } else if (c === "(" || c === "{" || c === "[") {
      depth++;
      cur += c;
    } else if (c === ")" || c === "}" || c === "]") {
      depth--;
      cur += c;
    } else if (/\s/.test(c) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (quote || depth !== 0) throw new Error(`unbalanced quotes or brackets: ${line}`);
  if (cur) out.push(cur);
  return out;
}

function gradient(v: string, line: string) {
  // lin:ANGLE:stops  ·  rad:CX,CY:R:stops  — stops = color@pos,color@pos…
  const parts = v.split(":");
  const stops = (s: string) =>
    s.split(",").map((st) => {
      const at = st.lastIndexOf("@");
      if (at < 1) throw new Error(`gradient stop needs color@pos: '${st}' in: ${line}`);
      return [num(st.slice(at + 1), line), color(st.slice(0, at))];
    });
  if (parts[0] === "lin" && parts.length === 3) return { kind: "linear", angle: parseValue(parts[1]!, line), stops: stops(parts[2]!) };
  if (parts[0] === "rad" && parts.length === 4) {
    const [cx, cy] = parts[1]!.split(",").map((n) => num(n, line));
    return { kind: "radial", center: [cx, cy], radius: parseValue(parts[2]!, line), stops: stops(parts[3]!) };
  }
  throw new Error(`grad must be lin:ANGLE:stops or rad:CX,CY:R:stops in: ${line}`);
}

function list(v: string, line: string, min: number): string[] {
  const p = v.split(",");
  if (p.length < min) throw new Error(`expected at least ${min} comma-separated values in '${v}': ${line}`);
  return p;
}

/** One line -> one layer JSON. */
export function parseLine(line: string): Layer {
  const toks = tokenize(line.trim());
  const [id, type, span, ...rest] = toks;
  if (!id || !type || !span) throw new Error(`expected 'id type start[-end] …': ${line}`);
  if (!TYPES.includes(type)) throw new Error(`unknown type '${type}' (${TYPES.join(", ")}): ${line}`);
  const layer: Layer = SHAPES.includes(type) ? { id, type: "shape", shape: type } : { id, type };
  const [start, end] = span.split("-");
  layer.start = num(start!, line);
  if (end) layer.end = num(end, line);
  const effects: unknown[] = [];
  let merge: Layer = {};
  for (const tok of rest) {
    if (tok.startsWith('"')) {
      const s = JSON.parse(tok) as string;
      layer[type === "path" ? "d" : "text"] = s;
      continue;
    }
    if (tok.startsWith("{")) {
      try {
        merge = { ...merge, ...(JSON.parse(tok) as Layer) };
      } catch {
        throw new Error(`bad JSON in ${tok.slice(0, 60)}…: ${line}`);
      }
      continue;
    }
    const eq = tok.indexOf("=");
    if (eq < 1) throw new Error(`expected key=value, got '${tok}': ${line}`);
    const [k, v] = [tok.slice(0, eq), tok.slice(eq + 1)];
    if (NUM[k]) layer[NUM[k]] = parseValue(v, line);
    else if (k === "fill") layer.fill = color(v);
    else if (k === "g") layer.group = v;
    else if (PLAIN_NUM[k]) layer[PLAIN_NUM[k]] = num(v, line);
    else if (PLAIN_STR.includes(k)) layer[k] = v;
    else if (k === "grad") layer.gradient = gradient(v, line);
    else if (k === "stroke") {
      const [w, c, dash] = v.split(":");
      layer.stroke = { width: parseValue(w!, line), color: color(c ?? "text"), ...(dash ? { dash: list(dash, line, 2).map((n) => num(n, line)) } : {}) };
    } else if (k === "shadow") {
      const [x, y, blur, c, op] = list(v, line, 3);
      effects.push({ fx: "shadow", x: parseValue(x!, line), y: parseValue(y!, line), blur: parseValue(blur!, line), ...(c ? { color: color(c) } : {}), ...(op ? { opacity: parseValue(op, line) } : {}) });
    } else if (k === "glow") {
      const [radius, strength, c] = v.split(",");
      effects.push({ fx: "glow", radius: parseValue(radius!, line), ...(strength ? { strength: parseValue(strength, line) } : {}), ...(c ? { color: color(c) } : {}) });
    } else if (k === "blur") effects.push({ fx: "blur", radius: parseValue(v, line) });
    else if (k === "matte") {
      const [src, mode] = v.split(":");
      layer.matte = { layer: src, ...(mode === "inv" ? { mode: "alpha_inverted" } : {}) };
    } else if (k === "vis") layer.visible = v !== "0" && v !== "false";
    else if (k === "filled") layer.filled = v !== "0" && v !== "false";
    else if (k === "pivot") layer.pivot = list(v, line, 2).map((n) => num(n, line));
    else if (k === "rep") {
      const [count, step, ...opts] = v.split(":");
      const [x, y] = (step ?? "0,0").split(",").map((n) => num(n, line));
      const rep: Record<string, number> = { count: num(count!, line), x: x ?? 0, y: y ?? 0 };
      const names: Record<string, string> = { cols: "columns", rot: "rotation", sc: "scale", op: "opacity", delay: "delay" };
      for (const o of opts) {
        const [ok, ov] = o.split("=");
        if (!names[ok!]) throw new Error(`unknown repeater option '${ok}' (cols, rot, sc, op, delay): ${line}`);
        rep[names[ok!]!] = num(ov!, line);
      }
      layer.repeat = rep;
    } else throw new Error(`unknown key '${k}': ${line}`);
  }
  if (effects.length) layer.effects = effects;
  Object.assign(layer, merge);
  if (type !== "path" && (layer.w === undefined || layer.h === undefined)) throw new Error(`w and h are required: ${line}`);
  if (type === "path" && typeof layer.d !== "string") throw new Error(`path needs its "M… path data" in quotes: ${line}`);
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
  if (typeof v === "string") return `(${v})`;
  if (!Array.isArray(v)) return String(r3(v));
  if (v.some((k) => k.bezier)) throw new Error("bezier keys have no compact form");
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
  const a = (c[3] as number | undefined) ?? 1;
  return `#${hex}${a < 1 ? Math.round(a * 255).toString(16).padStart(2, "0") : ""}`;
}

/** A value that fits inside a comma/colon separated short form. */
function inner(v: unknown): string {
  const s = formatValue(v as Animated);
  if (/[:,]/.test(s)) throw new Error("needs JSON");
  return s;
}

function formatGradient(g: Record<string, unknown>): string[] {
  const stops = (g.stops as [number, unknown][]).map(([p, c]) => `${formatColor(c)}@${r3(p)}`).join(",");
  if (g.kind === "radial") {
    const [cx, cy] = (g.center as number[] | undefined) ?? [0.5, 0.5];
    return [`grad=rad:${r3(cx!)},${r3(cy!)}:${inner(g.radius ?? 1)}:${stops}`];
  }
  return [`grad=lin:${inner(g.angle ?? 0)}:${stops}`];
}

function formatStroke(s: Record<string, unknown>): string[] {
  const dash = s.dash ? `:${(s.dash as number[]).map(r3).join(",")}` : "";
  return [`stroke=${inner(s.width)}:${formatColor(s.color ?? "text")}${dash}`];
}

function formatEffects(list: Record<string, unknown>[]): string[] {
  // The line form keeps one of each kind; repeats or unknown effects stay in JSON.
  const kinds = list.map((e) => e.fx);
  if (new Set(kinds).size !== kinds.length) throw new Error("needs JSON");
  return list.map((e) => {
    if (e.fx === "blur") return `blur=${inner(e.radius)}`;
    if (e.fx === "glow") return `glow=${[inner(e.radius), inner(e.strength ?? 1), ...(e.color ? [formatColor(e.color)] : [])].join(",")}`;
    if (e.fx === "shadow") {
      const vals = [inner(e.x ?? 0), inner(e.y ?? 18), inner(e.blur ?? 36), formatColor(e.color ?? "#0f121f"), inner(e.opacity ?? 0.25)];
      return `shadow=${vals.join(",")}`;
    }
    throw new Error("needs JSON");
  });
}

function formatRepeat(r: Record<string, number>): string[] {
  const opts = Object.entries({ cols: r.columns, rot: r.rotation, sc: r.scale, op: r.opacity, delay: r.delay })
    .filter(([k, v]) => v !== undefined && v !== (k === "sc" || k === "op" ? 1 : 0))
    .map(([k, v]) => `:${k}=${r3(v!)}`);
  return [`rep=${r.count}:${r3(r.x ?? 0)},${r3(r.y ?? 0)}${opts.join("")}`];
}

const SHORT_FORMS: [string, (v: never) => string[]][] = [
  ["gradient", formatGradient],
  ["stroke", formatStroke],
  ["effects", formatEffects],
  ["repeat", formatRepeat],
  ["matte", (m: { layer: string; mode?: string }) => [`matte=${m.layer}${m.mode === "alpha_inverted" ? ":inv" : ""}`]],
  ["pivot", (p: number[]) => [`pivot=${p.map(r3).join(",")}`]],
];

/** One layer JSON -> one line (what the agent reads back). Fields without a short form go in `{…}`. */
export function formatLayer(l: Layer): string {
  const type = l.type === "shape" ? String(l.shape ?? "rect") : String(l.type);
  const parts = [String(l.id), type, `${r3(Number(l.start ?? 0))}${l.end == null ? "" : `-${r3(Number(l.end))}`}`];
  const done = new Set(["id", "type", "shape", "start", "end"]);
  const extra: Layer = {};
  if (l.group) parts.push(`g=${l.group}`);
  done.add("group");
  for (const [long, short] of Object.entries(NUM_SHORT)) {
    const v = l[long] as Animated | undefined;
    done.add(long);
    if (v === undefined || v === DEFAULTS[long]) continue;
    try {
      parts.push(`${short}=${formatValue(v)}`);
    } catch {
      extra[long] = v;
    }
  }
  if (l.fill !== undefined) parts.push(`fill=${formatColor(l.fill)}`);
  done.add("fill");
  for (const [short, long] of Object.entries(PLAIN_NUM)) {
    if (l[long] !== undefined && l[long] !== 0) parts.push(`${short}=${l[long]}`);
    done.add(long);
  }
  for (const k of PLAIN_STR) {
    if (l[k] !== undefined) parts.push(`${k}=${l[k]}`);
    done.add(k);
  }
  for (const [key, short] of SHORT_FORMS) {
    if (l[key] === undefined) continue;
    try {
      parts.push(...short(l[key] as never));
      done.add(key);
    } catch {
      // No compact form (animated angle, bezier key…): it goes in the JSON tail.
    }
  }
  if (l.visible === false) parts.push("vis=0");
  if (l.filled === true) parts.push("filled=1");
  done.add("visible");
  done.add("filled");
  for (const [k, v] of Object.entries(l)) if (!done.has(k) && k !== "text" && k !== "d") extra[k] = v;
  const quoted = type === "path" ? l.d : l.text;
  if (quoted !== undefined) parts.push(JSON.stringify(String(quoted)));
  if (Object.keys(extra).length) parts.push(JSON.stringify(extra));
  return parts.join(" ");
}
