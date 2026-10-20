#!/usr/bin/env node
/**
 * Motionily MCP server: the agent's hands on one project.
 * The user writes a brief in the editor; the agent designs and animates everything,
 * builds the video with small ops (rendered live in the editor) and iterates
 * on the user's feedback.
 */
import { findIcons } from "./icons.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  FeedbackKind,
  ImageSource,
  OpName,
  VideoFormat,
  type Feedback,
  type FrameLayout,
  type Op,
  type Project,
} from "@motionily/protocol";
import { EditorBridge } from "./bridge.js";
import { HeadlessEditor } from "./headless.js";
import { formatLayer, formatParams, parseLines, parseParams, parsePartial, type ParamDef } from "./compact.js";
import { ProjectApi, VIDEO_ASSET, clipFacts, posterTimes } from "./api.js";
import { formatLayouts } from "./layout.js";
import { isRef, resolveLayerTimes, type Word } from "./timing.js";
import { formatIssues, lintLayers, type Layer as LintLayer, type Palette } from "./lint.js";
import { placementPatches, type Box } from "./place.js";
import { Checkpoints, diffScenes } from "./checkpoints.js";
import { describeExample, examplesDir, loadExamples, rankExamples, saveExample } from "./examples.js";
import { nextSteps, type ProjectState } from "./nextstep.js";
import { frameStats } from "./review.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const doc = (name: string) => readFileSync(resolve(here, "../../../docs/agent", name), "utf8").trim();
/** The whole manual: workflow and tools, layer syntax with the exact camera math, then design direction. */
const MANUAL = ["manual.md", "syntax.md", "craft.md", "motion-2d.md"].map(doc).join("\n\n");

/** Shown by the client before the first call (kept short: clients truncate long instructions). */
const INSTRUCTIONS = `Motionily: you build motion-graphics videos for the user's project through these tools. There are no presets.
START: call get_project and get_brand in parallel. get_project's answer includes the complete manual (workflow, layer
syntax, exact camera/depth/perspective formulas, ops, 3D). Read it instead of experimenting.
Never test how the engine behaves (no debug rectangles, no trial renders to learn what z, rx/ry or the camera do): the
formulas are exact, and get_layout returns where every layer lands on screen as numbers.
Work in few, big calls: one apply_ops for palette and duration, one add_layers per beat with all its lines, get_layout to
check placement, review_video once or twice, one add_sfx.`;

const token = process.env.MOTIONILY_TOKEN;
const projectId = process.env.MOTIONILY_PROJECT;
if (!token || !projectId) {
  console.error("[motionily] MOTIONILY_TOKEN and MOTIONILY_PROJECT are required. Get them from 'Conectar agente' in the editor.");
  process.exit(1);
}
const apiUrl = process.env.MOTIONILY_API ?? "http://localhost:3100";
const api = new ProjectApi(apiUrl, token, projectId);
const bridge = new EditorBridge(apiUrl, token, projectId);
// Without the user's editor open, the agent works in its own invisible one.
if (process.env.MOTIONILY_HEADLESS !== "0") {
  bridge.headless = new HeadlessEditor(process.env.MOTIONILY_WEB ?? "http://localhost:5173", projectId, () => api.headlessSession());
}

const server = new McpServer({ name: "motionily", version: "0.3.0" }, { instructions: INSTRUCTIONS });

// Agents launched by the API carry the manual in their system prompt; everyone else gets it once from get_project.
let manualSent = process.env.MOTIONILY_MANUAL === "0";

// Each team role only sees the tools it needs: every tool description costs context on every turn.
const onlyTools = process.env.MOTIONILY_TOOLS?.split(",").map((t) => t.trim()).filter(Boolean);
if (onlyTools?.length) {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, ...rest: unknown[]) =>
    onlyTools.includes(String(name)) ? register(name, ...rest) : undefined;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });
const guard =
  <A,>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail((e as Error).message);
    }
  };


server.registerTool(
  "get_project",
  {
    description:
      "START HERE (in parallel with get_brand). The user's brief, the format and the current scene state; the first call also returns the complete manual.",
    inputSchema: {},
  },
  guard(async () => {
    const project = describeProject(await api.project());
    if (manualSent) return text(project);
    manualSent = true;
    return text(`${project}\n\n---\n\n${MANUAL}`);
  }),
);

const PREFAB_NAME = /^[a-z0-9_]{2,40}$/;
const PrefabKindEnum = z.enum(["object", "character", "space"]);

server.registerTool(
  "list_prefabs",
  {
    description:
      "The user's 3D prefab library (objects, procedural characters, whole spaces), shared by all their projects. Reuse before building anything new.",
    inputSchema: {},
  },
  guard(async () => {
    const rows = await api.prefabs();
    return text(rows.map((p) => `${p.name} | ${p.kind} | v${p.version}${p.parent ? ` (from ${p.parent})` : ""} | ${p.description}`).join("\n") || "No prefabs yet: build them with save_prefab.");
  }),
);

server.registerTool(
  "get_prefab",
  { description: "Full procedural tree of a prefab (to tweak it and save_prefab again, or to learn from it).", inputSchema: { name: z.string() } },
  guard(async ({ name }) => text(JSON.stringify((await api.prefab(name)).node))),
);

server.registerTool(
  "save_prefab",
  {
    description:
      "Create or update a reusable 3D prefab in the user's library from a procedural tree (manual: 3D). Use it in a scene with put_prop {prefab: name}. Updating a prefab changes it everywhere it is used.",
    inputSchema: {
      name: z.string().regex(PREFAB_NAME),
      kind: PrefabKindEnum,
      description: z.string().max(400),
      node: z.record(z.string(), z.unknown()),
    },
  },
  guard(async ({ name, kind, description, node }) => {
    await api.savePrefab(name, { kind, node, description });
    if (bridge.connected) {
      const res = await bridge.applyOps([{ op: OpName.DefinePrefab, name, node }]);
      if (!res.ok) return fail(`Saved '${name}', but the engine rejected the tree: ${res.error}`);
    }
    return text(`Saved prefab '${name}'. Place it with put_prop {"prefab":"${name}"}.`);
  }),
);

