#!/usr/bin/env node
/**
 * Motionily MCP server: the agent's hands on one project.
 * The user writes a brief in the editor; the agent designs and animates everything,
 * builds the video with small ops (rendered live in the editor) and iterates
 * on the user's feedback.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  FeedbackKind,
  OpName,
  VideoFormat,
  type Feedback,
  type Op,
  type Project,
} from "@motionily/protocol";
import { EditorBridge } from "./bridge.js";
import { HeadlessEditor } from "./headless.js";
import { formatLayer, parseLines } from "./compact.js";
import { ProjectApi } from "./api.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const REFERENCE = readFileSync(resolve(here, "../../../docs/scene-reference.md"), "utf8");

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

const server = new McpServer({ name: "motionily", version: "0.2.0" });

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
      "START HERE. The user's brief, the format and the current scene state.",
    inputSchema: {},
  },
  guard(async () => {
    return text(describeProject(await api.project()));
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
      "Create or update a reusable 3D prefab in the user's library from a procedural tree (see get_reference: 3D primitives). Use it in a scene with put_prop {prefab: name}. Updating a prefab changes it everywhere it is used.",
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
    description: "Copy a prefab under a new name (e.g. a blue, lower version of the camilla), then reshape the copy with get_prefab + save_prefab. The original stays untouched.",
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
      "The project's brand kit: what the product is (notes), brand palettes, and every logo/screenshot/photo with the user's description of what it shows and how it works. Read it before designing; use view_asset to look at an image.",
    inputSchema: {},
  },
  guard(async () => {
    const b = await api.brand();
    const lines = [`Brand: ${b.name}`, `About: ${b.notes.trim() || "(no notes)"}`];
    for (const p of b.palettes) lines.push(`Palette "${p.name}": bg ${p.background}, surface ${p.surface}, primary ${p.primary}, accent ${p.accent}, text ${p.text}`);
    for (const a of b.assets) lines.push(`Asset ${a.id} | ${a.kind} | ${a.name} | src "${a.url}" | ${a.description || "(no description)"}`);
    if (!b.assets.length) lines.push("No images yet.");
    return text(lines.join("\n"));
  }),
);

server.registerTool(
  "view_image",
  {
    description: "Look at a reference image the user attached (a /media/… path from the request or get_project). Use it to understand what they mean; it is not brand material unless they say so.",
    inputSchema: { url: z.string().regex(/^\/media\/[a-f0-9-]{36}\.[a-z0-9]{1,5}$/) },
  },
  async ({ url }) => {
    try {
      const img = await api.media(url);
      return { content: [{ type: "image" as const, data: img.bytes.toString("base64"), mimeType: img.mime }] };
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "view_asset",
  {
    description: "Look at one brand image (logo, product screenshot…) to understand it before recreating or showing it. Put it in the video as an image layer with its src.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      const asset = (await api.brand()).assets.find((a) => a.id === id);
      if (!asset) return fail(`No asset '${id}'. See get_brand.`);
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
  { description: "Scene format and op reference. Read once before your first edit.", inputSchema: {} },
  async () => text(REFERENCE),
);

/** Latest scene: live from the editor when open, else the autosave. */
async function currentScene(): Promise<Record<string, unknown> | null> {
  const live = bridge.lastScene;
  return live ? (JSON.parse(live) as Record<string, unknown>) : (await api.project()).scene;
}

/** How often an MCP server checks whether its claude parent died. */
const ORPHAN_CHECK_MS = 5_000;

/** Default level for effects so they sit under a voice-over. */
const SFX_GAIN = 0.7;

const layersOf = (scene: Record<string, unknown> | null) => (scene?.layers as Record<string, unknown>[] | undefined) ?? [];

server.registerTool(
  "add_layers",
  {
    description:
      "Add or replace layers with COMPACT LINES (far cheaper than JSON): `id type start[-end] key=value… \"text or path data\" {json}`. Types rect|ellipse|text|image|path. Values: number, tween `from>to@t0-t1[:ease]`, keys `t:v[:ease],…`, or `(expression)`. Keys: x y w h s r o rad pivot parent fill grad stroke soft shadow glow blur blend matte vis rep size role align lh ls ts te to filled g src fit. A trailing {json} merges any field (e.g. text animators). Full syntax and recipes in get_reference. An existing id is replaced.",
    inputSchema: { lines: z.string().min(1) },
  },
  guard(async ({ lines }) => {
    let layers;
    try {
      layers = parseLines(lines);
    } catch (e) {
      return fail((e as Error).message);
    }
    const existing = new Set(layersOf(await currentScene()).map((l) => String(l.id)));
    const ops = layers.flatMap((layer) => [...(existing.has(String(layer.id)) ? [{ op: "remove_layer", id: layer.id }] : []), { op: "add_layer", layer }]);
    const res = await bridge.applyOps(ops as Op[]);
    return res.ok ? text(`${layers.length} layers ok`) : fail(res.error ?? "rejected");
  }),
);

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
  "add_sfx",
  {
    description:
      "Place sound effects on the timeline, one per line: `id sound_name at [gain]` (at = seconds from the video start, gain 0.2-1, default 0.7). Same id moves/replaces it. Sync them to motion: whoosh/swipe on moves and transitions (start ~0.1 s before), pop on entrances, click/tick on UI and counters, impact on hero text landing, riser before reveals, chime on positive results. 1 sound per meaningful event; never stack more than 2 at once.",
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
  "get_scene",
  {
    description: "Current scene: compact summary by default; full=true for exact keyframes.",
    inputSchema: { full: z.boolean().optional() },
  },
  guard(async ({ full }) => {
    if (!full && bridge.connected && bridge.lastSummary) return text(bridge.lastSummary);
    const { scene } = await api.project();
    if (!scene) return text("Empty project: no scene yet. Start with load_scene.");
    if (!full) return text(`${bridge.connected ? "" : "(editor closed) "}${JSON.stringify(scene).slice(0, 2000)}`);
    const { layers, ...rest } = scene as Record<string, unknown>;
    return text(`${JSON.stringify(rest)}\nlayers (compact lines):\n${layersOf({ layers }).map(formatLayer).join("\n")}`);
  }),
);

