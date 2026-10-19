#!/usr/bin/env node
/**
 * Motionily MCP server: the agent's hands on one project.
 * The user picks bricks and writes a brief in the editor; the agent reads them,
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
  BrickSlot,
  BrickVisibility,
  EngineSupport,
  FeedbackKind,
  OpName,
  VideoFormat,
  type Brick,
  type Feedback,
  type Op,
  type Project,
} from "@motionily/protocol";
import { EditorBridge } from "./bridge.js";
import { HeadlessEditor } from "./headless.js";
import { ProjectApi } from "./api.js";
import { TEMPLATES, TemplateId } from "./templates.js";

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

const SLOT_VALUES = Object.values(BrickSlot) as [BrickSlot, ...BrickSlot[]];

server.registerTool(
  "get_project",
  {
    description:
      "START HERE. The user's brief, the bricks they chose for every slot (style, palette, composition, animations…) and the current scene summary.",
    inputSchema: {},
  },
  guard(async () => {
    const [project, bricks] = await Promise.all([api.project(), api.bricks()]);
    return text(describeProject(project, new Map(bricks.map((b) => [b.key, b]))));
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
  "list_templates",
  {
    description:
      "2D typographic templates (kinetic titles). For 3D, build procedurally: prefabs, stickman rigs, set_shots.",
    inputSchema: {},
  },
  async () => text(TEMPLATES.map((t) => `${t.id}: ${t.summary} Params: ${t.uses}`).join("\n")),
);

server.registerTool(
  "apply_template",
  {
    description:
      "Add one beat from a template at second `at` lasting `duration`. Chain several for a full video (one 3D set per video: the last set wins). Then tweak with apply_ops and check with render_frames.",
    inputSchema: {
      template: z.enum(Object.values(TemplateId) as [TemplateId, ...TemplateId[]]),
      id: z.string().regex(/^[a-z0-9_-]{1,20}$/).describe("prefix for the beat's layer ids, e.g. b1"),
      at: z.number().min(0),
      duration: z.number().min(0.5).max(30),
      title: z.string().max(120),
      subtitle: z.string().max(160).optional(),
      cta: z.string().max(40).optional(),
    },
  },
  guard(async ({ template, ...params }) => {
    const t = TEMPLATES.find((x) => x.id === template)!;
    const res = await bridge.applyOps(t.build(params));
    return res.ok ? text(res.summary ?? "ok") : fail(res.error ?? "rejected");
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

server.registerTool(
  "list_bricks",
  {
    description: "Brick catalog this project can use (official + ones you created), one line each. Filter by slot.",
    inputSchema: { slot: z.enum(SLOT_VALUES).optional() },
  },
  guard(async ({ slot }) => {
    const bricks = await api.bricks(slot);
    return text(bricks.map(brickLine).join("\n") || "No bricks.");
  }),
);

server.registerTool(
  "get_brick",
  {
    description: "Full data of one brick (payload: colors, keyframe templates, kit defaults…).",
    inputSchema: { key: z.string().describe('e.g. "animation/pop_in"') },
  },
  guard(async ({ key }) => {
    const brick = (await api.bricks()).find((b) => b.key === key);
    if (!brick) return fail(`No brick '${key}'. Use list_bricks.`);
    const { slot, name, description, fits, engine, payload } = brick;
    return text(JSON.stringify({ key, slot, name, description, fits, engine, payload }));
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
    return text(full ? JSON.stringify(scene) : `${bridge.connected ? "" : "(editor closed) "}${JSON.stringify(scene).slice(0, 2000)}`);
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
    return layer ? text(JSON.stringify(layer)) : fail(`No layer '${id}'. Layers: ${layers.map((l) => l.id).join(", ") || "none"}`);
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
    inputSchema: { times: z.array(z.number().min(0)).min(1).max(6) },
  },
  async ({ times }) => {
    try {
      const res = await bridge.renderFrames(times);
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
  "create_brick",
  {
    description:
      "Save a brick that did not exist (e.g. a custom animation) as a private brick of this project, so it can be reused. Payload is free-form JSON (keyframe template, colors…).",
    inputSchema: {
      slot: z.enum(SLOT_VALUES),
      id: z.string().regex(/^[a-z0-9_]{2,40}$/).describe("snake_case; key becomes slot/id"),
      name: z.string().max(80),
      description: z.string().max(400).optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
    },
  },
  guard(async (brick) => {
    const created = await api.createBrick(brick);
    // Animations become usable right away: teach the live engine the new template.
    if (brick.slot === BrickSlot.Animation && brick.payload?.keys && bridge.connected) {
      const res = await bridge.applyOps([{ op: OpName.DefineAnim, key: created.key, template: { keys: brick.payload.keys } }]);
      if (!res.ok) return fail(`Saved ${created.key}, but the engine rejected its keys: ${res.error}`);
      return text(`Saved ${created.key}; use it with {"use":"${created.key}"}.`);
    }
    return text(`Saved ${created.key} (private to this project).`);
  }),
);

server.registerTool(
  "get_feedback",
  {
    description:
      "What the user said or changed since your last call: comments pinned to a second, and bricks they swapped. Check after every round of edits.",
    inputSchema: {},
  },
  guard(async () => {
    const items = await api.consumeFeedback();
    return text(items.length ? items.map(feedbackLine).join("\n") : "No new feedback.");
  }),
);

function describeProject(p: Project, byKey: Map<string, Brick>): string {
  const lines = [`Project "${p.name}"`, `Brief: ${p.brief.trim() || "(empty — ask the user what the video is about)"}`, ""];
  lines.push(`Format: ${p.format}`);
  lines.push("Look: none preset. You are the art director: choose palette (set_palette; start from the brand's palettes if any), Google Font (set_font), motion and finish yourself.");
  lines.push("");
  lines.push(
    "Engine today: rect/ellipse layers; animate them by referencing animation bricks ({\"use\":\"animation/pop_in\",\"at\":0.3}) instead of hand keyframes; place them on composition anchors (anchor: hero/title/caption/accent); cut scenes with transition bricks (add_transition). Palette slots follow the palette brick. Text layers render in the typography brick font; captions (from the user\'s voice-over) render in their caption style — mark key words with set_emphasis. The render style brick (finish: soft shadows, toon outlines, paper cut…) is applied by the engine to the whole frame. REAL 3D built PROCEDURALLY: primitives + stickman rigs saved as prefabs in the user's library (list_prefabs, save_prefab), placed with put_prop {prefab}, filmed with set_shots. Do not use stock models or set_stage_preset.",
  );
  lines.push(p.scene ? `Scene: exists (rev ${p.sceneRevision}); see get_scene.` : "Scene: empty. Build the first cut with load_scene.");
  lines.push(bridge.connected ? "Editor: open (your edits render live)." : "Editor: NOT open on this project — ask the user to open it before editing.");
  return lines.join("\n");
}

function brickLine(b: Brick): string {
  const fits = b.fits.length ? ` fits=${b.fits.map((f) => f.split("/")[1]).join(",")}` : "";
  const flags = `${b.engine === EngineSupport.Planned ? " planned" : ""}${b.visibility === BrickVisibility.Private ? " yours" : ""}`;
  return `${b.key} | ${b.name} | ${b.description}${fits}${flags}`;
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
