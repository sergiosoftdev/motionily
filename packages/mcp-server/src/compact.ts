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
 *   · expression `(…)` with t, T, i, n, sin, noise, wiggle, spring… (see docs/agent/syntax.md).
 * Eases: l i o io b h · eo ei eio (expo) · el (elastic) · bo (bounce).
 * Colors: palette slot (background|surface|primary|accent|text) or #rrggbb[aa]; fill keys `0:#fff,1.2:primary:eo`.
 * Motion path `mp="M…" mpp=0>1@0-2 orient=1` · text on path `tp="M…" tpo=-900>0@0-1.5:eo` · time remap `time=(mod(t,2))`.
 * Effects: shadow glow blur · color=HUE,SAT,BRIGHT,CONTRAST · rgb=PX · wave=AMP,LEN,SPEED · grain=AMT · mblur=SHUTTER,SAMPLES
 *   · turb=AMT,SIZE,SPEED · adj=1 (adjustment layer) · matte=id[:inv|:luma|:lumainv].
 * World: cam=FOCAL[,FOCUS,APERTURE] on a vis=0 layer = the camera (x/y look, z dolly, s zoom, r roll) · z= depth (parallax)
 *   · fixed=1 pinned to the screen · rx= ry= tilt a layer and its children in perspective · persp= (animatable).
 * 3D object lights: light=AZIMUTH,ELEVATION[,COLOR[,INTENSITY]] = lights.key; the rest of `lights` goes in the JSON tail.
 * Icons: path layers take ic=NAME:SIZE (Lucide, centered on x,y; find_icons searches them) instead of "M…".
 * Materials: inner=X,Y,BLUR,COLOR,OP · sheen=AT,ANGLE,WIDTH,OP · bevel=WIDTH,STRENGTH · backdrop=BLUR (frosted glass).
 * Gradients: grad=lin:… | rad:… | con:CX,CY:ANGLE:stops (conic) · sgrad= paints the stroke.
 * Text: "Just *ask.*" colors the marked words with accent= (default palette accent) · count=0>12480@0-2:eo dec=0 with {n} in the text · reveal=(t*16) caret=1 (typewriter).
 * Particles (`particles` type, keys in the particles block below): emit= rate= burst= life= speed= dir= spread= grav= drag= wind=
 *   wander= look= ic= "M…" src= size= alpha= colors= color_life= angle= spin= flip= align= trail= seed= max= — ranges `A..B`,
 *   over-life keys `AGE:V,…`.
 * Components: `id use START comp=NAME x= y= s= … $param=value` places a component (define_component); inside a
 *   component's lines any value may be `$param` (whole value), expressions read `($param*2)`, text interpolates "$param".
 * Custom shaders: `id shader START x= y= w= h= p0=… p7= "WGSL fn shade(uv: vec2f, px: vec2f) -> vec4f {…}"` fills the box;
 *   `fx="WGSL…" fx0=… fx7=` adds a shader effect reading src(uv) (on adj=1: everything below). Newlines: \n inside the quotes.
 * Video: `clip video 0 x= y= w= h= src=/media/….mp4 fit=cover in=2 out=8 speed=1 loop=1 volume=0 rad=24` (muted unless volume>0).
 * Audio-reactive expressions: vol bass mid high beat beats (now) · vol(T-0.1) · spec(i/n) — 0..1 from the project audio, 0 without it.
 */

import { ICON_GRID, iconPath } from "./icons.js";

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
// ---- custom shaders (shader layers + shader effect) ----
const SHADER = "shader";
/** Animatable shader params p0..p7 (layer) and fx0..fx7 (shader effect). */
const SHADER_PARAMS = 8;
const PARAM_KEY = /^p([0-7])$/;
const FX_PARAM_KEY = /^fx([0-7])$/;
type ShaderFx = { fx: typeof SHADER; code?: string; params?: Animated[] };

/** Put `v` at `params[i]`, filling the gaps with 0 (p2 alone = [0, 0, v]). */
function setParam(params: Animated[] | undefined, i: number, v: Animated): Animated[] {
  const out = [...(params ?? [])];
  while (out.length < i) out.push(0);
  out[i] = v;
  return out;
}

/** `p0=… p1=…` (or `fx0=…`) back from a params list; throws "needs JSON" when one has no line form. */
function formatShaderParams(params: Animated[] | undefined, prefix: string): string[] {
  return (params ?? []).map((v, i) => `${prefix}${i}=${formatValue(v)}`);
}
// ---- end custom shaders ----
// ── components ──
/** Layer type of a component instance. */
export const USE = "use";
/** `$name` / `${name}`: a whole value that is a component param. */
const PARAM_REF = /^\$(\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)$/;
/** Param types of define_component. */
export const PARAM_TYPES = ["number", "color", "text", "src", "bool", "path"] as const;
export type ParamType = (typeof PARAM_TYPES)[number];
export type ParamDef = { name: string; type: ParamType; default?: unknown };
// ── end components ──
const PARTICLES = "particles";
const TYPES = [...SHAPES, "text", "image", "video", "path", "object", "text3d", PARTICLES, USE, SHADER];
// --- video clips: keys only `video` layers take (JSON names: in, out, speed, loop, volume) ---
const VIDEO = "video";
const VIDEO_NUM = ["in", "out", "speed", "volume"];
const VIDEO_DEFAULTS: Record<string, number> = { in: 0, speed: 1, volume: 0 };
// --- end video clips ---
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
  time: "time",
  rx: "rotate_x",
  ry: "rotate_y",
  z: "z",
  persp: "perspective",
};
const NUM_SHORT: Record<string, string> = Object.fromEntries(Object.entries(NUM).map(([k, v]) => [v, k]));
/** Plain keys copied as numbers or strings. */
const PLAIN_NUM: Record<string, string> = { size: "size", lh: "line_height", ls: "letter_spacing", dec: "decimals" };
const PLAIN_STR = ["role", "align", "src", "fit", "anchor", "parent", "blend"];
const DEFAULTS: Record<string, unknown> = { rotate_x: 0, rotate_y: 0, z: 0,  scale: 1, rotation: 0, opacity: 1, radius: 0, x: 0, y: 0, soft: 0, trim_start: 0, trim_end: 1, trim_offset: 0 };

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
  if (PARAM_REF.test(v)) return v;
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