server.registerTool(
  "get_layer",
  {
    description:
      "One layer as JSON (the one a comment points at, or any id from the summary). Use it instead of reading the whole scene.",
    inputSchema: { id: z.string() },
  },
  guard(async ({ id }) => {
    const live = bridge.lastScene;
    const scene = live ? (JSON.parse(live) as Record<string, unknown>) : (await api.project()).scene;
    const layers = (scene?.layers as { id: string }[] | undefined) ?? [];
    const layer = layers.find((l) => l.id === id);
    return layer ? text(formatLayer(layer as Record<string, unknown>)) : fail(`No layer '${id}'. Layers: ${layers.map((l) => l.id).join(", ") || "none"}`);
  }),
);

server.registerTool(
  "get_group",
  {
    description:
      "Every layer of a group (e.g. 'dashboard') as JSON, plus its time span. Use it when the user points at a group: redesign or tweak just those layers (remove_group + add_layer with the same group, or set_prop), not the whole video.",
    inputSchema: { group: z.string() },
  },
  guard(async ({ group }) => {
    const live = bridge.lastScene;
    const scene = live ? (JSON.parse(live) as Record<string, unknown>) : (await api.project()).scene;
    const layers = ((scene?.layers as { id: string; group?: string; start?: number; end?: number | null }[] | undefined) ?? []).filter((l) => l.group === group);
    if (!layers.length) return fail(`No group '${group}'.`);
    const start = Math.min(...layers.map((l) => l.start ?? 0));
    return text(`group ${group}: ${layers.length} layers from ${start}s (compact lines; edit with add_layers)\n${layers.map((l) => formatLayer(l as Record<string, unknown>)).join("\n")}`);
  }),
);

server.registerTool(
  "apply_ops",
  {
    description:
      "Edit the video with an atomic batch of ops. Rendered live in the user's editor and autosaved. Returns the new summary.",
    inputSchema: { ops: z.array(z.looseObject({ op: z.string() })).min(1) },
  },
  guard(async ({ ops }) => {
    const res = await bridge.applyOps(ops as Op[]);
    return res.ok ? text(res.summary ?? "ok") : fail(res.error ?? "rejected");
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
      "SELF-REVIEW the whole video before saying it's done: one contact sheet of evenly spaced frames plus automatic checks (layers off frame, overlapping text, dead air where nothing moves, blank frames). Look at the sheet critically like a motion designer (framing, characters cut off or tiny, camera, readability, rhythm), fix everything with apply_ops and review again. Repeat until it is clean (max ~3 rounds). Works even if the user has no editor open.",
    inputSchema: { frames: z.number().int().min(4).max(24).default(12).describe("frames in the sheet") },
  },
  async ({ frames }) => {
    try {
      const res = await bridge.review(frames);
      const r = res.review;
      if (!res.ok || !r) return fail(res.error ?? "review failed");
      const report = [
        `duration ${r.duration}s · frames at ${r.times.join(", ")}s`,
        r.issues.length ? `automatic checks found ${r.issues.length} issue(s):\n- ${r.issues.join("\n- ")}` : "automatic checks: no issues (still look at the sheet).",
      ].join("\n");
      return { content: [{ type: "text" as const, text: report }, { type: "image" as const, data: r.sheet.split(",")[1] ?? "", mimeType: "image/jpeg" }] };
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
  lines.push(p.audio ? `Voice uploaded: ${p.audio.name} (captions carry word timings).` : "Voice: not uploaded yet.");
  lines.push("No presets exist: you design and animate everything yourself (palette, font, keyframes, cuts, 3D). See get_reference.");
  lines.push(p.scene ? `Scene: exists (rev ${p.sceneRevision}); see get_scene.` : "Scene: empty. Build the first cut with load_scene.");
  lines.push(bridge.connected ? "Editor: open (your edits render live)." : "Editor: NOT open on this project — ask the user to open it before editing.");
  return lines.join("\n");
}

function feedbackLine(f: Feedback): string {
  switch (f.kind) {
    case FeedbackKind.Comment:
      return f.layerId
        ? `comment on layer '${f.layerId}' @${(f.at ?? 0).toFixed(1)}s: ${f.text} (get_layer ${f.layerId} to see it)`
        : `comment @${(f.at ?? 0).toFixed(1)}s: ${f.text}`;
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
