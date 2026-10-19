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

server.registerTool(
  "set_option",
  {
    description:
      "Change a project option (the same settings the user has in the editor): motion_style, palette, composition, typography, render_style (finish: flat, soft_depth…), captions, scenario (null for none), character/animation/transition (lists). Use keys from list_bricks. The editor updates live.",
    inputSchema: {
      slot: z.enum(SLOT_VALUES),
      value: z.union([z.string(), z.array(z.string()), z.null()]),
      apply_style_defaults: z.boolean().optional().describe("motion_style only: also switch every other option to that style's defaults"),
    },
  },
  guard(async ({ slot, value, apply_style_defaults }) => {
    const p = await api.setSlot(slot, value, apply_style_defaults);
    return text(`${slot} = ${JSON.stringify(p.build[slot])}`);
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
    const brick = await api.createBrick({
      slot: BrickSlot.Typography,
      id: `gf_${match.family.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 36)}`,
      name: match.family,
      description: `${match.category} · Google Fonts`,
      payload: { family: match.family, body: near(500), heading: near(700) },
    });
    await api.setSlot(BrickSlot.Typography, brick.key);
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
  lines.push("Options (the user's starting point; change them with set_option when the user asks or when it clearly serves the brief):");
  for (const slot of SLOT_VALUES) {
    const keys = [p.build[slot]].flat().filter((k): k is string => typeof k === "string");
    const names = keys.map((k) => {
      const b = byKey.get(k);
      if (!b) return k;
      const extra = slot === BrickSlot.Palette ? ` ${JSON.stringify(b.payload)}` : "";
      return `${b.name} (${k})${b.engine === EngineSupport.Planned ? " [not rendered yet: use as intent]" : ""}${extra}`;
    });
    lines.push(`- ${slot}: ${names.join("; ") || "—"}`);
  }
  if (p.misfits.length) lines.push(`Misfits (user chose them anyway): ${p.misfits.join(", ")}`);
  lines.push("");
  lines.push(
    "Engine today: rect/ellipse layers; animate them by referencing animation bricks ({\"use\":\"animation/pop_in\",\"at\":0.3}) instead of hand keyframes; place them on composition anchors (anchor: hero/title/caption/accent); cut scenes with transition bricks (add_transition). Palette slots follow the palette brick. Text layers render in the typography brick font; captions (from the user\'s voice-over) render in their caption style — mark key words with set_emphasis. The render style brick (finish: soft shadows, toon outlines, paper cut…) is applied by the engine to the whole frame. Characters (type character: stickman/blob/chibi with outfits, hair and actions) and scenario backdrops (clinic room, office, studio, iso city) render too.",
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