/** A color, or color keys `t:color[:ease],…`. */
function colorAnim(v: string, line: string): unknown {
  if (!v.includes(":")) return color(v);
  return v.split(",").map((k) => {
    const [t, c, e] = k.split(":");
    if (!c) throw new Error(`color keys are t:color[:ease] in '${v}': ${line}`);
    const es = ease(e);
    return { t: num(t!, line), c: color(c), ...(es ? { ease: es } : {}) };
  });
}

/** A quoted value inside key="…". */
function quoted(v: string, line: string, what = 'path, like key="M0 0 L100 0"'): string {
  if (!v.startsWith('"')) throw new Error(`expected a quoted ${what}: ${line}`);
  return JSON.parse(v) as string;
}

const MATTE_MODES: Record<string, string> = { inv: "alpha_inverted", luma: "luma", lumainv: "luma_inverted" };
/** Key light defaults (engine `KeyLight`): left out when reading back. */
const KEY_LIGHT = { azimuth: 35, elevation: 50, color: "#ffffff", intensity: 1 };
const MATTE_SHORT: Record<string, string> = Object.fromEntries(Object.entries(MATTE_MODES).map(([k, v]) => [v, k]));

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
  if (parts[0] === "con" && parts.length === 4) {
    const [cx, cy] = parts[1]!.split(",").map((n) => num(n, line));
    return { kind: "conic", center: [cx, cy], angle: parseValue(parts[2]!, line), stops: stops(parts[3]!) };
  }
  if (parts[0] === "rad" && parts.length === 4) {
    const [cx, cy] = parts[1]!.split(",").map((n) => num(n, line));
    return { kind: "radial", center: [cx, cy], radius: parseValue(parts[2]!, line), stops: stops(parts[3]!) };
  }
  throw new Error(`grad must be lin:ANGLE:stops, rad:CX,CY:R:stops or con:CX,CY:ANGLE:stops in: ${line}`);
}

// ── components ──
/** An on/off key: `1`/`0`, or a `$param` inside a component. */
function flag(v: string): boolean | string {
  return PARAM_REF.test(v) ? v : v !== "0" && v !== "false";
}

/** A plain number key, or a `$param` inside a component. */
function plainNum(v: string, line: string): number | string {
  return PARAM_REF.test(v) ? v : num(v, line);
}

/** `ic:NAME[:SIZE]` -> a Lucide icon as path data that remembers its name. */
function iconValue(v: string, line: string): { ic: string; d: string } | undefined {
  const m = /^ic:([\w-]+)(?::([\d.]+))?$/.exec(v);
  if (!m) return undefined;
  const size = m[2] ? num(m[2], line) : ICON_GRID * 2;
  return { ic: `${m[1]}:${size}`, d: iconPath(m[1]!, size) };
}

/** A `$param=value` of an instance: "quoted" text, true/false, ic:NAME[:SIZE], numbers/tweens/keys/(expr), else a bare word (color, src…). */
export function parseParamValue(v: string, line: string): unknown {
  if (v.startsWith('"')) return JSON.parse(v) as string;
  if (v === "true" || v === "false") return v === "true";
  const icon = iconValue(v, line);
  if (icon) return icon;
  if (v.startsWith("(") || /^-?[\d.]+$/.test(v) || /^-?[\d.]+[>:]/.test(v)) return parseValue(v, line);
  return v;
}