server.registerTool(
  "clone_prefab",
  {
    description: "Copy a prefab under a new name (e.g. a blue, lower version of the treatment table), then reshape the copy with get_prefab + save_prefab. The original stays untouched.",
    inputSchema: { from: z.string(), name: z.string().regex(PREFAB_NAME), description: z.string().max(400).optional() },
  },
  guard(async ({ from, name, description }) => {
    const copy = await api.clonePrefab(from, name, description);
    if (bridge.connected) await bridge.applyOps([{ op: OpName.DefinePrefab, name, node: copy.node }]);
    return text(`Cloned '${from}' as '${name}'.`);
  }),
);

server.registerTool(
  "search_fonts",
  {
    description: "Search the whole Google Fonts catalog (most popular first). Category: Sans Serif, Serif, Display, Handwriting, Monospace.",
    inputSchema: { query: z.string(), category: z.string().optional() },
  },
  guard(async ({ query, category }) => {
    const fonts = await api.fonts(query, category);
    return text(fonts.slice(0, 20).map((f) => `${f.family} | ${f.category} | ${f.weights.join(",")}`).join("\n") || "No fonts.");
  }),
);

server.registerTool(
  "set_font",
  {
    description: "Use any Google Font as the video's typography (exact family name from search_fonts). Picks body/heading weights near 500/700.",
    inputSchema: { family: z.string() },
  },
  guard(async ({ family }) => {
    const match = (await api.fonts(family)).find((f) => f.family.toLowerCase() === family.toLowerCase());
    if (!match) return fail(`No Google font named '${family}'. Use search_fonts.`);
    const near = (w: number) => match.weights.reduce((b, x) => (Math.abs(x - w) < Math.abs(b - w) ? x : b));
    const res = await bridge.applyOps([{ op: "set_typography", typography: { family: match.family, body: near(500), heading: near(700) } }]);
    if (!res.ok) return fail(res.error ?? "rejected");
    return text(`typography = ${match.family} (${near(500)}/${near(700)})`);
  }),
);

server.registerTool(
  "set_format",
  {
    description: "Change the video frame: vertical_9_16, portrait_4_5, square_1_1 or horizontal_16_9 (1080p). Re-place layers afterwards (anchors adapt by themselves).",
    inputSchema: { format: z.enum(Object.values(VideoFormat) as [VideoFormat, ...VideoFormat[]]) },
  },
  guard(async ({ format }) => {
    await api.update({ format });
    return text(`format = ${format}`);
  }),
);

server.registerTool(
  "get_brand",
  {
    description:
      "The project's brand kit: what the product is (notes), brand palettes, and every logo/screenshot/photo/video clip with the user's description of what it shows and how it works. Read it before designing; use view_asset to look at an image or a clip's contact sheet.",
    inputSchema: {},
  },
  guard(async () => {
    const b = await api.brand();
    const lines = [`Brand: ${b.name}`, `About: ${b.notes.trim() || "(no notes)"}`];
    for (const p of b.palettes) lines.push(`Palette "${p.name}": bg ${p.background}, surface ${p.surface}, primary ${p.primary}, accent ${p.accent}, text ${p.text}`);
    for (const a of b.assets)
      lines.push(`Asset ${a.id} | ${a.kind} | ${a.name} | src "${a.url}"${a.kind === VIDEO_ASSET ? ` | ${clipFacts(a)}` : ""} | ${a.description || "(no description)"}`);
    if (!b.assets.length) lines.push("No images yet.");
    return text(lines.join("\n"));
  }),
);