const BARE = /^[A-Za-z#/_$][\w#./$-]*$/;

/** An instance param value back to its line form. */
export function formatParamValue(v: unknown): string {
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number" || Array.isArray(v)) return formatValue(v as Animated);
  if (v && typeof v === "object" && typeof (v as { ic?: unknown }).ic === "string") return `ic:${(v as { ic: string }).ic}`;
  if (typeof v === "string") return BARE.test(v) && v !== "true" && v !== "false" ? v : JSON.stringify(v);
  throw new Error("needs JSON");
}

/** define_component params: `title:text="Revenue" value:number=0 icon:path=ic:trending-up:40 accent:color=accent show:bool=1`. */
export function parseParams(text: string): ParamDef[] {
  return tokenize(text.trim()).map((tok) => {
    const m = /^([A-Za-z_]\w*):(\w+)(?:=(.*))?$/s.exec(tok);
    if (!m) throw new Error(`param must be name:type[=default] (types ${PARAM_TYPES.join(", ")}), got '${tok}'`);
    const [, name, type, raw] = m;
    if (!(PARAM_TYPES as readonly string[]).includes(type!)) throw new Error(`unknown param type '${type}' in '${tok}' (${PARAM_TYPES.join(", ")})`);
    const def: ParamDef = { name: name!, type: type as ParamType };
    if (raw !== undefined && raw !== "") def.default = type === "bool" ? flag(raw) : parseParamValue(raw, tok);
    return def;
  });
}

export function formatParams(params: ParamDef[]): string {
  return params.map((p) => `${p.name}:${p.type}${p.default === undefined ? "" : `=${formatParamValue(p.default)}`}`).join(" ");
}
// ── end components ──

function list(v: string, line: string, min: number): string[] {
  const p = v.split(",");
  if (p.length < min) throw new Error(`expected at least ${min} comma-separated values in '${v}': ${line}`);
  return p;
}

// ── 3D objects and 3D text ─────────────────────────────────────────────
// `text3d` is an object layer whose node is one `{"shape":"text"}`: the quoted text and the text
// keys (depth, family, weight, align, ls, lh) live on that node. Any object takes finish/spin/fov.
const FINISHES = ["glossy", "glass", "chrome", "matte", "toon"];
const DEFAULT_FINISH = "glossy";
/** Mirrors `object_fov` in crates/scene/src/layer.rs. */
const DEFAULT_FOV = 28;
/** Node fields a text3d line can carry (anything else keeps the object form). */
const TEXT3D_NODE_KEYS = new Set(["shape", "text", "depth", "family", "weight", "align", "letter_spacing", "line_height", "size"]);
/** Layer fields that move onto the text node. */
const TEXT3D_MOVED: Record<string, string> = { text: "text", align: "align", letter_spacing: "letter_spacing", line_height: "line_height" };

/** Split on `sep` outside parentheses (expressions keep their commas). */
function splitTop(v: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of v) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** `spin=RX,RY,RZ`, or `RX;RY;RZ` when a value is keyframes (they use commas). */
function spinValue(v: string, line: string): Animated[] {
  const parts = v.includes(";") ? splitTop(v, ";") : splitTop(v, ",");
  if (parts.length !== 3) throw new Error(`spin needs 3 values RX,RY,RZ (use ; between them when one is keyframes): ${line}`);
  return parts.map((p) => parseValue(p, line));
}

/** Text node defaults (mirror crates/scene/src/node3d.rs), left out of text3d lines. */
const TEXT3D_DEFAULTS: Record<string, unknown> = { size: 1, depth: 0.25, align: "center", letter_spacing: 0, line_height: 1.2 };
/** Node transform defaults the engine writes back on every node. */
const NODE_DEFAULTS: Record<string, string> = { position: "[0,0,0]", rotation: "[0,0,0]", scale: "[1,1,1]" };

function isText3d(l: Layer): boolean {
  const node = l.node as Record<string, unknown> | undefined;
  if (l.type !== "object" || node?.shape !== "text" || typeof node.text !== "string") return false;
  return Object.entries(node).every(([k, v]) => (TEXT3D_NODE_KEYS.has(k) && (k !== "size" || v === 1)) || NODE_DEFAULTS[k] === JSON.stringify(v));
}

/** A text node field worth writing (not its default). */
const textField = (node: Record<string, unknown>, k: string) => node[k] !== undefined && node[k] !== TEXT3D_DEFAULTS[k];
// ---- particles: begin (compact keys of the `particles` layer type) ----
const EMITS = ["point", "line", "rect", "circle", "path"];
const LOOKS = ["circle", "rect", "streak", "path", "image"];
const SPACES = ["world", "local"];
/** Compact key -> JSON field. */
const P_FLAG: Record<string, string> = { edge: "edge", out: "outward", follow: "follow", align: "align" };
const P_VARY: Record<string, string> = { life: "life", speed: "speed", angle: "angle", spin: "spin", flip: "flip" };
const P_NUM: Record<string, string> = { dir: "direction", spread: "spread", drag: "drag", prewarm: "prewarm", aspect: "aspect", size_var: "size_var", trail: "trail", seed: "seed", max: "max" };
const P_VEC: Record<string, string> = { grav: "gravity", wind: "wind" };
const P_LIFE: Record<string, string> = { size: "size", alpha: "alpha" };
/** Engine defaults, left out when reading a layer back. */
const P_DEFAULTS: Record<string, unknown> = { emit: "point", space: "world", direction: -90, spread: 30, life: 2, speed: 200, size: 12, trail: 0.04, max: 1000, aspect: 1, drag: 0, prewarm: 0, size_var: 0, seed: 0, angle: 0, spin: 0, flip: 0, rate: 0, edge: false, outward: false, follow: false, align: false, gravity: [0, 0], wind: [0, 0] };
const P_ALPHA_DEFAULT = [[0, 0], [0.05, 1], [0.7, 1], [1, 0]];

function onOff(v: string): boolean {
  return v !== "0" && v !== "false";
}

function oneOf(v: string, options: string[], key: string, line: string): string {
  if (!options.includes(v)) throw new Error(`${key} is ${options.join("|")}, got '${v}': ${line}`);
  return v;
}

/** `1.5` or a random range `1..2`. */
function vary(v: string, line: string): number | [number, number] {
  const [a, b, ...more] = v.split("..");
  if (more.length) throw new Error(`a range is MIN..MAX, got '${v}': ${line}`);
  return b === undefined ? num(a!, line) : [num(a!, line), num(b, line)];
}

/** `12` or over-life keys `AGE:V,AGE:V…` (age 0..1). */
function overLife(v: string, line: string): number | [number, number][] {
  if (!v.includes(":")) return num(v, line);
  return v.split(",").map((k) => {
    const [age, val, extra] = k.split(":");
    if (val === undefined || extra !== undefined) throw new Error(`over-life keys are AGE:VALUE (age 0..1), got '${k}': ${line}`);
    return [num(age!, line), num(val, line)];
  });
}

function vec(v: string, line: string): [number, number] {
  const p = v.split(",");
  if (p.length !== 2) throw new Error(`expected X,Y in '${v}': ${line}`);
  return [num(p[0]!, line), num(p[1]!, line)];
}

/** A particle key on a `particles` line; false when it is not one (the generic keys then apply). */
function particleKey(layer: Layer, k: string, v: string, line: string): boolean {
  if (k === "emit") {
    if (v.startsWith('"')) {
      layer.emit = "path";
      layer.emit_d = quoted(v, line);
    } else layer.emit = oneOf(v, EMITS, "emit", line);
  } else if (P_FLAG[k]) layer[P_FLAG[k]] = onOff(v);
  else if (P_VARY[k]) layer[P_VARY[k]] = vary(v, line);
  else if (P_NUM[k]) layer[P_NUM[k]] = num(v, line);
  else if (P_VEC[k]) layer[P_VEC[k]] = vec(v, line);
  else if (P_LIFE[k]) layer[P_LIFE[k]] = overLife(v, line);
  else if (k === "rate") layer.rate = parseValue(v, line);
  else if (k === "space") layer.space = oneOf(v, SPACES, "space", line);
  else if (k === "look") layer.look = oneOf(v, LOOKS, "look", line);
  else if (k === "burst")
    layer.bursts = v.split(",").map((b) => {
      const [at, count] = b.split(":");
      if (count === undefined) throw new Error(`burst is AT:COUNT[,AT:COUNT…], got '${b}': ${line}`);
      return { at: num(at!, line), count: num(count, line) };
    });
  else if (k === "wander") {
    const [amount, size, speed] = v.split(",");
    layer.wander = { amount: num(amount!, line), ...(size ? { size: num(size, line) } : {}), ...(speed ? { speed: num(speed, line) } : {}) };
  } else if (k === "colors") layer.colors = v.split(",").map(color);
  else if (k === "color_life")
    layer.color_life = v.split(",").map((key) => {
      const [age, c, extra] = key.split(":");
      if (!c || extra !== undefined) throw new Error(`color_life keys are AGE:COLOR (age 0..1), got '${key}': ${line}`);
      return [num(age!, line), color(c)];
    });
  else if (k === "ic") {
    // Fitted to the particle size, so any icon size works: the 24 px grid is kept.
    const name = v.split(":")[0]!;
    layer.icon = name;
    layer.d = iconPath(name, ICON_GRID);
  } else return false;
  return true;
}

/** What the emitter and the look need, checked once the whole line is read. */
function checkParticles(layer: Layer, line: string) {
  const emit = (layer.emit as string | undefined) ?? "point";
  if ((emit === "line" || emit === "rect" || emit === "circle") && layer.w === undefined) throw new Error(`emit=${emit} needs w= (and h= for rect/circle): ${line}`);
  if ((emit === "rect" || emit === "circle") && layer.h === undefined) throw new Error(`emit=${emit} needs h=: ${line}`);
  if (emit === "path" && typeof layer.emit_d !== "string") throw new Error(`emit=path needs its path: emit="M0 0 L400 0": ${line}`);
  if (layer.follow && emit !== "path") throw new Error(`follow=1 rides an emit="M…" path: ${line}`);
  if (layer.look === "image" && typeof layer.src !== "string") throw new Error(`look=image needs src=: ${line}`);
  if (layer.look === "path" && typeof layer.d !== "string") throw new Error(`look=path needs ic=NAME or "M… path data": ${line}`);
  if (layer.rate === undefined && layer.bursts === undefined) throw new Error(`particles need rate= and/or burst=AT:COUNT: ${line}`);
}

const varyText = (v: unknown) => (Array.isArray(v) ? `${r3(Number(v[0]))}..${r3(Number(v[1]))}` : String(r3(Number(v))));
const lifeText = (v: unknown) => (Array.isArray(v) ? (v as number[][]).map(([a, x]) => `${r3(a!)}:${r3(x!)}`).join(",") : String(r3(Number(v))));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A particle layer's own keys in short form (marks them done; what has no short form stays for the JSON tail). */
function formatParticles(l: Layer, done: Set<string>): string[] {
  const out: string[] = [];
  const put = (field: string, text: () => string | undefined) => {
    if (l[field] === undefined || same(l[field], P_DEFAULTS[field])) {
      done.add(field);
      return;
    }
    try {
      const t = text();
      if (t !== undefined) out.push(t);
      done.add(field);
    } catch {
      // No short form: left for the JSON tail.
    }
  };
  put("emit", () => (l.emit === "path" && typeof l.emit_d === "string" ? `emit=${JSON.stringify(l.emit_d)}` : `emit=${l.emit}`));
  if (l.emit === "path") done.add("emit_d");
  for (const [short, long] of Object.entries(P_FLAG)) put(long, () => `${short}=1`);
  put("space", () => `space=${l.space}`);
  put("rate", () => `rate=${formatValue(l.rate as Animated)}`);
  put("bursts", () => `burst=${(l.bursts as { at: number; count: number }[]).map((b) => `${r3(b.at)}:${b.count}`).join(",")}`);
  for (const [short, long] of Object.entries(P_VARY)) put(long, () => `${short}=${varyText(l[long])}`);
  for (const [short, long] of Object.entries(P_NUM)) put(long, () => `${short}=${r3(Number(l[long]))}`);
  for (const [short, long] of Object.entries(P_VEC)) put(long, () => `${short}=${(l[long] as number[]).map(r3).join(",")}`);
  put("wander", () => {
    const w = l.wander as { amount: number; size?: number; speed?: number };
    return `wander=${[w.amount, w.size ?? 200, w.speed ?? 1].map(r3).join(",")}`;
  });
  // The look is implied by ic=/"M…" (path) and src= (image).
  const implied = l.d !== undefined ? "path" : l.src !== undefined ? "image" : "circle";
  if (l.look === implied) done.add("look");
  else put("look", () => `look=${l.look}`);
  put("size", () => `size=${lifeText(l.size)}`);
  if (same(l.alpha, P_ALPHA_DEFAULT)) done.add("alpha");
  else put("alpha", () => `alpha=${lifeText(l.alpha)}`);
  put("colors", () => {
    const cs = l.colors as unknown[];
    if (cs.some((c) => Array.isArray(c) && typeof c[0] === "object")) throw new Error("needs JSON");
    return `colors=${cs.map(formatColor).join(",")}`;
  });
  put("color_life", () => `color_life=${(l.color_life as [number, unknown][]).map(([a, c]) => `${r3(a)}:${formatColor(c)}`).join(",")}`);
  return out;
}
// ---- particles: end ----

/** One line -> one layer JSON. */
/** One line -> one layer JSON. `partial` (edit_layers) skips the checks for fields a new layer needs. */
export function parseLine(line: string, partial = false): Layer {
  const toks = tokenize(line.trim());
  const [id, type, span, ...rest] = toks;
  if (!id || !type || !span) throw new Error(`expected 'id type start[-end] …': ${line}`);
  if (!TYPES.includes(type)) throw new Error(`unknown type '${type}' (${TYPES.join(", ")}): ${line}`);
  const text3d = type === "text3d";
  const node: Layer = { shape: "text" };
  const layer: Layer = SHAPES.includes(type) ? { id, type: "shape", shape: type } : text3d ? { id, type: "object", node } : { id, type };
  const [start, end] = span.split("-");
  layer.start = num(start!, line);
  if (end) layer.end = num(end, line);
  const effects: unknown[] = [];
  let shaderFx: ShaderFx | undefined;
  let merge: Layer = {};
  const params: Record<string, unknown> = {};
  let keyLight: Layer | undefined;
  for (const tok of rest) {
    // ── components: comp= and $param= on instance lines ──
    if (type === USE && tok.startsWith("comp=")) {
      layer.comp = tok.slice(5);
      continue;
    }
    if (tok.startsWith("$")) {
      const eq = tok.indexOf("=");
      const name = tok.slice(1, eq);
      if (type !== USE) throw new Error(`'${tok}' sets a component param: only use lines take $param=value (inside a component write key=$param): ${line}`);
      if (eq < 2 || !/^[A-Za-z_]\w*$/.test(name)) throw new Error(`expected $param=value, got '${tok}': ${line}`);
      params[name] = parseParamValue(tok.slice(eq + 1), line);
      continue;
    }
    if (tok.startsWith('"')) {
      if (type === USE) throw new Error(`a use line has no quoted text: pass it as a param ($title="…"): ${line}`);
      const s = JSON.parse(tok) as string;
      layer[type === "path" || type === PARTICLES ? "d" : type === SHADER ? "code" : "text"] = s;
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
    if (type === PARTICLES && particleKey(layer, k, v, line)) continue;
    const param = PARAM_KEY.exec(k);
    const fxParam = FX_PARAM_KEY.exec(k);
    if (NUM[k]) layer[NUM[k]] = parseValue(v, line);
    else if (param) {
      if (type !== SHADER) throw new Error(`${k}= is a shader layer param (type shader); a shader effect takes fx${param[1]}=: ${line}`);
      layer.params = setParam(layer.params as Animated[] | undefined, Number(param[1]), parseValue(v, line));
    } else if (fxParam) {
      if (!shaderFx) effects.push((shaderFx = { fx: SHADER }));
      shaderFx.params = setParam(shaderFx.params, Number(fxParam[1]), parseValue(v, line));
    } else if (k === "fx") {
      if (!shaderFx) effects.push((shaderFx = { fx: SHADER }));
      shaderFx.code = quoted(v, line, 'WGSL code, like fx="fn shade(uv: vec2f, px: vec2f) -> vec4f { return src(uv); }"');
    }
    else if (k === "fill") layer.fill = colorAnim(v, line);
    else if (k === "accent") layer.accent = colorAnim(v, line);
    else if (k === "g") layer.group = v;
    else if (PLAIN_NUM[k]) layer[PLAIN_NUM[k]] = plainNum(v, line);
    else if (VIDEO_NUM.includes(k) || k === "loop") {
      if (type !== VIDEO) throw new Error(`'${k}=' is only for video layers: ${line}`);
      if (k === "loop") layer.loop = v !== "0" && v !== "false";
      else layer[k] = num(v, line);
    }
    else if (PLAIN_STR.includes(k)) layer[k] = v;
    else if (k === "grad") layer.gradient = gradient(v, line);
    else if (k === "sgrad") layer.stroke = { width: 2, ...(layer.stroke as object), gradient: gradient(v, line) };
    else if (k === "turb") {
      const [amount, size, speed] = v.split(",");
      effects.push({ fx: "turbulence", amount: parseValue(amount!, line), ...(size ? { size: parseValue(size, line) } : {}), ...(speed ? { speed: parseValue(speed, line) } : {}) });
    } else if (k === "count") layer.count = parseValue(v, line);
    else if (k === "reveal") layer.reveal = parseValue(v, line);
    else if (k === "caret") layer.caret = flag(v);
    else if (k === "ic") {
      if (v.startsWith("$")) throw new Error(`ic= takes an icon name; inside a component make the icon a path param and write "${v.split(":")[0]}" as the path data with stroke=W:COLOR: ${line}`);
      const [name, size] = v.split(":");
      const px = size ? num(size, line) : ICON_GRID * 2;
      layer.icon = `${name}:${px}`;
      layer.d = iconPath(name!, px);
      layer.stroke ??= { width: Math.max(1.5, px / 12), color: "text" };
    } else if (k === "fixed") layer.fixed = flag(v);
    else if (k === "finish") {
      if (!FINISHES.includes(v)) throw new Error(`finish is ${FINISHES.join(", ")}: ${line}`);
      layer.finish = v;
    } else if (k === "spin") layer.spin = spinValue(v, line);
    else if (k === "fov") layer.fov = num(v, line);
    else if (text3d && k === "depth") node.depth = num(v, line);
    else if (text3d && k === "weight") node.weight = num(v, line);
    else if (text3d && k === "family") node.family = v.startsWith('"') ? quoted(v, line) : v;
    else if (k === "light") {
      const [az, el, c, intensity] = list(v, line, 2);
      keyLight = { azimuth: parseValue(az!, line), elevation: parseValue(el!, line), ...(c ? { color: color(c) } : {}), ...(intensity ? { intensity: parseValue(intensity, line) } : {}) };
    }
    else if (k === "cam") {
      const [focal, focus, aperture] = v.split(",");
      layer.camera = { focal: num(focal!, line), ...(focus ? { focus: parseValue(focus, line) } : {}), ...(aperture ? { aperture: parseValue(aperture, line) } : {}) };
    } else if (k === "backdrop") layer.backdrop = parseValue(v, line);
    else if (k === "inner") {
      const [x, y, blur, c, op] = list(v, line, 3);
      layer.inner = { x: parseValue(x!, line), y: parseValue(y!, line), blur: parseValue(blur!, line), ...(c ? { color: color(c) } : {}), ...(op ? { opacity: parseValue(op, line) } : {}) };
    } else if (k === "sheen") {
      const [at, angle, width, op] = v.split(",");
      layer.sheen = { at: parseValue(at!, line), ...(angle ? { angle: parseValue(angle, line) } : {}), ...(width ? { width: parseValue(width, line) } : {}), ...(op ? { opacity: parseValue(op, line) } : {}) };
    } else if (k === "bevel") {
      const [w, strength] = v.split(",");
      layer.bevel = { width: parseValue(w!, line), ...(strength ? { strength: parseValue(strength, line) } : {}) };
    }
    else if (k === "stroke") {
      const [w, c, dash] = v.split(":");
      layer.stroke = { ...(layer.stroke as object), width: parseValue(w!, line), color: color(c ?? "text"), ...(dash ? { dash: list(dash, line, 2).map((n) => num(n, line)) } : {}) };
    } else if (k === "shadow") {
      const [x, y, blur, c, op] = list(v, line, 3);
      effects.push({ fx: "shadow", x: parseValue(x!, line), y: parseValue(y!, line), blur: parseValue(blur!, line), ...(c ? { color: color(c) } : {}), ...(op ? { opacity: parseValue(op, line) } : {}) });
    } else if (k === "glow") {
      const [radius, strength, c] = v.split(",");
      effects.push({ fx: "glow", radius: parseValue(radius!, line), ...(strength ? { strength: parseValue(strength, line) } : {}), ...(c ? { color: color(c) } : {}) });
    } else if (k === "blur") effects.push({ fx: "blur", radius: parseValue(v, line) });
    else if (k === "matte") {
      const [src, mode] = v.split(":");
      if (mode && !MATTE_MODES[mode]) throw new Error(`matte mode is inv, luma or lumainv: ${line}`);
      layer.matte = { layer: src, ...(mode ? { mode: MATTE_MODES[mode] } : {}) };
    } else if (k === "color") {
      const [hue, sat, bright, contrast] = v.split(",");
      effects.push({ fx: "color", hue: parseValue(hue || "0", line), ...(sat ? { saturation: parseValue(sat, line) } : {}), ...(bright ? { brightness: parseValue(bright, line) } : {}), ...(contrast ? { contrast: parseValue(contrast, line) } : {}) });
    } else if (k === "rgb") effects.push({ fx: "chromatic", amount: parseValue(v, line) });
    else if (k === "grain") effects.push({ fx: "grain", amount: parseValue(v, line) });
    else if (k === "wave") {
      const [amp, len, speed] = v.split(",");
      effects.push({ fx: "wave", amplitude: parseValue(amp!, line), ...(len ? { wavelength: parseValue(len, line) } : {}), ...(speed ? { speed: parseValue(speed, line) } : {}) });
    } else if (k === "mblur") {
      const [shutter, samples] = v.split(",");
      effects.push({ fx: "motion_blur", ...(shutter && shutter !== "1" ? { shutter: num(shutter, line) } : {}), ...(samples ? { samples: num(samples, line) } : {}) });
    } else if (k === "adj") layer.adjustment = flag(v);
    else if (k === "mp") layer.motion_path = { ...(layer.motion_path as object), d: quoted(v, line) };
    else if (k === "mpp") layer.motion_path = { ...(layer.motion_path as object), progress: parseValue(v, line) };
    else if (k === "orient") layer.motion_path = { ...(layer.motion_path as object), orient: flag(v) };
    else if (k === "tp") layer.path = { ...(layer.path as object), d: quoted(v, line) };
    else if (k === "tpo") layer.path = { ...(layer.path as object), offset: parseValue(v, line) }; else if (k === "vis") layer.visible = flag(v);
    else if (k === "filled") layer.filled = flag(v);
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
  if (text3d) {
    for (const [from, to] of Object.entries(TEXT3D_MOVED)) {
      if (layer[from] === undefined) continue;
      node[to] = layer[from];
      delete layer[from];
    }
    if (!partial && (typeof node.text !== "string" || !node.text)) throw new Error(`text3d needs its "text" in quotes: ${line}`);
  }
  if (Object.keys(params).length) layer.params = params;
  Object.assign(layer, merge);
  if (!partial && type === USE && typeof layer.comp !== "string") throw new Error(`a use line needs comp=NAME (a component from define_component): ${line}`);
  // light= is lights.key; a JSON tail's other light fields merge with it (its own key wins).
  if (keyLight) layer.lights = { key: keyLight, ...(layer.lights as Layer | undefined) };
  if (partial) return layer;
  if (type === PARTICLES) checkParticles(layer, line);
  else if (type !== "path" && type !== USE && (layer.w === undefined || layer.h === undefined)) throw new Error(`w and h are required: ${line}`);
  if (type === "path" && typeof layer.d !== "string") throw new Error(`path needs its "M… path data" in quotes (or ic=NAME:SIZE): ${line}`);
  if (type === SHADER && typeof layer.code !== "string") throw new Error(`shader needs its WGSL in quotes: "fn shade(uv: vec2f, px: vec2f) -> vec4f { … }": ${line}`);
  if (shaderFx && typeof shaderFx.code !== "string") throw new Error(`fx0..fx7 need the shader effect's code: fx="fn shade(uv: vec2f, px: vec2f) -> vec4f { … }": ${line}`);
  if (layer.motion_path && typeof (layer.motion_path as { d?: unknown }).d !== "string") throw new Error(`mpp/orient need mp="M… path": ${line}`);
  if (layer.path && typeof (layer.path as { d?: unknown }).d !== "string") throw new Error(`tpo needs tp="M… path": ${line}`);
  return layer;
}

// ── partial edits (edit_layers) ──────────────────────────────────────────
/** Keys a partial line never changes (identity and the span it is parsed with). */
const BASE_KEYS = new Set(["id", "type", "shape", "start", "end"]);
/** Object fields merged key by key: a partial line names only some of their keys. */
const MERGED_OBJECTS = new Set(["stroke", "motion_path", "path", "camera", "inner", "sheen", "bevel", "repeat", "lights", "node"]);

/**
 * Patch fields (for the engine's `patch` op) of a partial line `key=value… ["text"]` on `layer`:
 * only the keys written change; an effect replaces only its own kind; `t=START[-END]` retimes.
 */
export function parsePartial(rest: string, layer: Layer): Record<string, unknown> {
  const type = layer.type === "shape" ? String(layer.shape ?? "rect") : String(layer.type);
  const toks = tokenize(rest);
  const timing = toks.find((t) => t.startsWith("t="));
  const body = toks.filter((t) => t !== timing).join(" ");
  const parsed = parseLine(`${layer.id} ${type} ${Number(layer.start ?? 0)} ${body}`, true);
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (BASE_KEYS.has(k)) continue;
    const old = layer[k];
    if (k === "effects") {
      const kinds = new Set((v as { fx: string }[]).map((e) => e.fx));
      fields.effects = [...((old as { fx: string }[] | undefined) ?? []).filter((e) => !kinds.has(e.fx)), ...(v as unknown[])];
    } else if (MERGED_OBJECTS.has(k) && v && typeof v === "object" && !Array.isArray(v) && old && typeof old === "object" && !Array.isArray(old)) {
      for (const [sub, sv] of Object.entries(v)) fields[`${k}.${sub}`] = sv;
    } else fields[k] = v;
  }
  if (timing) {
    const [start, end] = timing.slice(2).split("-");
    fields.start = num(start!, rest);
    if (end !== undefined) fields.end = num(end, rest);
  }
  if (!Object.keys(fields).length) throw new Error(`nothing to change in '${layer.id} ${rest}': write key=value pairs (the add_layers keys)`);
  return fields;
}

export function parseLines(text: string): Layer[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => parseLine(l));
}

const r3 = (n: number) => +n.toFixed(3);

function formatValue(v: Animated): string {
  if (typeof v === "string") return PARAM_REF.test(v) ? v : `(${v})`;
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

function gradientValue(g: Record<string, unknown>): string {
  const stops = (g.stops as [number, unknown][])
    .map(([p, c]) => {
      if (Array.isArray(c) && typeof c[0] === "object") throw new Error("needs JSON");
      return `${formatColor(c)}@${r3(p)}`;
    })
    .join(",");
  const [cx, cy] = (g.center as number[] | undefined) ?? [0.5, 0.5];
  if (g.kind === "conic") return `con:${r3(cx!)},${r3(cy!)}:${inner(g.angle ?? 0)}:${stops}`;
  if (g.kind === "radial") return `rad:${r3(cx!)},${r3(cy!)}:${inner(g.radius ?? 1)}:${stops}`;
  return `lin:${inner(g.angle ?? 0)}:${stops}`;
}

function formatGradient(g: Record<string, unknown>): string[] {
  return [`grad=${gradientValue(g)}`];
}

function formatStroke(s: Record<string, unknown>): string[] {
  if (Array.isArray(s.color) && typeof s.color[0] === "object") throw new Error("needs JSON");
  const dash = s.dash ? `:${(s.dash as number[]).map(r3).join(",")}` : "";
  const grad = s.gradient ? [`sgrad=${gradientValue(s.gradient as Record<string, unknown>)}`] : [];
  return [`stroke=${inner(s.width)}:${formatColor(s.color ?? "text")}${dash}`, ...grad];
}

function formatEffects(list: Record<string, unknown>[]): string[] {
  // The line form keeps one of each kind; repeats or unknown effects stay in JSON.
  const kinds = list.map((e) => e.fx);
  if (new Set(kinds).size !== kinds.length) throw new Error("needs JSON");
  return list.map((e) => {
    if (e.fx === "blur") return `blur=${inner(e.radius)}`;
    if (e.fx === "chromatic") return `rgb=${inner(e.amount)}`;
    if (e.fx === "grain") return `grain=${inner(e.amount)}`;
    if (e.fx === "color") return `color=${[inner(e.hue ?? 0), inner(e.saturation ?? 1), inner(e.brightness ?? 0), inner(e.contrast ?? 1)].join(",")}`;
    if (e.fx === "wave") return `wave=${[inner(e.amplitude), inner(e.wavelength ?? 200), inner(e.speed ?? 1)].join(",")}`;
    if (e.fx === "turbulence") return `turb=${[inner(e.amount), inner(e.size ?? 320), inner(e.speed ?? 1)].join(",")}`;
    if (e.fx === "motion_blur") return `mblur=${r3(Number(e.shutter ?? 180))},${Number(e.samples ?? 8)}`;
    if (e.fx === "glow") return `glow=${[inner(e.radius), inner(e.strength ?? 1), ...(e.color ? [formatColor(e.color)] : [])].join(",")}`;
    if (e.fx === "shadow") {
      const vals = [inner(e.x ?? 0), inner(e.y ?? 18), inner(e.blur ?? 36), formatColor(e.color ?? "#0f121f"), inner(e.opacity ?? 0.25)];
      return `shadow=${vals.join(",")}`;
    }
    if (e.fx === SHADER) return [`fx=${JSON.stringify(String(e.code))}`, ...formatShaderParams(e.params as Animated[] | undefined, "fx")].join(" ");
    throw new Error("needs JSON");
  });
}

/** An on/off key back to its line form (`key=1`, or `key=$param` inside a component). */
function flagOut(key: string, v: boolean | string): string[] {
  return typeof v === "string" ? [`${key}=${v}`] : v ? [`${key}=1`] : [];
}

/** `light=AZ,EL[,COLOR[,INTENSITY]]` for a key light (defaults left out). */
function formatKeyLight(k: Record<string, unknown>): string {
  const [az, el] = [inner(k.azimuth ?? KEY_LIGHT.azimuth), inner(k.elevation ?? KEY_LIGHT.elevation)];
  if (Array.isArray(k.color) && typeof k.color[0] === "object") throw new Error("needs JSON");
  const c = k.color === undefined ? KEY_LIGHT.color : formatColor(k.color);
  const intensity = k.intensity === undefined ? String(KEY_LIGHT.intensity) : inner(k.intensity);
  const tail = intensity !== String(KEY_LIGHT.intensity) ? [c, intensity] : c !== KEY_LIGHT.color ? [c] : [];
  return `light=${[az, el, ...tail].join(",")}`;
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
  ["matte", (m: { layer: string; mode?: string }) => [`matte=${m.layer}${m.mode && m.mode !== "alpha" ? `:${MATTE_SHORT[m.mode]}` : ""}`]],
  ["adjustment", (a: boolean | string) => flagOut("adj", a)],
  ["count", (c: Animated) => [`count=${formatValue(c)}`]],
  ["reveal", (r: Animated) => [`reveal=${formatValue(r)}`]],
  ["caret", (c: boolean | string) => flagOut("caret", c)],
  ["fixed", (f: boolean | string) => flagOut("fixed", f)],
  ["backdrop", (b: Animated) => [`backdrop=${formatValue(b)}`]],
  [
    "camera",
    (c: { focal?: number; focus?: Animated; aperture?: Animated }) => [
      `cam=${[String(c.focal ?? 1800), ...(c.focus !== undefined || c.aperture !== undefined ? [inner(c.focus ?? 0), inner(c.aperture ?? 0)] : [])].join(",")}`,
    ],
  ],
  [
    "inner",
    (i: Record<string, unknown>) => [`inner=${[inner(i.x ?? 0), inner(i.y ?? 0), inner(i.blur ?? 12), formatColor(i.color ?? "#0f121f"), inner(i.opacity ?? 0.25)].join(",")}`],
  ],
  ["sheen", (h: Record<string, unknown>) => [`sheen=${[inner(h.at ?? 0), inner(h.angle ?? 20), inner(h.width ?? 0.18), inner(h.opacity ?? 0.45)].join(",")}`]],
  ["bevel", (b: Record<string, unknown>) => [`bevel=${[inner(b.width ?? 6), inner(b.strength ?? 0.35)].join(",")}`]],
  [
    "motion_path",
    (m: { d: string; progress?: Animated; orient?: boolean | string }) => [
      `mp=${JSON.stringify(m.d)}`,
      ...(m.progress !== undefined ? [`mpp=${formatValue(m.progress)}`] : []),
      ...flagOut("orient", m.orient ?? false),
    ],
  ],
  ["path", (p: { d: string; offset?: Animated }) => [`tp=${JSON.stringify(p.d)}`, ...(p.offset !== undefined ? [`tpo=${formatValue(p.offset)}`] : [])]],
  ["pivot", (p: number[]) => [`pivot=${p.map(r3).join(",")}`]],
];

/** One layer JSON -> one line (what the agent reads back). Fields without a short form go in `{…}`. */
export function formatLayer(l: Layer): string {
  const text3d = isText3d(l);
  const type = text3d ? "text3d" : l.type === "shape" ? String(l.shape ?? "rect") : String(l.type);
  const parts = [String(l.id), type, `${r3(Number(l.start ?? 0))}${l.end == null ? "" : `-${r3(Number(l.end))}`}`];
  const done = new Set(["id", "type", "shape", "start", "end", "comp"]);
  const extra: Layer = {};
  if (type === USE) {
    parts.push(`comp=${String(l.comp)}`);
    // An instance has no box or color of its own: the engine's defaults are noise here.
    for (const [k, rest] of [["w", 0], ["h", 0], ["fill", "primary"]] as const) if (l[k] === rest) done.add(k);
  }
  if (l.group) parts.push(`g=${l.group}`);
  done.add("group");
  for (const [long, short] of Object.entries(NUM_SHORT)) {
    if (done.has(long)) continue;
    const v = l[long] as Animated | undefined;
    done.add(long);
    if (v === undefined || v === DEFAULTS[long]) continue;
    // A point emitter has no size.
    if (l.type === PARTICLES && (long === "w" || long === "h") && v === 0) continue;
    try {
      parts.push(`${short}=${formatValue(v)}`);
    } catch {
      extra[long] = v;
    }
  }
  if (l.accent !== undefined && (!Array.isArray(l.accent) || typeof l.accent[0] === "number")) parts.push(`accent=${formatColor(l.accent)}`);
  else if (l.accent !== undefined) extra.accent = l.accent;
  done.add("accent");
  if (l.fill !== undefined && !done.has("fill")) {
    if (!Array.isArray(l.fill) || typeof l.fill[0] === "number") parts.push(`fill=${formatColor(l.fill)}`);
    else {
      const keys = l.fill as { t: number; c: unknown; ease?: string; bezier?: unknown }[];
      if (keys.some((k) => k.bezier)) extra.fill = l.fill;
      else parts.push(`fill=${keys.map((k, i) => `${r3(k.t)}:${formatColor(k.c)}${k.ease && i < keys.length - 1 ? `:${EASE_SHORT[k.ease] ?? k.ease}` : ""}`).join(",")}`);
    }
  }
  done.add("fill");
  if (l.type === PARTICLES) parts.push(...formatParticles(l, done));
  for (const [short, long] of Object.entries(PLAIN_NUM)) {
    if (done.has(long)) continue;
    if (l[long] !== undefined && l[long] !== 0) parts.push(`${short}=${l[long]}`);
    done.add(long);
  }
  for (const k of PLAIN_STR) {
    if (done.has(k)) continue;
    if (l[k] !== undefined) parts.push(`${k}=${l[k]}`);
    done.add(k);
  }
  if (l.lights && typeof l.lights === "object") {
    const { key, ...rest } = l.lights as Record<string, unknown>;
    try {
      if (!key || typeof key !== "object") throw new Error("needs JSON");
      parts.push(formatKeyLight(key as Record<string, unknown>));
      if (Object.keys(rest).length) extra.lights = rest;
    } catch {
      extra.lights = l.lights;
    }
    done.add("lights");
  }
  if (type === VIDEO) {
    for (const k of VIDEO_NUM) {
      if (typeof l[k] === "number" && l[k] !== VIDEO_DEFAULTS[k]) parts.push(`${k}=${r3(l[k] as number)}`);
      if (typeof l[k] === "number") done.add(k);
    }
    if (l.loop === true) parts.push("loop=1");
    if (typeof l.loop === "boolean") done.add("loop");
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
  if (l.type === "object") {
    if (l.finish !== undefined && l.finish !== DEFAULT_FINISH) parts.push(`finish=${l.finish}`);
    done.add("finish");
    const spin = l.spin as Animated[] | undefined;
    if (spin?.some((v) => v !== 0)) {
      try {
        const vals = spin.map(formatValue);
        parts.push(`spin=${vals.join(vals.some((v) => !v.startsWith("(") && v.includes(",")) ? ";" : ",")}`);
      } catch {
        extra.spin = spin;
      }
    }
    done.add("spin");
    if (l.fov !== undefined && l.fov !== DEFAULT_FOV) parts.push(`fov=${l.fov}`);
    done.add("fov");
  }
  if (text3d) {
    const node = l.node as Record<string, unknown>;
    if (textField(node, "depth")) parts.push(`depth=${node.depth}`);
    if (node.family !== undefined) parts.push(`family=${/\s/.test(String(node.family)) ? JSON.stringify(node.family) : node.family}`);
    if (node.weight !== undefined) parts.push(`weight=${node.weight}`);
    if (textField(node, "align")) parts.push(`align=${node.align}`);
    if (textField(node, "letter_spacing")) parts.push(`ls=${node.letter_spacing}`);
    if (textField(node, "line_height")) parts.push(`lh=${node.line_height}`);
    done.add("node");
  }
  if (type === SHADER) {
    try {
      parts.push(...formatShaderParams(l.params as Animated[] | undefined, "p"));
      done.add("params");
    } catch {
      // A param with bezier keys stays in the JSON tail.
    }
    done.add("code");
  }
  if (l.visible === false) parts.push("vis=0");
  else if (typeof l.visible === "string") parts.push(`vis=${l.visible}`);
  parts.push(...flagOut("filled", (l.filled as boolean | string | undefined) ?? false));
  done.add("visible");
  done.add("filled");
  // The icon name reads back as ic= (not again in the JSON tail).
  done.add("icon");
  // Instance params read back as $name=value (shader layers keep theirs as p0..p7 above).
  if (l.type === USE && l.params && typeof l.params === "object") {
    done.add("params");
    try {
      parts.push(...Object.entries(l.params as Record<string, unknown>).map(([k, v]) => `$${k}=${formatParamValue(v)}`));
    } catch {
      extra.params = l.params;
    }
  }
  for (const [k, v] of Object.entries(l)) if (!done.has(k) && k !== "text" && k !== "d") extra[k] = v;
  if (typeof l.icon === "string") parts.push(`ic=${l.icon}`);
  const quoted = type === "path" || type === PARTICLES ? (l.icon ? undefined : l.d) : type === SHADER ? l.code : text3d ? (l.node as { text: string }).text : l.text;
  if (quoted !== undefined) parts.push(JSON.stringify(String(quoted)));
  if (Object.keys(extra).length) parts.push(JSON.stringify(extra));
  return parts.join(" ");
}