server.registerTool(
  "view_image",
  {
    description: "Look at an image by its /media/… path: a reference the user attached (not brand material unless they say so) or a photo you imported (you see a small preview; the layer still uses the full src).",
    inputSchema: { url: z.string().regex(/^\/media\/[a-f0-9-]{36}\.[a-z0-9]{1,5}$/) },
  },
  async ({ url }) => {
    try {
      // Imported photos are big: show their preview so a few of them do not flood the context.
      const preview = (await api.project()).imageCredits?.find((c) => c.src === url)?.preview;
      const img = await api.media(preview ?? url);
      return { content: [{ type: "image" as const, data: img.bytes.toString("base64"), mimeType: img.mime }] };
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "view_asset",
  {
    description:
      "Look at one brand image (logo, product screenshot…) to understand it before recreating or showing it; for a video clip, its contact sheet (12 frames with their seconds). Put it in the video as an image or video layer with its src.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      const asset = (await api.brand()).assets.find((a) => a.id === id);
      if (!asset) return fail(`No asset '${id}'. See get_brand.`);
      if (asset.kind === VIDEO_ASSET) {
        const about = `${asset.name} (video clip, ${clipFacts(asset)}): ${asset.description || "no description"}. Use src "${asset.url}" in a video layer (in=/out= trim seconds of this file).`;
        if (!asset.poster || !asset.duration) return text(`${about} No contact sheet: the file could not be read on upload.`);
        const sheet = await api.media(asset.poster);
        const times = posterTimes(asset.duration).map((t) => `${t}s`).join(", ");
        return {
          content: [
            { type: "text" as const, text: `${about} Contact sheet, 4×3 frames left→right, top→bottom at ${times}.` },
            { type: "image" as const, data: sheet.bytes.toString("base64"), mimeType: sheet.mime },
          ],
        };
      }
      const img = await api.media(asset.url);
      return {
        content: [
          { type: "text" as const, text: `${asset.name} (${asset.kind}): ${asset.description || "no description"}. Use src "${asset.url}" in an image layer.` },
          { type: "image" as const, data: img.bytes.toString("base64"), mimeType: img.mime },
        ],
      };
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "get_reference",
  { description: "The complete manual again (get_project already returned it once): workflow, layer syntax, camera math, ops, 3D, design direction.", inputSchema: {} },
  async () => {
    manualSent = true;
    return text(MANUAL);
  },
);

server.registerTool(
  "get_layout",
  {
    description:
      "Where every layer lands ON SCREEN at the given seconds, as numbers (after camera, depth and tilted planes): box x0,y0→x1,y1, scale k, depth z, plane, flags (OFF FRAME, % off frame, tiny, hidden) and layers the camera already passed. Text boxes are real glyph ink. Cheap (no images): use it to check placement instead of rendering test frames. In big scenes pass group or ids.",
    inputSchema: {
      times: z.array(z.number().min(0)).min(1).max(12).describe("seconds"),
      ids: z.array(z.string()).optional().describe("only these layers (also shows them when hidden)"),
      group: z.string().optional().describe("only this group"),
      hidden: z.boolean().optional().describe("include vis=0 layers (nulls, planes, mattes)"),
    },
  },
  guard(async ({ times, ids, group, hidden }) => {
    const res = await bridge.layout(times);
    if (!res.ok || !res.layouts) return fail(res.error ?? "no layout");
    const scene = await currentScene();
    const size: [number, number] = [Number(scene?.width ?? 1920), Number(scene?.height ?? 1080)];
    return text(formatLayouts(res.layouts, size, { ids, group, hidden }));
  }),
);

/** Latest scene: live from the editor when open, else the autosave. */
async function currentScene(): Promise<Record<string, unknown> | null> {
  const live = bridge.lastScene;
  return live ? (JSON.parse(live) as Record<string, unknown>) : (await api.project()).scene;
}

/** How often an MCP server checks whether its claude parent died. */
const ORPHAN_CHECK_MS = 5_000;

/** Default level for effects so they sit under a voice-over. */
const SFX_GAIN = 0.45;

const layersOf = (scene: Record<string, unknown> | null) => (scene?.layers as Record<string, unknown>[] | undefined) ?? [];

// ── write-time checks: timing references, lint with fixes, placement, and the session's state for next_step ──
const checkpoints = new Checkpoints();
const session = { editsSinceReview: false, reviewed: false, lintIds: [] as string[] };
/** Used only when the scene carries no palette of its own: white paper with a blue and an orange accent. */
const DEFAULT_PALETTE: Palette = { background: "#ffffff", surface: "#ffffff", primary: "#3c8cff", accent: "#ff8a3d", text: "#0b0b14" };
const wordsOf = (scene: Record<string, unknown> | null): Word[] =>
  ((scene?.captions as { words?: { text: string; start: number; end: number }[] } | undefined)?.words ?? []).map((w) => ({ text: String(w.text), start: Number(w.start), end: Number(w.end) }));
/** The palette the frames were drawn with (engine, hex); the scene's own palette, else the fallback. */
const paletteOf = (scene: Record<string, unknown> | null, frames: FrameLayout[] = []): Palette => {
  const engine = frames.find((f) => f.palette)?.palette;
  const own = scene?.palette && typeof scene.palette === "object" ? (scene.palette as Partial<Palette>) : {};
  return { ...DEFAULT_PALETTE, ...own, ...(engine ?? {}) };
};
const sizeOf = (scene: Record<string, unknown> | null): [number, number] => [Number(scene?.width ?? 1080), Number(scene?.height ?? 1920)];
const durationOf = (scene: Record<string, unknown> | null) => Number(scene?.duration ?? 6);

/** Up to `n` evenly spaced instants out of `ts`. */
function spread(ts: number[], n: number): number[] {
  const u = [...new Set(ts.map((t) => +Math.max(0, t).toFixed(3)))].sort((a, b) => a - b);
  if (u.length <= n) return u;
  return Array.from({ length: n }, (_, i) => u[Math.round((i * (u.length - 1)) / (n - 1))]!);
}

/** Layout at these instants from the editor; null when it is not connected. */
async function layoutAt(times: number[]): Promise<FrameLayout[] | null> {
  const out: FrameLayout[] = [];
  const picks = spread(times, 24);
  for (let i = 0; i < picks.length; i += 12) {
    const res = await bridge.layout(picks.slice(i, i + 12));
    if (!res.ok || !res.layouts) return null;
    out.push(...res.layouts);
  }
  return out;
}

/** Screen box lookup over a set of frames: the frame nearest to `t`. */
function boxFinder(list: FrameLayout[]) {
  return (id: string, t: number): Box | null => {
    const frame = list.reduce((best, f) => (Math.abs(f.t - t) < Math.abs(best.t - t) ? f : best), list[0]!);
    const row = frame?.layers.find((r) => r.id === id);
    return row ? (row.screen as Box) : null;
  };
}

/** Resolve `@phrase`/`@word` times inside ops (start/end on the op, its fields, or its new layer). */
function resolveOpTimes(ops: Record<string, unknown>[], words: Word[]) {
  for (const op of ops) {
    for (const holder of [op, op.fields, op.layer]) if (holder && typeof holder === "object") resolveLayerTimes([holder as Record<string, unknown>], words);
  }
}

/** Layer ids an ops batch writes to. */
function opsIds(ops: Record<string, unknown>[]): string[] {
  return ops.flatMap((op) => {
    const ids = [op.id, (op.layer as { id?: unknown } | undefined)?.id, ...(Array.isArray(op.ids) ? op.ids : [])];
    return ids.filter((x): x is string | number => typeof x === "string" || typeof x === "number").map(String);
  });
}

/**
 * After a write: move layers placed with place= to their anchors, then lint the touched layers
 * at their own times. Returns the lines to show the agent (placements, issues with fix ops).
 */
async function settle(touched: string[], hint: Record<string, unknown>[] = []): Promise<string[]> {
  const live = await currentScene();
  const byId = new Map(layersOf(live).map((l) => [String(l.id), l]));
  for (const l of hint) byId.set(String(l.id), { ...byId.get(String(l.id)), ...l });
  const layers = [...byId.values()] as LintLayer[];
  const scene = live ?? {};
  const duration = durationOf(scene);
  const size = sizeOf(scene);
  const notes: string[] = [];
  const placed = layers.filter((l) => l.place);
  if (placed.length) {
    const times = placed.flatMap((l) => [Number(l.start ?? 0), Number((byId.get(String((l.place as { of?: string }).of))?.start ?? 0))]);
    const list = await layoutAt(times);
    if (!list) notes.push("placement skipped: the editor is not connected");
    else {
      const patches = placementPatches(layers, boxFinder(list), size);
      if (patches.length) {
        const res = await bridge.applyOps(patches.map((p) => p.op) as Op[]);
        notes.push(res.ok ? `placed (place=): ${patches.map((p) => `${p.id} at x=${p.x} y=${p.y}`).join("; ")}` : `placement rejected: ${res.error ?? "?"}`);
      }
    }
  }
  const ids = new Set(touched);
  const times: number[] = [];
  for (const l of layers) {
    if (!ids.has(String(l.id)) || l.visible === false) continue;
    const start = Number(l.start ?? 0);
    const end = l.end == null ? duration : Math.min(Number(l.end), duration);
    times.push(start, (start + Math.max(start, end)) / 2);
  }
  if (!times.length) return notes;
  const list = await layoutAt(times);
  if (!list) return [...notes, "lint skipped: the editor is not connected"];
  const issues = lintLayers({ layers, frames: list, palette: paletteOf(scene, list), size }).filter((i) => i.id.split("+").some((part) => ids.has(part)));
  session.lintIds = [...new Set(issues.map((i) => i.id))];
  return [...notes, ...(issues.length ? formatIssues(issues) : ["lint: clean"])];
}

server.registerTool(
  "add_layers",
  {
    description:
      "Add or replace layers with COMPACT LINES (far cheaper than JSON): `id type start[-end] key=value… \"text or path data\" {json}`. Types rect|ellipse|text|image|path|object|text3d|particles|use|shader (`id use START comp=NAME x= y= s= $param=value…` places a component from define_component; shader = custom WGSL with p0..p7 params; fx=\"WGSL\" fx0..fx7 = shader effect on any layer). Values: number, tween `from>to@t0-t1[:ease]`, keys `t:v[:ease],…`, or `(expression)`. Keys: x y w h s r o rad pivot parent fill grad stroke soft shadow glow blur blend matte vis rep size role align lh ls ts te to filled g src fit z rx ry persp cam fixed light (object key light AZ,EL[,COLOR,INTENSITY]); particles: emit rate burst life speed dir spread grav drag wind wander look size alpha colors (manual: Particles). A trailing {json} merges any field (e.g. text animators). Full syntax, camera math and recipes are in the manual (get_project / get_reference). An existing id is replaced.",
    inputSchema: { lines: z.string().min(1) },
  },
  guard(async ({ lines }) => {
    let layers;
    try {
      layers = parseLines(lines);
      resolveLayerTimes(layers, wordsOf(await currentScene()));
    } catch (e) {
      return fail((e as Error).message);
    }
    const existing = new Set(layersOf(await currentScene()).map((l) => String(l.id)));
    const ops = layers.flatMap((layer) => [...(existing.has(String(layer.id)) ? [{ op: "remove_layer", id: layer.id }] : []), { op: "add_layer", layer }]);
    const res = await bridge.applyOps(ops as Op[]);
    if (!res.ok) return fail(res.error ?? "rejected");
    session.editsSinceReview = true;
    const notes = await settle(layers.map((l) => String(l.id)), layers);
    return text([`${layers.length} layers ok`, ...notes].join("\n"));
  }),
);

// ── components ──
type ComponentDef = { params?: ParamDef[]; duration?: number; layers: Record<string, unknown>[] };
const COMPONENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

function componentsOf(scene: Record<string, unknown> | null): Record<string, ComponentDef> {
  return (scene?.library as { components?: Record<string, ComponentDef> } | undefined)?.components ?? {};
}

server.registerTool(
  "define_component",
  {
    description:
      "Define or redefine a reusable component (a precomp with params): typed params + compact lines (add_layers syntax; x/y relative to the instance center). In the lines any value may be `$param`, expressions read `($param*2)`, text interpolates \"$param\". Place it with add_layers `id use START comp=NAME x= y= $param=value…`; redefining updates every instance. Exact rules: manual, Components.",
    inputSchema: {
      name: z.string().regex(COMPONENT_NAME),
      params: z.string().optional().describe('name:type[=default] … — types number|color|text|src|bool|path, e.g. title:text="Revenue" value:number=0 icon:path=ic:chart-line:40 accent:color=accent'),
      duration: z.number().positive().optional().describe("seconds an instance added without end lasts (default: until the video ends)"),
      lines: z.string().min(1),
    },
  },
  guard(async ({ name, params, duration, lines }) => {
    let component: ComponentDef;
    try {
      component = { params: params ? parseParams(params) : [], ...(duration ? { duration } : {}), layers: parseLines(lines) };
    } catch (e) {
      return fail((e as Error).message);
    }
    const res = await bridge.applyOps([{ op: OpName.DefineComponent, name, component }]);
    if (!res.ok) return fail(res.error ?? "rejected");
    const ps = component.params ?? [];
    return text(`component '${name}': ${component.layers.length} layers, params ${ps.map((p) => `$${p.name}`).join(" ") || "none"}. Place it: \`id use START comp=${name} x= y= ${ps.map((p) => `$${p.name}=…`).join(" ")}\``);
  }),
);

server.registerTool(
  "get_component",
  {
    description: "Read a component back as define_component input (params + compact lines). Without name: every component and its params.",
    inputSchema: { name: z.string().optional() },
  },
  guard(async ({ name }) => {
    const comps = componentsOf(await currentScene());
    if (!name)
      return text(Object.entries(comps).map(([n, c]) => `${n}${c.duration ? ` ${c.duration}s` : ""}: ${formatParams(c.params ?? []) || "(no params)"}`).join("\n") || "No components yet: define_component.");
    const c = comps[name];
    if (!c) return fail(`No component '${name}'. Defined: ${Object.keys(comps).join(", ") || "none"}`);
    return text([`name=${name}${c.duration ? ` duration=${c.duration}` : ""}`, `params=${formatParams(c.params ?? [])}`, "lines:", ...c.layers.map(formatLayer)].join("\n"));
  }),
);
// ── end components ──

server.registerTool(
  "list_sounds",
  {
    description: "The user's sound effect library (whooshes, pops, clicks, risers, impacts, chimes, glitches, UI, beds): name | category | seconds | description.",
    inputSchema: {},
  },
  guard(async () => {
    const rows = await api.sounds();
    return text(rows.map((s) => `${s.name} | ${s.category} | ${s.duration}s | ${s.description}`).join("\n") || "No sounds yet: the user can create them in Sonidos.");
  }),
);

server.registerTool(
  "find_icons",
  {
    description:
      "Search 1,900 clean line icons (Lucide) by words: returns icon names. Use them in add_layers as path layers: `bell path 1 x=300 y=200 ic=bell:48 stroke=2.5:text` (centered on x,y; SIZE px). Real icons make UI look real — never hand-draw icons.",
    inputSchema: { query: z.string().min(1).describe("words, e.g. 'chart growth' or 'mail send'"), limit: z.number().int().min(1).max(60).default(24) },
  },
  guard(async ({ query, limit }) => {
    const names = findIcons(query, limit);
    return text(names.length ? names.join(", ") : `no icon matches '${query}'; try simpler words`);
  }),
);

const THUMB_TIMEOUT_MS = 8000;
/** Wikimedia asks every client to identify itself. */
const THUMB_HEADERS = { "User-Agent": "Motionily/0.1 (https://github.com/sergiosoftdev/motionily)" };

/** Hits per query by default: a few per subject is enough to choose, and every thumbnail costs context. */
const HITS_PER_QUERY = 4;

server.registerTool(
  "search_images",
  {
    description:
      "Find REAL photos (history, places, people, events, nature, documentary) in free libraries: Wikimedia Commons and Openverse. Only reusable licenses come back (public domain, CC0, CC BY, CC BY-SA). Put ALL your queries in ONE call (one per subject); you see each hit's small thumbnail with its id, size, date and license: pick by looking, then import_image. Queries in English (better results), names, places and years.",
    inputSchema: {
      queries: z.array(z.string().min(2).max(120)).min(1).max(8).describe("one per subject, e.g. ['Spanish Civil War Madrid 1936 barricade', 'Guernica 1937 ruins']"),
      source: z.enum([ImageSource.Commons, ImageSource.Openverse]).optional().describe("one library only; default both"),
      per_query: z.number().int().min(1).max(8).default(HITS_PER_QUERY),
    },
  },
  async ({ queries, source, per_query }) => {
    try {
      const results = await Promise.all(queries.map((q) => api.searchImages(q, per_query, source)));
      const seen = new Set<string>();
      const groups = results.map((r, i) => ({ query: queries[i]!, hits: r.hits.filter((h) => !seen.has(h.id) && seen.add(h.id)) }));
      const unavailable = [...new Set(results.flatMap((r) => r.unavailable.map((u) => u.split(" (")[0]!)))];
      const hits = groups.flatMap((g) => g.hits);
      const thumbs = await Promise.all(
        hits.map(async (h) => {
          try {
            const res = await fetch(h.thumb, { headers: THUMB_HEADERS, signal: AbortSignal.timeout(THUMB_TIMEOUT_MS) });
            const mime = res.headers.get("content-type") ?? "";
            return res.ok && mime.startsWith("image/") ? { data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType: mime.split(";")[0]! } : null;
          } catch {
            return null;
          }
        }),
      );
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
      if (unavailable.length) content.push({ type: "text", text: `Unavailable right now: ${unavailable.join(", ")}` });
      let n = 0;
      for (const g of groups) {
        content.push({ type: "text", text: g.hits.length ? `## ${g.query}` : `## ${g.query}: no reusable images (try other words: names, places, years)` });
        for (const h of g.hits) {
          const facts = [h.title, h.date, `${h.width}x${h.height}`, h.license, `by ${h.author}`, h.description].filter(Boolean).join(" | ");
          content.push({ type: "text", text: `[${n + 1}] id="${h.id}" ${facts}` });
          const t = thumbs[n++];
          if (t) content.push({ type: "image", ...t });
        }
      }
      return { content };
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "import_image",
  {
    description:
      "Import search_images hits into this video: downloads each one (up to 2560 px wide) and records its credit. Returns the src for image layers (`fit=cover`). Import only what you will show.",
    inputSchema: { ids: z.array(z.string().min(3)).min(1).max(12).describe("ids from search_images") },
  },
  guard(async ({ ids }) => {
    const lines = await Promise.all(
      ids.map((id) =>
        api.importImage(id).then(
          (c) => `${id} -> src "${c.src}" (${c.license}, ${c.author})`,
          (e: Error) => `${id} -> FAILED: ${e.message}`,
        ),
      ),
    );
    return text(`${lines.join("\n")}\nCredits are kept with the video; the user sees them in the editor.`);
  }),
);

server.registerTool(
  "add_sfx",
  {
    description:
      "Place sound effects on the timeline, one per line: `id sound_name at [gain]` (at = seconds from the video start, gain 0.1-1, default 0.45; keep 0.3-0.6 under a voice, never above 0.8 — the user has an effects volume slider). Same id moves/replaces it. Sync them to motion: whoosh/swipe on moves and transitions (start ~0.1 s before), pop on entrances, click/tick on UI and counters, impact on hero text landing, riser before reveals, chime on positive results. 1 sound per meaningful event; never stack more than 2 at once.",
    inputSchema: { lines: z.string().min(1) },
  },
  guard(async ({ lines }) => {
    const library = new Map((await api.sounds()).map((s) => [s.name, s]));
    const ops: Op[] = [];
    for (const line of lines.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [id, name, at, gain] = line.split(/\s+/);
      const sound = library.get(name ?? "");
      if (!id || !sound || !Number.isFinite(Number(at))) return fail(`bad line '${line}' (expected 'id sound_name at [gain]'; sounds: ${[...library.keys()].slice(0, 40).join(", ")})`);
      ops.push({ op: "put_sfx", cue: { id, sound: sound.name, src: sound.url, at: Number(at), gain: gain ? Number(gain) : SFX_GAIN } } as Op);
    }
    const res = await bridge.applyOps(ops);
    return res.ok ? text(`${ops.length} sounds placed`) : fail(res.error ?? "rejected");
  }),
);

server.registerTool(
  "inspect",
  {
    description:
      "Read the scene: no target or 'scene' = the summary (full=true for exact keyframes and every layer as compact lines); a layer id = that layer as compact lines; 'group:NAME' = every layer of a group with its times. Read before you change something you did not write this session.",
    inputSchema: {
      target: z.string().optional().describe("scene (default) · LAYER_ID · group:NAME"),
      full: z.boolean().optional(),
    },
  },
  guard(async ({ target, full }) => {
    const want = target?.trim() || "scene";
    if (want === "scene") {
      if (!full && bridge.connected && bridge.lastSummary) return text(bridge.lastSummary);
      const { scene } = await api.project();
      if (!scene) return text("Empty project: no scene yet. Start with load_scene.");
      if (!full) return text(`${bridge.connected ? "" : "(editor closed) "}${JSON.stringify(scene).slice(0, 2000)}`);
      const { layers, ...rest } = scene as Record<string, unknown>;
      return text(`${JSON.stringify(rest)}\nlayers (compact lines):\n${layersOf({ layers }).map(formatLayer).join("\n")}`);
    }
    const scene = await currentScene();
    const layers = layersOf(scene) as { id: string; group?: string; start?: number; end?: number | null }[];
    if (want.startsWith("group:")) {
      const group = want.slice(6);
      const members = layers.filter((l) => l.group === group);
      if (!members.length) return fail(`No group '${group}'. Groups: ${[...new Set(layers.map((l) => l.group).filter(Boolean))].join(", ") || "none"}`);
      const start = Math.min(...members.map((l) => l.start ?? 0));
      return text(`group ${group}: ${members.length} layers from ${start}s (compact lines; edit with add_layers)\n${members.map((l) => formatLayer(l as Record<string, unknown>)).join("\n")}`);
    }
    const id = want.replace(/^layer:/, "");
    const layer = layers.find((l) => l.id === id);
    return layer ? text(formatLayer(layer as Record<string, unknown>)) : fail(`No layer '${id}'. Layers: ${layers.map((l) => l.id).join(", ") || "none"}. Groups: group:NAME`);
  }),
);

server.registerTool(
  "checkpoint",
  {
    description:
      "Named snapshots of the scene for this session. save NAME before a risky change; diff NAME [OTHER] says what changed since (layer by layer, scene keys too; OTHER defaults to the current scene); restore NAME puts the snapshot back (replaces the whole scene); list shows what is saved.",
    inputSchema: {
      action: z.enum(["save", "restore", "diff", "list"]),
      name: z.string().optional(),
      other: z.string().optional(),
    },
  },
  guard(async ({ action, name, other }) => {
    if (action === "list") return text(checkpoints.list());
    if (!name) return fail(`checkpoint ${action} needs a name`);
    try {
      if (action === "save") {
        const scene = await currentScene();
        if (!scene) return fail("no scene to save yet");
        return text(checkpoints.save(name, scene));
      }
      if (action === "diff") {
        const before = checkpoints.get(name);
        const after = other ? checkpoints.get(other) : ((await currentScene()) ?? {});
        return text(diffScenes(before, after).join("\n"));
      }
      const res = await bridge.loadScene(JSON.stringify(checkpoints.get(name)));
      if (!res.ok) return fail(res.error ?? "restore rejected");
      session.editsSinceReview = true;
      return text(`restored '${name}'${res.summary ? `: ${res.summary}` : ""}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  }),
);

server.registerTool(
  "next_step",
  {
    description:
      "What to do next, from the project's state: one to three steps in workflow order (empty scene, placement and lint issues, review, sound, checkpoints, done). Call it when you are unsure what comes next.",
  },
  guard(async () => {
    const scene = await currentScene();
    const layers = layersOf(scene);
    const duration = durationOf(scene);
    const state: ProjectState = {
      layers: layers.length,
      duration,
      sfx: ((scene?.sfx as unknown[] | undefined) ?? []).length,
      editsSinceReview: session.editsSinceReview,
      reviewed: session.reviewed,
      lintIds: session.lintIds,
      pastEnd: layers.filter((l) => Number(l.start ?? 0) > duration).map((l) => String(l.id)),
      checkpoints: checkpoints.names().length,
    };
    return text(nextSteps(state).map((step, i) => `${i + 1}. ${step}`).join("\n"));
  }),
);

server.registerTool(
  "examples",
  {
    description:
      "Videos the user approved, kept outside the repo. save LABEL [tags] keeps the current video as one (only after the user approves it). find QUERY [width height] returns up to three: their techniques and first layers. Reference only: learn the technique, then write your own scene; never paste one in whole.",
    inputSchema: {
      action: z.enum(["save", "find"]),
      label: z.string().optional(),
      tags: z.string().optional().describe("comma-separated, e.g. 'clinic,vertical,booking'"),
      query: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    },
  },
  guard(async ({ action, label, tags, query, width, height }) => {
    const dir = examplesDir();
    if (action === "save") {
      if (!label) return fail("examples save needs a label");
      const scene = await currentScene();
      if (!scene) return fail("no scene to save");
      const file = saveExample(dir, label, (tags ?? "").split(",").map((t) => t.trim()).filter(Boolean), scene);
      return text(`saved '${label}' (${file})`);
    }
    const found = rankExamples(loadExamples(dir), query ?? "", width, height).slice(0, 3);
    if (!found.length) return text(`no approved examples${query ? ` match '${query}'` : ""} yet. examples save LABEL after the user approves a video.`);
    return text(found.map((e) => describeExample(e, (l) => formatLayer(l))).join("\n\n"));
  }),
);

/** Said with every rejected op: the cheap, sure way to change existing layers. */
const EDIT_HINT =
  "To change existing layers use edit_layers (`id key=value…`, `g:group …`, `* …`) or {\"op\":\"patch\",\"id\"|\"group\"|\"all\":…,\"fields\":{…}}; to recolor everything at once {\"op\":\"replace_color\",\"from\":\"#…\",\"to\":\"#…\"}. The ops list is in the manual (Ops).";

server.registerTool(
  "apply_ops",
  {
    description:
      "Edit the video with an atomic batch of ops (manual: Ops). Rendered live in the user's editor and autosaved. Returns the new summary. Change fields of existing layers with edit_layers or the patch op (any field, by id/group/all) and swap colors everywhere with replace_color — never one op per layer.",
    inputSchema: { ops: z.array(z.looseObject({ op: z.string() })).min(1) },
  },
  guard(async ({ ops }) => {
    const batch = ops as Record<string, unknown>[];
    try {
      resolveOpTimes(batch, wordsOf(await currentScene()));
    } catch (e) {
      return fail((e as Error).message);
    }
    const res = await bridge.applyOps(batch as Op[]);
    if (res.ok) {
      session.editsSinceReview = true;
      const notes = await settle(opsIds(batch));
      return text([res.summary ?? "ok", ...notes].join("\n"));
    }
    // The whole batch is lost when one op is wrong: say which one and the cheap way to do it, so the retry is right.
    const unknown = /unknown variant `([^`]+)`/.exec(res.error ?? "")?.[1];
    return fail(`${res.error ?? "rejected"}\nNothing was applied${unknown ? ` (\`${unknown}\` does not exist here)` : ""}: resend the whole batch fixed.\n${EDIT_HINT}`);
  }),
);

server.registerTool(
  "edit_layers",
  {
    description:
      "Change ONLY the keys you write on existing layers, in add_layers syntax, one line per target: `title fill=accent size=120` · several ids `a,b,c rad=24` · a whole group `g:cards rad=40 shadow=0,30,60,#1b2a4a,.2` · every layer `* blur=0` · new text `title \"Clear day\"` · retime `t=1.2-3.5`. An effect you write replaces only that effect kind; stroke/motion path keys merge. One atomic call for any number of layers: never rewrite whole layers or send one op per layer to restyle.",
    inputSchema: { lines: z.string().min(1) },
  },
  guard(async ({ lines }) => {
    const layers = layersOf(await currentScene());
    const ops: Op[] = [];
    for (const raw of lines.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
      const cut = raw.search(/\s/);
      const [target, rest] = cut < 0 ? [raw, ""] : [raw.slice(0, cut), raw.slice(cut + 1)];
      const picked =
        target === "*" ? layers : target.startsWith("g:") ? layers.filter((l) => l.group === target.slice(2)) : layers.filter((l) => target.split(",").includes(String(l.id)));
      if (!picked.length) {
        const groups = [...new Set(layers.map((l) => l.group).filter(Boolean))].join(", ");
        return fail(`no layer matches '${target}'. Groups: ${groups || "none"}. Ids: ${layers.map((l) => l.id).slice(0, 40).join(", ")}`);
      }
      try {
        for (const l of picked) {
          const fields = parsePartial(rest, l);
          resolveLayerTimes([fields], wordsOf(await currentScene()));
          ops.push({ op: "patch", id: l.id, fields } as Op);
        }
      } catch (e) {
        return fail((e as Error).message);
      }
    }
    const res = await bridge.applyOps(ops);
    if (!res.ok) return fail(`${res.error ?? "rejected"}\n${EDIT_HINT}`);
    session.editsSinceReview = true;
    const notes = await settle(opsIds(ops as Record<string, unknown>[]));
    return text([`${ops.length} layer(s) changed`, ...notes].join("\n"));
  }),
);

server.registerTool(
  "load_scene",
  {
    description: "Replace the whole scene. Use to build the first cut; prefer apply_ops afterwards.",
    inputSchema: { scene: z.string().describe("Full scene JSON") },
  },
  guard(async ({ scene }) => {
    const res = await bridge.loadScene(scene);
    return res.ok ? text(res.summary ?? "ok") : fail(res.error ?? "rejected");
  }),
);

server.registerTool(
  "set_voice_script",
  {
    description:
      "Save the voice-over script (ElevenLabs v3 format: one tone tag like [warm] first, one paragraph per scene, '[long pause] [long pause]' between scenes, numbers in letters, last sentence = CTA). The user pastes it in ElevenLabs and uploads the mp3.",
    inputSchema: { script: z.string().min(1).max(8000) },
  },
  guard(async ({ script }) => {
    await api.update({ voiceScript: script });
    return text("voice script saved");
  }),
);

server.registerTool(
  "review_video",
  {
    description:
      "SELF-REVIEW the whole video before saying it's done: one contact sheet of evenly spaced frames, 12 fps strips of the moments that change most (judge easing and continuity there), automatic checks (layers off frame, text colliding or crossing card edges, text too small to read on a phone, palette too saturated/neon, dead air, blank frames) and motion notes (abrupt stops, linear keys, crowded entrances, held layers, no camera). Look at the sheet critically like a motion designer (framing, characters cut off or tiny, camera, readability, rhythm), fix everything with apply_ops and review again. Repeat until it is clean (max ~3 rounds). Works even if the user has no editor open.",
    inputSchema: { frames: z.number().int().min(4).max(24).default(12).describe("frames in the sheet") },
  },
  async ({ frames }) => {
    try {
      const res = await bridge.review(frames);
      const r = res.review;
      if (!res.ok || !r) return fail(res.error ?? "review failed");
      const scene = await currentScene();
      const layers = layersOf(scene) as LintLayer[];
      const textIds = new Set(layers.filter((l) => l.type === "text").map((l) => String(l.id)));
      const list = await layoutAt(r.times);
      const numbers = list ? list.map((f) => { const s = frameStats(f, sizeOf(scene), textIds); return `t=${f.t}s · ${s.onScreen} layers on screen · text covers ${s.textCover}% of the frame`; }) : [];
      const lint = list ? lintLayers({ layers, frames: list, palette: paletteOf(scene, list), size: sizeOf(scene) }) : [];
      session.reviewed = true;
      session.editsSinceReview = false;
      session.lintIds = [...new Set(lint.map((i) => i.id))];
      const report = [
        `duration ${r.duration}s · frames at ${r.times.join(", ")}s`,
        numbers.length ? `per frame (numbers):\n- ${numbers.join("\n- ")}` : "",
        lint.length ? `lint (apply the fix ops with apply_ops):\n- ${formatIssues(lint).join("\n- ")}` : list ? "lint: clean on the sampled frames." : "",
        r.issues.length ? `automatic checks found ${r.issues.length} issue(s):\n- ${r.issues.join("\n- ")}` : "automatic checks: no issues (still look at the sheet).",
        r.motion?.length ? `motion notes:\n- ${r.motion.join("\n- ")}` : "",
        r.strips?.length ? `motion strips (consecutive frames at 12 fps) of the moments that change most: ${r.strips.map((s) => `${s.from}-${s.to}s`).join(", ")} — judge the easing, spacing and continuity there.` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const image = (url: string) => ({ type: "image" as const, data: url.split(",")[1] ?? "", mimeType: "image/jpeg" });
      return { content: [{ type: "text" as const, text: report }, image(r.sheet), ...(r.strips ?? []).map((s) => image(s.image))] };
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "render_frames",
  {
    description:
      "LOOK at your work: small JPEG stills of the video at the given seconds (max 6). Use after every edit round to check layout, legibility, overlaps and that things are on screen; fix before telling the user it's done.",
    inputSchema: {
      times: z.array(z.number().min(0)).min(1).max(6),
      width: z.number().int().min(360).max(1280).optional().describe("pixel width (default 360; up to 1280 to inspect detail — costs more)"),
    },
  },
  async ({ times, width }) => {
    try {
      const res = await bridge.renderFrames(times, width);
      if (!res.ok || !res.images?.length) return fail(res.error ?? "no frames");
      return {
        content: res.images.flatMap((url, i) => [
          { type: "text" as const, text: `t=${times[i]}s` },
          { type: "image" as const, data: url.split(",")[1] ?? "", mimeType: "image/jpeg" },
        ]),
      };
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "get_feedback",
  {
    description:
      "What the user said or changed since your last call: comments pinned to a second or to an object. Check after every round of edits.",
    inputSchema: {},
  },
  guard(async () => {
    const items = await api.consumeFeedback();
    return text(items.length ? items.map(feedbackLine).join("\n") : "No new feedback.");
  }),
);

function describeProject(p: Project): string {
  const lines = [`Project "${p.name}"`, `Brief: ${p.brief.trim() || "(empty — ask the user what the video is about)"}`, ""];
  lines.push(`Format: ${p.format}`);
  if (p.voiceScript.trim()) lines.push(`Voice script (ElevenLabs; the video is built on it):\n${p.voiceScript.trim()}`);
  if (p.references?.length) lines.push(`Reference images from the user (look with view_image): ${p.references.join(", ")}`);
  if (p.imageCredits?.length) lines.push(`Imported photos (src for image layers): ${p.imageCredits.map((c) => `${c.src} "${c.title}"`).join(", ")}`);
  lines.push(p.audio ? `Voice uploaded: ${p.audio.name}. inspect's summary has its voice timeline (phrases, pauses, LONG pauses = scene changes) and captions carry word timings: time the beats to them.` : "Voice: not uploaded yet.");
  lines.push("No presets exist: you design and animate everything yourself (palette, font, keyframes, cuts, 3D).");
  lines.push(p.scene ? `Scene: exists (rev ${p.sceneRevision}); see inspect.` : "Scene: empty. Build the first cut with load_scene.");
  lines.push(bridge.connected ? "Editor: open (your edits render live)." : "Editor: NOT open on this project — ask the user to open it before editing.");
  return lines.join("\n");
}

function feedbackLine(f: Feedback): string {
  switch (f.kind) {
    case FeedbackKind.Comment:
      return f.layerId
        ? `comment on layer '${f.layerId}' @${(f.at ?? 0).toFixed(1)}s: ${f.text} (inspect ${f.layerId} to see it)`
        : f.at == null
          ? `comment on the WHOLE video (apply it everywhere: font, background, palette, pace…): ${f.text}`
          : `comment @${f.at.toFixed(1)}s: ${f.text}`;
    case FeedbackKind.BrickChosen:
      return `user set ${f.slot} = ${JSON.stringify(f.value)}`;
  }
}

await server.connect(new StdioServerTransport());

// Our client (claude) is gone when stdin closes or we get reparented: shut down instead of
// lingering forever with a bridge connection and maybe a headless Chrome.
const exit = () => void (bridge.headless?.close() ?? Promise.resolve()).finally(() => process.exit(0));
process.stdin.on("end", exit);
process.stdin.on("close", exit);
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) exit();
}, ORPHAN_CHECK_MS).unref();
