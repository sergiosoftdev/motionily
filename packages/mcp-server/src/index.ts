#!/usr/bin/env node
/**
 * Motionily MCP server: the agent's hands on one project.
 * The user writes a brief in the editor; the agent designs and animates everything,
 * builds the video with small ops (rendered live in the editor) and iterates
 * on the user's feedback.
 */
import { findIcons, ICONIFY_ID, preloadIcons } from "./icons.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  AssetFormat,
  AssetKind,
  FeedbackKind,
  Genre,
  OpName,
  VideoFormat,
  type Feedback,
  type FrameLayout,
  type ImageCredit,
  type Op,
  type Project,
} from "@motionily/protocol";
import { EditorBridge } from "./bridge.js";
import { HeadlessEditor } from "./headless.js";
import { formatLayer, formatParams, parseLines, parseParams, parsePartial, type ParamDef } from "./compact.js";
import { ACCOUNT_SCOPE, AccountApi, ProjectApi, VIDEO_ASSET, clipFacts, posterTimes } from "./api.js";
import { formatLayouts } from "./layout.js";
import { isRef, resolveLayerTimes, type Word } from "./timing.js";
import { formatIssues, lintLayers, type Issue, type Layer as LintLayer, type Palette } from "./lint.js";
import { placementPatches, type Box } from "./place.js";
import { Checkpoints, diffScenes } from "./checkpoints.js";
import { describeExample, rankExamples, type Example } from "./examples.js";
import { nextSteps, type ProjectState } from "./nextstep.js";
import { frameStats } from "./review.js";
import { attentionReport } from "./attention.js";
import { LOG_CHARS, runScript, type HostApi } from "./sandbox.js";
import { attentionCurve, attentionIssues, attentionSparkline } from "@motionily/protocol";
import { buildEdit, DEFAULT_EDIT, FOOTAGE_GROUP, footageLines, parseSegments, transcriptLines } from "./footage.js";
import { svgToVector } from "./svg.js";
import { vectorLines, VectorSplit } from "./vectorize.js";
import { MapProjection, mapLines } from "./maps.js";
import { varietyNotes } from "./variety.js";
import { slopNotes } from "./slop.js";
import { captionDrift, deadAir, voiceWords } from "./voice.js";
import { formatSounds, parseCue } from "./sounds.js";

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
/** Extra start step when the token reaches the whole account. */
const ACCOUNT_INSTRUCTIONS = `
This token reaches the user's whole account: if no video is open, call list_projects, then open_project or create_project
(with a brief full of real facts when you researched the product in code) before get_project.`;

const token = process.env.MOTIONILY_TOKEN;
if (!token) {
  console.error("[motionily] MOTIONILY_TOKEN is required. Get it from 'Use in Claude Code' in the editor.");
  process.exit(1);
}
const apiUrl = process.env.MOTIONILY_API ?? "http://localhost:3100";
const webUrl = process.env.MOTIONILY_WEB ?? "http://localhost:5173";

/** An account token lets the agent create videos and switch between them; a project token is tied to one. */
const scopeOf = (jwt: string): string | undefined => {
  try {
    return (JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as { scope?: string }).scope;
  } catch {
    return undefined;
  }
};
const account = scopeOf(token) === ACCOUNT_SCOPE ? new AccountApi(apiUrl, token) : null;
if (!account && !process.env.MOTIONILY_PROJECT) {
  console.error("[motionily] a project token needs MOTIONILY_PROJECT. Get both from 'Use in Claude Code' in the editor.");
  process.exit(1);
}

let api = new ProjectApi(apiUrl, token, "");
let bridge = new EditorBridge(apiUrl, token, "");

/** Point every tool at this video. */
function useVideo(id: string, projectToken: string) {
  const next = new ProjectApi(apiUrl, projectToken, id);
  api = next;
  bridge = new EditorBridge(apiUrl, projectToken, id);
  // Without the user's editor open, the agent works in its own invisible one.
  if (process.env.MOTIONILY_HEADLESS !== "0") bridge.headless = new HeadlessEditor(webUrl, id, () => next.headlessSession());
}

/** Switch to another of the account's videos: get its own token, check it, then move every tool there. */
async function openVideo(id: string) {
  const { token: projectToken } = await account!.projectToken(id);
  const project = await new ProjectApi(apiUrl, projectToken, id).project();
  await bridge.close();
  useVideo(id, projectToken);
  checkpoints = new Checkpoints();
  Object.assign(session, { editsSinceReview: false, reviewed: false, lintIds: [] });
  return project;
}

const server = new McpServer({ name: "motionily", version: "0.4.0" }, { instructions: account ? INSTRUCTIONS + ACCOUNT_INSTRUCTIONS : INSTRUCTIONS });

// Agents launched by the API carry the manual in their system prompt; everyone else gets it once from get_project.
let manualSent = process.env.MOTIONILY_MANUAL === "0";

// Each team role only sees the tools it needs: every tool description costs context on every turn.
const onlyTools = process.env.MOTIONILY_TOOLS?.split(",").map((t) => t.trim()).filter(Boolean);
if (onlyTools?.length) {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, ...rest: unknown[]) =>
    onlyTools.includes(String(name)) ? register(name, ...rest) : undefined;
}

/** What a tool handler returns (text, sometimes images). */
type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
/** The tools this agent may call, with their input schemas: run scripts reach them through mo.tool. */
const toolHandlers = new Map<string, { schema: z.ZodRawShape; cb: (args: Record<string, unknown>) => Promise<ToolResult> }>();
{
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, cb: unknown) => {
    const registered = register(name, config, cb);
    // The role's allowlist returns undefined for tools this agent does not get.
    if (registered !== undefined) toolHandlers.set(String(name), { schema: ((config as { inputSchema?: z.ZodRawShape }).inputSchema ?? {}), cb: cb as (args: Record<string, unknown>) => Promise<ToolResult> });
    return registered;
  };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });
/** How often (ms) tool results look for notes the user just left. */
const NOTE_CHECK_MS = 2000;
/** Notes already shown to this agent: each reaches it once, on its next tool call. */
const shownNotes = new Set<string>();
let noteCheckAt = 0;
/** run scripts in progress (their tool calls must not swallow the user's notes). */
let scriptDepth = 0;

/**
 * Notes the user leaves while the agent works, appended to its next tool result so it obeys right
 * away instead of whenever it next calls get_feedback. Only shown, never marked read: get_feedback
 * (the finisher's) still gets them.
 */
async function freshNotes(): Promise<string> {
  // Inside a run script the tool results go to the script, not the model: notes wait for the run's own result.
  if (scriptDepth > 0 || !api.projectId || Date.now() - noteCheckAt < NOTE_CHECK_MS) return "";
  noteCheckAt = Date.now();
  const notes = (await api.feedback().catch(() => [])).filter((f) => f.kind === FeedbackKind.Comment && !f.consumedAt && !shownNotes.has(f._id));
  if (!notes.length) return "";
  for (const f of notes) shownNotes.add(f._id);
  return `USER NOTE, sent just now while you work. It outranks your plan: apply it now to what you own (a note about the whole video changes your part too; if it is only about a part you cannot edit, keep going and the finisher applies it). get_feedback will list it again: do not redo it.\n- ${notes.map(feedbackLine).join("\n- ")}`;
}

const guard =
  <A,>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
  async (args: A) => {
    try {
      const res = await fn(args);
      const notes = await freshNotes();
      return notes ? { ...res, content: [...res.content, { type: "text" as const, text: notes }] } : res;
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

const FormatEnum = z.enum(Object.values(VideoFormat) as [VideoFormat, ...VideoFormat[]]);
const openedText = async (p: Project) => {
  const project = describeProject(p);
  if (manualSent) return text(`Opened. Now call get_brand.\n\n${project}`);
  manualSent = true;
  return text(`Opened. Now call get_brand.\n\n${project}\n\n---\n\n${MANUAL}`);
};

if (account) {
  server.registerTool(
    "list_projects",
    {
      description:
        "The user's videos (newest first) and the brand kits they live in. Then open_project to work on one, or create_project for a new one.",
      inputSchema: {},
    },
    guard(async () => {
      const [videos, brands] = await Promise.all([account.videos(), account.brands()]);
      const kit = new Map(brands.map((b) => [b.id, b.name]));
      const open = api.projectId;
      const rows = videos.map((v) => `${v._id} | ${v.name} | ${v.format} | ${kit.get(String(v.brandId)) ?? "-"} | ${v.updatedAt}${String(v._id) === open ? " | OPEN" : ""}`);
      const kits = brands.map((b) => `${b.id} | ${b.name} | ${b.videos} videos${b.notes.trim() ? ` | ${b.notes.trim().slice(0, 120)}` : ""}`);
      return text(`Videos (id | name | format | brand kit | updated):\n${rows.join("\n") || "none yet"}\n\nBrand kits (id | name | videos | notes):\n${kits.join("\n")}`);
    }),
  );

  server.registerTool(
    "create_project",
    {
      description:
        "Create a new video and open it (the tools then work on it). Write the brief like the user would: what the video is about, who it's for, the key messages and the tone. When it comes from code or docs you researched, put the real product facts in it. Then get_brand and build as usual.",
      inputSchema: {
        name: z.string().min(1).max(80),
        brief: z.string().min(1).max(4000),
        format: FormatEnum.optional().describe("Default vertical_9_16."),
        voiceScript: z.string().max(8000).optional().describe("Voice-over script, only if the user wants one."),
        brandId: z.string().optional().describe("Brand kit from list_projects; default the user's first one."),
      },
    },
    guard(async (args) => openedText(await openVideo((await account.create(args)).id))),
  );

  server.registerTool(
    "open_project",
    {
      description: "Switch every tool to an existing video (id from list_projects).",
      inputSchema: { id: z.string().min(1) },
    },
    guard(async ({ id }) => openedText(await openVideo(id))),
  );
}

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

// ── footage: the user's own clips, cut by their transcript ──
server.registerTool(
  "get_footage",
  {
    description:
      "The user's own clips to edit (usually someone talking to camera): each clip's id, length, size and contact sheet, and its transcript in numbered lines (`#from-to start-end s \"text\"`, words numbered from 0 within each clip, long pauses noted). With `clip` (+ `from`/`to`): every word of that range with its number and file second, to cut in the middle of a line. Cut with edit_footage.",
    inputSchema: { clip: z.string().optional(), from: z.number().int().min(0).optional(), to: z.number().int().min(0).optional() },
  },
  async ({ clip, from, to }) => {
    try {
      const footage = (await api.project()).footage ?? [];
      if (!footage.length) return text("This video has no footage: the user did not upload any clips.");
      if (clip) {
        const c = footage.find((x) => x.id === clip);
        if (!c) return fail(`No clip '${clip}' (clips: ${footage.map((x) => x.id).join(", ")}).`);
        if (!c.words) return fail(`Clip ${c.id} is not transcribed yet: the editor transcribes it when the video opens.`);
        const a = Math.min(from ?? 0, Math.max(0, c.words.length - 1));
        const b = Math.min(to ?? c.words.length - 1, c.words.length - 1);
        return text(c.words.slice(a, b + 1).map((w, i) => `#${a + i} ${w.start.toFixed(2)} ${w.text}`).join("\n"));
      }
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
      for (const c of footage) {
        const head = `clip ${c.id} "${c.name}": ${c.duration?.toFixed(1) ?? "?"}s, ${c.width ?? "?"}x${c.height ?? "?"}, src=${c.url}`;
        const body = !c.words ? "not transcribed yet (the editor transcribes it when the video opens)" : c.words.length ? `${c.words.length} words:\n${transcriptLines(c.words).join("\n")}` : "no speech found";
        content.push({ type: "text", text: `${head}\n${body}` });
        if (c.poster && c.duration) {
          const sheet = await api.media(c.poster);
          content.push({ type: "text", text: `${c.id} contact sheet, 4×3 frames left→right, top→bottom at ${posterTimes(c.duration).map((t) => `${t}s`).join(", ")}: see where the face and the free space are.` });
          content.push({ type: "image", data: sheet.bytes.toString("base64"), mimeType: sheet.mime });
        }
      }
      return { content };
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "edit_footage",
  {
    description:
      "Cut the user's footage by its transcript. `cut` = word ranges in the order they play: `c1:0-45, c1:52-130, c2:3-60` (clip:from-to, numbers from get_footage); a later take may come first (the hook). Inside each range, silences longer than max_pause (default 0.35 s) and filler sounds (um, uh, erm) are cut out. Replaces the whole edit: layer group `footage` (ft1, ft2… full-frame video layers with their own sound, kept under everything else), the kept words become the captions on the new timeline, and the video length becomes the edit's. punch_in (e.g. 1.1) scales every other cut, which hides jump cuts. Call it again to change the cut; never move or trim footage layers by hand. Time overlays afterwards with @word/@phrase refs: they follow the new timeline.",
    inputSchema: {
      cut: z.string().min(3),
      max_pause: z.number().min(0.1).max(3).optional(),
      pad: z.number().min(0).max(0.5).optional(),
      fillers: z.boolean().optional().describe("drop um/uh/erm (default true)"),
      punch_in: z.number().min(1).max(1.5).optional(),
    },
  },
  guard(async ({ cut, max_pause, pad, fillers, punch_in }) => {
    const footage = (await api.project()).footage ?? [];
    const o = { maxPause: max_pause ?? DEFAULT_EDIT.maxPause, pad: pad ?? DEFAULT_EDIT.pad, dropFillers: fillers ?? DEFAULT_EDIT.dropFillers, punchIn: punch_in ?? DEFAULT_EDIT.punchIn };
    let edit: ReturnType<typeof buildEdit>;
    try {
      edit = buildEdit(footage, parseSegments(cut), o);
    } catch (e) {
      return fail((e as Error).message);
    }
    const scene = await currentScene();
    const layers = parseLines(footageLines(edit.pieces, Number(scene?.width ?? 1080), Number(scene?.height ?? 1920), o.punchIn));
    const ops = [
      { op: "remove_group", group: FOOTAGE_GROUP },
      ...layers.map((layer) => ({ op: "add_layer", layer })),
      // The footage is the backdrop: everything the agent adds draws on top of it.
      ...layers.map((layer, i) => ({ op: "reorder", id: layer.id, index: i })),
      { op: "set_captions", captions: { words: edit.captions } },
      { op: "set_duration", duration: edit.duration },
    ];
    const res = await bridge.applyOps(ops as Op[]);
    if (!res.ok) return fail(res.error ?? "rejected");
    session.editsSinceReview = true;
    const rows = edit.pieces.map((p, i) => `ft${i + 1} ${p.start.toFixed(2)}-${(p.start + p.out - p.in).toFixed(2)}s ${p.clip}#${p.from}-${p.to} ${JSON.stringify(p.text)}`);
    return text([`${edit.pieces.length} cuts, ${edit.duration.toFixed(1)} s, ${edit.captions.length} words on the new timeline:`, ...rows].join("\n"));
  }),
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
let checkpoints = new Checkpoints();
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
  const issues = await lintTouched(layers, ids, scene);
  if (!issues) return [...notes, "lint skipped: the editor is not connected"];
  const { fixed, remaining } = await autofix(issues, byId, ids, scene);
  session.lintIds = [...new Set(remaining.map((i) => i.id))];
  return [...notes, ...fixed, ...(remaining.length ? formatIssues(remaining) : [fixed.length ? "lint: clean after the auto-fixes" : "lint: clean"])];
}

/** Lint the layers in `ids` at their own start and middle; null when the editor is not connected. */
async function lintTouched(layers: LintLayer[], ids: Set<string>, scene: Record<string, unknown>): Promise<Issue[] | null> {
  const duration = durationOf(scene);
  const times: number[] = [];
  for (const l of layers) {
    if (!ids.has(String(l.id)) || l.visible === false) continue;
    const start = Number(l.start ?? 0);
    const end = l.end == null ? duration : Math.min(Number(l.end), duration);
    times.push(start, (start + Math.max(start, end)) / 2);
  }
  if (!times.length) return [];
  const list = await layoutAt(times);
  if (!list) return null;
  return lintLayers({ layers, frames: list, palette: paletteOf(scene, list), size: sizeOf(scene) }).filter((i) => i.id.split("+").some((part) => ids.has(part)));
}

/**
 * Apply every lint fix that carries exact ops (text too small, low contrast, a still layer mostly off
 * the frame) without a round trip to the model, then lint once more: only what needs judgment
 * (overlaps, missing anchors, fixes that did not hold) reaches the agent.
 */
async function autofix(issues: Issue[], byId: Map<string, Record<string, unknown>>, ids: Set<string>, scene: Record<string, unknown>): Promise<{ fixed: string[]; remaining: Issue[] }> {
  const fixable = issues.filter((i) => i.fix?.length);
  if (!fixable.length) return { fixed: [], remaining: issues };
  const ops = fixable.flatMap((i) => i.fix!);
  const res = await bridge.applyOps(ops as Op[]);
  if (!res.ok) return { fixed: [`auto-fix rejected: ${res.error ?? "?"}`], remaining: issues };
  session.editsSinceReview = true;
  // Keep the in-memory layers in step with what the editor now has.
  for (const op of ops) if (op.op === "patch" && op.fields && typeof op.fields === "object") Object.assign(byId.get(String(op.id)) ?? {}, op.fields);
  const again = await lintTouched([...byId.values()] as LintLayer[], ids, scene);
  return { fixed: [`auto-fixed ${fixable.length}: ${fixable.map((i) => i.message).join("; ")}`], remaining: again ?? issues.filter((i) => !i.fix?.length) };
}

server.registerTool(
  "add_layers",
  {
    description:
      "Add or replace layers with COMPACT LINES (far cheaper than JSON): `id type start[-end] key=value… \"text or path data\" {json}`. Types rect|ellipse|text|image|path|object|text3d|particles|use|shader (`id use START comp=NAME x= y= s= $param=value…` places a component from define_component; shader = custom WGSL with p0..p7 params; fx=\"WGSL\" fx0..fx7 = shader effect on any layer). Values: number, tween `from>to@t0-t1[:ease]`, keys `t:v[:ease],…`, or `(expression)`. Keys: x y w h s r o rad pivot parent fill grad stroke soft shadow glow blur blend matte vis rep size role align lh ls ts te to filled g src fit z rx ry persp cam fixed light (object key light AZ,EL[,COLOR,INTENSITY]); particles: emit rate burst life speed dir spread grav drag wind wander look size alpha colors (manual: Particles). A trailing {json} merges any field (e.g. text animators). Full syntax, camera math and recipes are in the manual (get_project / get_reference). An existing id is replaced.",
    inputSchema: { lines: z.string().min(1) },
  },
  guard(async ({ lines }) => {
    const { count, notes } = await writeLines(lines);
    return text([`${count} layers ok`, ...notes].join("\n"));
  }),
);

/**
 * Patch fields written as compact keys (`ls`, `lh`, `s`, `o`, `rad`, `te`, `g`…, with compact values
 * like `0>1@0-.8:eo`) become the layer's JSON fields, so a patch op takes either spelling. JSON
 * names and JSON values (objects, arrays) pass through untouched.
 */
function aliasPatchFields(ops: Record<string, unknown>[], layers: Record<string, unknown>[]): Record<string, unknown>[] {
  return ops.map((op) => {
    if (op.op !== "patch" || !op.fields || typeof op.fields !== "object") return op;
    const ids = new Set([op.id, ...((op.ids as unknown[] | undefined) ?? [])].filter(Boolean).map(String));
    const layer = layers.find((l) => ids.has(String(l.id)) || (op.group !== undefined && l.group === op.group)) ?? (op.all ? layers[0] : undefined);
    if (!layer) return op;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(op.fields as Record<string, unknown>)) {
      const plain = typeof value === "number" || (typeof value === "string" && !/\s/.test(value));
      let parsed: Record<string, unknown> | null = null;
      if (plain && !key.includes(".")) {
        try {
          parsed = parsePartial(`${key}=${value}`, layer);
        } catch {
          parsed = null;
        }
      }
      // Only a key the compact syntax renames is translated (fill, text… keep their JSON value).
      if (parsed && !(key in parsed)) Object.assign(fields, parsed);
      else fields[key] = value;
    }
    return { ...op, fields };
  });
}

/** add_layers' work, for the tool and for run scripts: parse, write, place and lint (auto-fixing what has exact fixes). */
async function writeLines(lines: string): Promise<{ count: number; notes: string[] }> {
  await preloadIcons(lines, api);
  const layers = parseLines(lines);
  resolveLayerTimes(layers, wordsOf(await currentScene()));
  const existing = new Set(layersOf(await currentScene()).map((l) => String(l.id)));
  const ops = layers.flatMap((layer) => [...(existing.has(String(layer.id)) ? [{ op: "remove_layer", id: layer.id }] : []), { op: "add_layer", layer }]);
  const res = await bridge.applyOps(ops as Op[]);
  if (!res.ok) throw new Error(res.error ?? "rejected");
  session.editsSinceReview = true;
  return { count: layers.length, notes: await settle(layers.map((l) => String(l.id)), layers) };
}

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
    await preloadIcons(`${lines}\n${params ?? ""}`, api);
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
    description:
      "Motionily's sound effect library (real recorded and produced effects, the same for every video), grouped by category: name | seconds | shape, peak, hits | description. You cannot listen, so read the numbers: hit = loudest at once (place at the moment); build = peaks late (risers: use hit=T in add_sfx so the peak lands on T); swell = passes through; steady = a loop or bed (give it len=). `peak` and `hits` are seconds into the file.",
    inputSchema: { category: z.string().optional().describe("only this category (e.g. Whooshs, Risers)") },
  },
  guard(async ({ category }) => text(formatSounds(await api.sounds(), category))),
);

server.registerTool(
  "find_icons",
  {
    description:
      "Search icons by words in Lucide (1,900 clean line icons, bundled) and Iconify (~275k icons in 150+ sets: Phosphor, Tabler, Material Symbols, Solar, hand-drawn and duotone sets…; only sets a video may use). Returns names grouped by set: `bell` (Lucide) or `ph:bell-ringing` (Iconify). Use them in path layers: `bell path 1 x=300 y=200 ic=ph:bell-ringing:48` (centered on x,y; SIZE px; filled sets get fill=, line sets stroke=). Pick ONE set per video so icons match. Multicolor icons go through add_vector icon=…. Never hand-draw icons.",
    inputSchema: { query: z.string().min(1).describe("words, e.g. 'chart growth' or 'mail send'"), limit: z.number().int().min(1).max(60).default(24) },
  },
  guard(async ({ query, limit }) => {
    const lucide = findIcons(query, Math.min(limit, 12));
    const remote = await api.icons(query, limit).catch(() => null);
    const bySet = new Map<string, string[]>();
    for (const i of remote ?? []) {
      const key = `${i.set} (${i.license}${i.multicolor ? ", multicolor: add_vector" : ""})`;
      bySet.set(key, [...(bySet.get(key) ?? []), i.id]);
    }
    const lines = [lucide.length ? `Lucide (line, stroke=): ${lucide.join(", ")}` : ""];
    for (const [set, ids] of bySet) lines.push(`${set}: ${ids.join(", ")}`);
    if (!remote) lines.push("(Iconify unreachable right now: Lucide only)");
    const out = lines.filter(Boolean);
    return text(out.length ? out.join("\n") : `no icon matches '${query}'; try simpler words`);
  }),
);

/** Hits per query by default: two rows of a contact sheet. */
const HITS_PER_QUERY = 8;
const KindEnum = z.enum(Object.values(AssetKind) as [AssetKind, ...AssetKind[]]);

/** One line per imported item: what it is and how to place it. */
function assetLine(c: ImageCredit): string {
  const size = c.width && c.height ? ` ${c.width}×${c.height}` : "";
  if (c.format === AssetFormat.Video) return `"${c.title}" video src "${c.src}"${c.duration ? ` ${c.duration.toFixed(1)}s` : ""}${size}${c.poster ? ` (contact sheet ${c.poster})` : ""}`;
  if (c.format === AssetFormat.Svg) return `"${c.title}" vector svg "${c.svg}" (add_vector) · PNG src "${c.src}"${size}`;
  return `"${c.title}" image src "${c.src}"${size}`;
}

server.registerTool(
  "search_assets",
  {
    description: `Gather REAL material for the video like a human editor: photos, stock footage, logos, textures. ONE call with every need of the whole video (one query per subject, in English: names, places, years, objects). Each query searches all sources of its kind at once and comes back as ONE numbered contact sheet; pick by looking, then import_assets the numbers' ids.
kinds: photo (Wikimedia Commons, Europeana, the Met, Openverse, Pexels, Pixabay, web*) · footage (stock clips from Pexels and Pixabay; public-domain films and newsreels from the Internet Archive and Commons) · logo (brand logos as SVG: Iconify brand sets, Wikimedia Commons, web*) · texture (paper, film, fabric, concrete… for backgrounds and blend layers).
Items already in the user's library come first (marked). *web = the user's own Brave key; its results have unknown licenses: editorial use only (history, news, commentary), never as if the brand endorsed the video.`,
    inputSchema: {
      needs: z
        .array(z.object({ q: z.string().min(2).max(120), kind: KindEnum }))
        .min(1)
        .max(10)
        .describe("e.g. [{q:'Fanta',kind:'logo'},{q:'Coca-Cola bottling plant Essen 1940',kind:'photo'},{q:'apples falling slow motion',kind:'footage'},{q:'old newsprint paper',kind:'texture'}]"),
      per_query: z.number().int().min(2).max(12).default(HITS_PER_QUERY),
    },
  },
  async ({ needs, per_query }) => {
    try {
      const res = await api.searchAssets(needs, per_query);
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
      const notes = [
        res.missingKeys.length ? `Not searched (no API key): ${res.missingKeys.join(", ")} — the user can add keys in Settings › Asset sources.` : "",
        res.unavailable.length ? `Unavailable right now: ${res.unavailable.join(", ")}` : "",
      ].filter(Boolean);
      if (notes.length) content.push({ type: "text", text: notes.join("\n") });
      let n = 1;
      for (const g of res.groups) {
        if (!g.hits.length) {
          content.push({ type: "text", text: `## ${g.kind} "${g.q}": nothing usable (try other words: names, places, years; or another kind)` });
          continue;
        }
        const rows = g.hits.map((h) => {
          const facts = [
            h.title,
            h.format === AssetFormat.Svg ? "SVG" : h.format === AssetFormat.Video ? `video ${h.duration ? `${Math.round(h.duration)}s` : ""}`.trim() : "",
            h.width && h.height ? `${h.width}x${h.height}` : "",
            h.date,
            h.license,
            h.author ? `by ${h.author}` : "",
            h.library ? "IN YOUR LIBRARY" : "",
            h.editorial ? "EDITORIAL ONLY" : "",
            h.description,
          ].filter(Boolean);
          return `[${n++}] id="${h.id}" ${facts.join(" | ")}`;
        });
        content.push({ type: "text", text: `## ${g.kind} "${g.q}" (sheet numbered left→right, top→bottom)\n${rows.join("\n")}` });
        if (g.sheet) content.push({ type: "image", data: g.sheet, mimeType: "image/jpeg" });
      }
      return { content };
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "import_assets",
  {
    description:
      "Import chosen search_assets hits (or library ids) into this video, with their credits; everything also joins the user's library for later videos. Returns per item: image src (image layer, `fit=cover` photos / `contain` logos), a vector svg for logos (add_vector — animate its pieces) plus its PNG src, or a video src with length and contact sheet (video layer). Import only what you will show.",
    inputSchema: {
      ids: z.array(z.string().min(3)).min(1).max(16).describe("ids from search_assets"),
      query: z.string().max(300).optional().describe("what these are, in a few words (makes the library findable later)"),
    },
  },
  guard(async ({ ids, query }) => {
    const res = await api.importAssets(ids, query);
    const lines = res.map((r) => (r.credit ? `${r.id} -> ${assetLine(r.credit)} · ${r.credit.license}, ${r.credit.author}` : `${r.id} -> FAILED: ${r.error}`));
    return text(`${lines.join("\n")}\nCredits are kept with the video; the user sees them in the editor. view_image shows any of them.`);
  }),
);

server.registerTool(
  "cut_out",
  {
    description:
      "Cut the subject out of images (person, bottle, building, animal…): returns a PNG with a transparent background trimmed to the subject, for collage looks — cutouts with a white outline (stroke on a duplicate or shadow) and a drop shadow, subjects breaking out of their photo's frame, parallax layers. Works on imported photos and brand images (/media/… src). A few seconds each.",
    inputSchema: { srcs: z.array(z.string().regex(/^\/media\/[a-f0-9-]{36}\.[a-z0-9]{1,5}$/)).min(1).max(6) },
  },
  guard(async ({ srcs }) => {
    const lines: string[] = [];
    for (const src of srcs) {
      try {
        const c = await api.cutout(src);
        lines.push(`${src} -> cutout src "${c.src}" ${c.width}×${c.height} (transparent; image layer with fit=contain)`);
      } catch (e) {
        lines.push(`${src} -> FAILED: ${(e as Error).message}`);
      }
    }
    return text(lines.join("\n"));
  }),
);

server.registerTool(
  "generate_image",
  {
    description:
      "LAST RESORT: generate an image with the user's own OpenAI key when no real photo, logo or footage exists for something the story needs (an illustration in a precise style, an object that never existed). Real material reads human; generated images read generated. Describe subject, style, framing and background precisely; transparent=true for a cutout-ready object. Costs the user OpenAI credits: one image per real need.",
    inputSchema: {
      prompt: z.string().min(8).max(4000),
      transparent: z.boolean().default(false),
      orientation: z.enum(["portrait", "landscape", "square"]).optional().describe("default: the video's shape"),
    },
  },
  async ({ prompt, transparent, orientation }) => {
    try {
      const c = await api.generateImage(prompt, transparent, orientation);
      const img = await api.media(c.preview ?? c.src);
      return {
        content: [
          { type: "text" as const, text: `generated src "${c.src}" ${c.width}×${c.height}${transparent ? " (transparent)" : ""}; it joined the user's library.` },
          { type: "image" as const, data: img.bytes.toString("base64"), mimeType: img.mime },
        ],
      };
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "list_library",
  {
    description: "The user's asset library: everything imported, cut out or generated for earlier videos (logos, photos, footage, textures), newest first. Reuse with import_assets ids (library:…). search_assets already puts matching library items first.",
    inputSchema: { kind: KindEnum.optional(), limit: z.number().int().min(1).max(200).default(60) },
  },
  guard(async ({ kind, limit }) => {
    const rows = await api.library(kind, limit);
    return text(rows.length ? rows.map((r) => `${r.id} | ${r.kind} | ${assetLine(r.credit)} | used in ${r.videos} video(s)`).join("\n") : "The library is empty: search_assets + import_assets fill it.");
  }),
);

server.registerTool(
  "add_vector",
  {
    description: `Place an SVG (an imported logo's svg, or an icon prefix:name) as REAL path layers you can animate piece by piece, like a vector logo in After Effects: a parent layer ID (invisible, w×h of the drawing: move/scale/rotate the whole thing) and children ID_1…ID_N in paint order, each with its own fill/stroke. Fitted inside w×h keeping its aspect, centered on x,y.
split=parts (default): one layer per run of shapes painted alike. split=letters: every separate piece (each letter with its holes, a dot, a leaf) its own layer, left to right — for letters flying in one by one.
color= recolors every piece (one-color logos on your palette). stroke=W:COLOR outlines every piece: draw it on with te=0>1 and fade the fill in after (o or fill keys) for a classic logo reveal.
Returns each piece's id, paint and box (center x,y relative to the parent, size): animate them with edit_layers. Pieces are nonzero-filled like the SVG. Text inside the SVG cannot become paths (it is reported): use the PNG then.`,
    inputSchema: {
      id: z.string().regex(/^[A-Za-z_][\w-]{0,39}$/),
      svg: z.string().regex(/^\/media\/[a-f0-9-]{36}\.svg$/).optional().describe("an imported logo's svg path"),
      icon: z.string().regex(ICONIFY_ID).optional().describe("or an Iconify icon id (multicolor ones too)"),
      x: z.number(),
      y: z.number(),
      w: z.number().positive().optional(),
      h: z.number().positive().optional(),
      start: z.number().min(0).default(0),
      end: z.number().positive().optional(),
      g: z.string().optional().describe("group (default: the id)"),
      split: z.enum([VectorSplit.Parts, VectorSplit.Letters]).default(VectorSplit.Parts),
      color: z.string().optional().describe("palette slot or #hex for every piece"),
      stroke: z.string().regex(/^[\d.]+:\S+$/).optional().describe("W:COLOR outline on every piece"),
    },
  },
  guard(async ({ id, svg, icon, x, y, w, h, start, end, g, split, color, stroke }) => {
    if (!svg === !icon) return fail("give exactly one of svg (an imported logo) or icon (prefix:name)");
    let source: string;
    if (svg) source = await api.mediaText(svg);
    else {
      const { icons, missing } = await api.iconData([icon!]);
      const i = icons[0];
      if (!i) return fail(missing[0] ?? `no icon ${icon}`);
      source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${i.width} ${i.height}" color="#000000">${i.body}</svg>`;
    }
    const built = vectorLines(svgToVector(source), { id, start, end, x, y, w, h, group: g ?? id, split, color, stroke });
    const { count, notes } = await writeLines(built.lines.join("\n"));
    const parts = built.parts.map((p) => `${p.id}: ${p.paint} · center ${p.box[0]},${p.box[1]} size ${p.box[2]}×${p.box[3]}`);
    return text(
      [`${count} layers: parent ${id} (${built.size[0]}×${built.size[1]} at ${x},${y}) + ${built.parts.length} pieces`, ...parts, ...built.warnings.map((w) => `note: ${w}`), ...notes].join("\n"),
    );
  }),
);

server.registerTool(
  "add_map",
  {
    description: `Add a real map (Natural Earth countries, public domain) as path layers framed on the places that matter: parent ID (invisible, the map box) + ID_land (all land, one fill) + ID_borders (country lines) + ID_<country> for each highlighted country (own layer: fill it in, pulse it, draw its outline on with a stroke + te). Clipped to the box. Countries in English ("Germany", "USA", "Bosnia and Herzegovina"…).
focus = countries the frame fits (empty = the whole world). projection: mercator (default with a focus), natural_earth (default for the world), equirectangular.
points = places as lon/lat: their scene x,y come back for pins, labels and routes (draw a route as a path with te=0>1 between the returned points).`,
    inputSchema: {
      id: z.string().regex(/^[A-Za-z_][\w-]{0,39}$/),
      x: z.number(),
      y: z.number(),
      w: z.number().positive(),
      h: z.number().positive(),
      start: z.number().min(0).default(0),
      end: z.number().positive().optional(),
      g: z.string().optional(),
      focus: z.array(z.string()).max(30).default([]),
      highlight: z.array(z.string()).max(20).default([]),
      projection: z.enum([MapProjection.Mercator, MapProjection.NaturalEarth, MapProjection.Equirectangular]).optional(),
      land: z.string().default("surface").describe("land fill: palette slot or #hex"),
      accent: z.string().default("accent").describe("highlighted countries' fill"),
      borders: z.string().default("1:background").describe("W:COLOR or none"),
      pad: z.number().min(0).max(2).default(0.12).describe("margin around the focus (fraction of its size)"),
      points: z.array(z.object({ name: z.string(), lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) })).max(40).default([]),
    },
  },
  guard(async (o) => {
    const built = await mapLines({ ...o, group: o.g ?? o.id });
    if (built.unknown.length) return fail(`unknown countries: ${built.unknown.join(", ")} (English names, e.g. "Germany", "United Kingdom")`);
    const { count, notes } = await writeLines(built.lines.join("\n"));
    return text([`${count} map layers`, ...built.info, ...notes].join("\n"));
  }),
);

server.registerTool(
  "set_direction",
  {
    description: `Declare this video's art direction BEFORE building the world, after reading the brief and gathering material: a genre from the vocabulary in the manual (STYLE VOCABULARY), the concept in one sentence and the signature techniques you will use. Returns three reference films of that genre drawn at random (take their moves, never copy them whole), the two creative constraints this video must honor (say how you honor each in your scene lines), and what the account's latest videos looked like (font, color, genre, techniques): this one must look clearly different from them.`,
    inputSchema: {
      genre: z.enum(Object.values(Genre) as [Genre, ...Genre[]]),
      concept: z.string().min(10).max(400).describe("one sentence: the visual idea and why it fits this story"),
      techniques: z.array(z.string().max(120)).max(12).describe("signature moves, e.g. ['cutouts with white outline', 'map route drawn on', 'halftone photos']"),
      redraw: z.boolean().optional().describe("draw new constraints (a fresh take on the same video)"),
    },
  },
  guard(async (body) => {
    const [r, favorites] = await Promise.all([api.setDirection(body), api.favorites().catch(() => [])]);
    const refs = r.references.map((f) => `- ${f.title}: ${f.look} Moves: ${f.moves}`);
    const loved = favorites.map((f) => `- "${f.name}": ${[f.direction ? `${f.direction.genre} — ${f.direction.concept}` : "", f.font && `font ${f.font}`].filter(Boolean).join(" · ")}`);
    const recent = r.recent.filter((f) => !f.favorite).map((f) => `- "${f.name}": ${[f.genre, f.font && `font ${f.font}`, f.primary && `primary ${f.primary}`, f.techniques.join(", ")].filter(Boolean).join(" · ")}`);
    return text(
      [
        `Direction saved: ${r.direction.genre} — ${r.direction.concept}`,
        `Reference films (${r.direction.genre}):`,
        ...refs,
        `Creative constraints (honor both, visibly):`,
        ...r.constraints.map((c, i) => `${i + 1}. ${c}`),
        loved.length ? "The user's FAVORITE videos — their taste: study why they work (examples find) and keep those principles; the look may differ:" : "",
        ...loved,
        recent.length ? "The account's latest other videos (do NOT repeat their font, main color or signature moves):" : "",
        ...recent,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }),
);

server.registerTool(
  "add_sfx",
  {
    description:
      "Place library sound effects on the timeline, one per line: `id sound_name at [gain] [from=S] [len=S]` (at = seconds from the video start; gain 0.1-1, default 0.45; keep 0.3-0.6 under a voice, never above 0.8 — the user has an effects volume slider). `hit=T` instead of at lands the sound's loudest moment on second T (risers into a reveal, a whoosh peaking on a cut). `from=S` starts that far into the file (one hit of a long recording: from= one of its hits), `len=S` plays only that long and fades out (always for steady loops and beds). Same id moves/replaces it. Sync them to motion: whoosh on moves and transitions, click on entrances and UI, impact on hero text landing, riser into reveals. 1 sound per meaningful event; never stack more than 2 at once.",
    inputSchema: { lines: z.string().min(1) },
  },
  guard(async ({ lines }) => {
    const library = new Map((await api.sounds()).map((s) => [s.name, s]));
    const ops: Op[] = [];
    const warnings: string[] = [];
    for (const line of lines.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const r = parseCue(line, library, SFX_GAIN);
      if ("error" in r) return fail(`bad line '${line}': ${r.error} (expected 'id sound_name at [gain] [from=S] [len=S]' or 'id sound_name hit=T …'; list_sounds shows the library)`);
      ops.push({ op: "put_sfx", cue: r.cue } as Op);
      if (r.warning) warnings.push(r.warning);
    }
    const res = await bridge.applyOps(ops);
    return res.ok ? text([`${ops.length} sounds placed`, ...warnings].join("\n")) : fail(res.error ?? "rejected");
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

/** A voice silence longer than this (s) is dead air review_video reports. */
const DEAD_AIR_S = 0.8;
/** Captions further than this (s) from the voice read as out of sync. */
const SYNC_TOLERANCE_S = 0.25;

/** Characters of each layer line an example card shows. */
const EXAMPLE_LINE = 220;

server.registerTool(
  "examples",
  {
    description:
      "The user's FAVORITE videos (they star them in the editor): their taste. find [QUERY] returns up to three, best match first: what each was about, its direction and techniques, and its first layers. Learn WHY they work (material, restraint, the one signature device, timing) and bring those principles here; never paste one in or clone its look. save stars the current video as a favorite — only when the user says they love it.",
    inputSchema: {
      action: z.enum(["save", "find"]),
      query: z.string().optional().describe("words about this video (topic, genre, format)"),
    },
  },
  guard(async ({ action, query }) => {
    if (action === "save") {
      await api.setFavorite(true);
      return text("starred: this video is now one of the user's favorites (agents study it as their taste).");
    }
    const favorites = await api.favorites();
    if (!favorites.length) return text("the user has no favorite videos yet (they star the ones they love in the editor).");
    const examples = favorites.map((f) => ({
      fav: f,
      ex: {
        label: f.name,
        tags: [f.direction?.genre ?? "", ...(f.direction?.techniques ?? []), f.brief, f.format].filter(Boolean),
        savedAt: f.favoritedAt,
        width: 0,
        height: 0,
        duration: f.duration ?? 0,
        palette: f.palette,
        scene: {},
      } as Example,
    }));
    const ranked = rankExamples(examples.map((e) => e.ex), query ?? "").slice(0, 3);
    const cards = await Promise.all(
      ranked.map(async (ex) => {
        const f = examples.find((e) => e.ex === ex)!.fav;
        const full = await api.favoriteScene(f.id);
        const scene = full.scene ?? {};
        // Long path data and code say nothing about the craft: cut each line short.
        const card = describeExample({ ...ex, width: Number(scene.width ?? 0), height: Number(scene.height ?? 0), scene }, (l) => {
          const line = formatLayer(l);
          return line.length > EXAMPLE_LINE ? `${line.slice(0, EXAMPLE_LINE)}…` : line;
        });
        const dir = f.direction ? `direction: ${f.direction.genre} — ${f.direction.concept}` : "";
        return [card.split("\n")[0], dir, f.font ? `font: ${f.font}` : "", ...card.split("\n").slice(1)].filter(Boolean).join("\n");
      }),
    );
    return text(`${favorites.length} favorite video(s); the closest:\n\n${cards.join("\n\n")}`);
  }),
);

/** Where a phrase sits in the caption words: indices of its first and last word, or null. */
function findPhrase(words: Word[], phrase: string): [number, number] | null {
  const norm = (w: string) => w.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
  const want = phrase.split(/\s+/).map(norm).filter(Boolean);
  const have = words.map((w) => norm(w.text));
  if (!want.length) return null;
  for (let i = 0; i + want.length <= have.length; i++) if (want.every((w, k) => have[i + k] === w)) return [i, i + want.length - 1];
  return null;
}

server.registerTool(
  "cut",
  {
    description: `Cut time out of the video like an editor's razor: everything in the range goes (the voice skips it, captions, layers, clips with a jump cut, sound effects, markers) and everything after moves up, so nothing goes out of sync. Three ways:
- pauses=true: tighten the voice's dead air — every silence longer than longer_than (0.6 s) becomes a breath of keep (0.4 s). Do it FIRST, before building beats (the build then sits on the tight timing), and whenever review_video reports dead air. The pause right after the hook is the one that loses viewers.
- phrase: the words to remove, as spoken (found in the voice's words; cut at the middle of the pauses around it).
- from/to: seconds.
The video gets shorter by the cut. To cut just one layer or clip in two, use the split_layer op; to trim a clip, its in/out.`,
    inputSchema: {
      pauses: z.boolean().optional().describe("tighten every long silence of the voice"),
      longer_than: z.number().min(0.3).max(3).default(0.6).describe("pauses=true: silences longer than this (s) are cut"),
      keep: z.number().min(0.1).max(1).default(0.4).describe("pauses=true: the breath left in each (s)"),
      phrase: z.string().min(1).optional().describe("words as spoken, e.g. 'On Historia, we open the files one screen at a time'"),
      from: z.number().min(0).optional(),
      to: z.number().positive().optional(),
    },
  },
  guard(async ({ pauses, longer_than, keep, phrase, from, to }) => {
    const scene = await currentScene();
    if (pauses) {
      const words = voiceWords(scene, (await api.project()).audio?.words);
      if (!words.length) return fail("no voice words to find the pauses in (no captions and no voice alignment): give from/to seconds");
      const gaps = deadAir(words, longer_than);
      if (!gaps.length) return text(`no silence longer than ${longer_than} s: the voice is already tight.`);
      // Last first, so the earlier ranges keep their times; the breath sits slightly before the next word.
      const ops = gaps.map((g) => ({ op: OpName.RippleDelete, from: +(g.from + keep * 0.45).toFixed(3), to: +(g.to - keep * 0.55).toFixed(3) })).reverse();
      const res = await bridge.applyOps(ops as Op[]);
      if (!res.ok) return fail(res.error ?? "the cuts were refused");
      session.editsSinceReview = true;
      const total = ops.reduce((sum, o) => sum + (o.to - o.from), 0);
      const dur = Number((await currentScene())?.duration ?? 0);
      return text(`tightened ${gaps.length} pause(s) to ${keep} s (${total.toFixed(2)} s of dead air gone): ${gaps.map((g) => `${g.from.toFixed(2)} s "${g.before} … ${g.after}" ${(g.to - g.from).toFixed(2)} s`).join("; ")}. The video is now ${dur.toFixed(2)} s; everything after each cut moved up.`);
    }
    let range: [number, number];
    if (phrase) {
      const words = voiceWords(scene, (await api.project()).audio?.words);
      if (!words.length) return fail("no voice words to find the phrase in: give from/to seconds (inspect's voice timeline has them)");
      const hit = findPhrase(words, phrase);
      if (!hit) return fail(`'${phrase}' is not in the voice word for word. It reads: ${words.map((w) => w.text).join(" ").slice(0, 600)}…`);
      const [i, j] = hit;
      const before = words[i - 1];
      const after = words[j + 1];
      range = [before ? (before.end + words[i]!.start) / 2 : Math.max(0, words[i]!.start - 0.05), after ? (words[j]!.end + after.start) / 2 : words[j]!.end + 0.15];
    } else if (from !== undefined && to !== undefined && to > from) range = [from, to];
    else return fail("give pauses=true, the phrase to cut, or from and to (seconds, to > from)");
    const res = await bridge.applyOps([{ op: OpName.RippleDelete, from: range[0], to: range[1] }] as Op[]);
    if (!res.ok) return fail(res.error ?? "the cut was refused");
    session.editsSinceReview = true;
    const dur = Number((await currentScene())?.duration ?? 0);
    return text(`cut ${range[0].toFixed(2)}–${range[1].toFixed(2)} s (${(range[1] - range[0]).toFixed(2)} s): everything after moved up; the video is now ${dur.toFixed(2)} s. Check the seams with render_frames around ${range[0].toFixed(2)} s.`);
  }),
);

/** Ops agents reach for that do not exist, and what does the job (or that nothing does). */
const OP_ALIASES: Record<string, string> = {
  set_voice: "the cut tool (a phrase or from/to: the voice and everything else move up together), or the `ripple_delete` op; `set_audio` only places and trims the whole voice",
  cut_audio: "the cut tool (a phrase or from/to) or the `ripple_delete` op",
  cut_voice: "the cut tool (a phrase or from/to) or the `ripple_delete` op",
  split: "the `split_layer` op {id, at}",
  cut_layer: "the `split_layer` op {id, at}, then remove the piece you do not want",
  set_volume: "`set_audio` (voice), `set_music` (music) or `set_sfx_volume` (effects)",
  add_text: "`add_layer` with a text layer (or add_layers lines)",
  set_font: "the set_font tool (or `set_typography`)",
};

/** The closest real op names to an unknown one (edit distance), plus a known alias. */
function unknownOpHint(name: string, valid: string[]): string {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length]![b.length]!;
  };
  const near = valid.map((v) => ({ v, d: dist(name, v) })).sort((x, y) => x.d - y.d).slice(0, 3).map((x) => `\`${x.v}\``);
  const alias = OP_ALIASES[name];
  return `${alias ? ` Use: ${alias}.` : ""}${near.length ? ` Closest ops: ${near.join(", ")}.` : ""} If nothing in the ops list does what you need, the engine cannot do it yet: tell the user plainly instead of trying variants.`;
}

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
    const batch = aliasPatchFields(ops as Record<string, unknown>[], layersOf(await currentScene()));
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
    const valid = /expected one of (.+)$/m.exec(res.error ?? "")?.[1]?.match(/`([a-z_]+)`/g)?.map((v) => v.replace(/`/g, "")) ?? [];
    const hint = unknown ? unknownOpHint(unknown, valid) : "";
    return fail(`${unknown ? `op \`${unknown}\` does not exist.${hint}` : (res.error ?? "rejected")}\nNothing was applied: resend the whole batch fixed.\n${EDIT_HINT}`);
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
    await preloadIcons(lines, api);
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
      "Save the voice-over script (ElevenLabs v3 format: one tone tag like [warm] first, one paragraph per scene, '[long pause] [long pause]' between scenes, numbers in letters; a story reel ends on its payoff line echoing the first, a product video's last sentence carries the CTA; vertical = 100-130 words). Write ONE continuous story told like to a friend: each sentence follows from the last (so, but, because, until), real names and stakes, no list of punchy lines or teaser filler ('But wait…'); for vertical videos its turns are the re-hooks of the attention curve (craft). The user pastes it in ElevenLabs and uploads the mp3.",
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
      "SELF-REVIEW the whole video before saying it's done: one contact sheet of evenly spaced frames, 12 fps strips of the moments that change most (judge easing and continuity there), automatic checks (layers off frame, text colliding or crossing card edges, text too small to read on a phone, palette too saturated/neon, dead air, blank frames), motion notes (abrupt stops, linear keys, crowded entrances, held layers, no camera) and, for vertical/square videos, the attention curve (frame 0 moving, a re-hook every 4-7 s, pattern interrupt at ~30%, escalating finale, no fade-out). Look at the sheet critically like a motion designer (framing, characters cut off or tiny, camera, readability, rhythm), fix everything with apply_ops and review again. Repeat until it is clean (max ~3 rounds). Works even if the user has no editor open.",
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
      const found = list ? lintLayers({ layers, frames: list, palette: paletteOf(scene, list), size: sizeOf(scene) }) : [];
      // Fixes with exact ops are applied here, without a round trip; only what needs judgment is listed.
      const fixable = found.filter((i) => i.fix?.length);
      const autoFix = fixable.length ? await bridge.applyOps(fixable.flatMap((i) => i.fix!) as Op[]) : null;
      const lint = autoFix?.ok ? found.filter((i) => !i.fix?.length) : found;
      session.reviewed = true;
      session.editsSinceReview = false;
      session.lintIds = [...new Set(lint.map((i) => i.id))];
      const report = [
        `duration ${r.duration}s · frames at ${r.times.join(", ")}s`,
        numbers.length ? `per frame (numbers):\n- ${numbers.join("\n- ")}` : "",
        autoFix?.ok ? `auto-fixed ${fixable.length} (the sheet below was drawn before these fixes): ${fixable.map((i) => i.message).join("; ")}` : "",
        lint.length ? `lint (apply the fix ops with apply_ops):\n- ${formatIssues(lint).join("\n- ")}` : list ? "lint: clean on the sampled frames." : "",
        r.issues.length ? `automatic checks found ${r.issues.length} issue(s):\n- ${r.issues.join("\n- ")}` : "automatic checks: no issues (still look at the sheet).",
        r.motion?.length ? `motion notes:\n- ${r.motion.join("\n- ")}` : "",
        attentionReport(scene),
        await api
          .direction()
          .then((d) => varietyNotes(scene as Parameters<typeof varietyNotes>[0], d.direction, d.recent))
          .then((v) => (v.length ? `variety (vs the account's latest videos):\n- ${v.join("\n- ")}` : ""))
          .catch(() => ""),
        ((n) => (n.length ? `AI tells (craft: AI TELLS) — fix these before calling it done:\n- ${n.join("\n- ")}` : ""))(slopNotes(scene as Parameters<typeof slopNotes>[0])),
        await api
          .project()
          .then((p) => deadAir(voiceWords(scene, p.audio?.words), DEAD_AIR_S))
          .then((g) => (g.length ? `dead air in the voice (viewers drop here): ${g.map((x) => `${x.from.toFixed(2)} s (${(x.to - x.from).toFixed(2)} s, "${x.before} … ${x.after}")`).join(", ")} — cut pauses=true` : ""))
          .catch(() => ""),
        await api
          .project()
          .then((p) => captionDrift(scene, p.audio?.words))
          .then((d) => (d && d.max > SYNC_TOLERANCE_S ? `VOICE AND CAPTIONS OUT OF SYNC: the voice says "${d.word}" ${d.max.toFixed(2)} s away from its caption at ${d.at.toFixed(2)} s. Never time-shift captions by hand: cut and ripple_delete keep voice, captions and layers together.` : ""))
          .catch(() => ""),
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

// ── Code Mode: one script instead of a chain of tool calls ──
/** Script time allowed (time waiting on the editor does not count). */
const RUN_CPU_MS = 20_000;
/** Returned value shown back, at most this many characters. */
const RUN_RETURN_CHARS = 2000;

/** Lint scope for scripts: the given layers, or every layer. */
async function lintScope(ids?: string[]) {
  const scene = (await currentScene()) ?? {};
  const byId = new Map(layersOf(scene).map((l) => [String(l.id), l]));
  return { scene, byId, set: new Set(ids?.length ? ids : [...byId.keys()]) };
}
const brief = (i: Issue) => ({ kind: i.kind, id: i.id, message: i.message, ...(i.fix ? { fix: i.fix } : {}) });

/** What run scripts can call as mo.<name>(...): the data behind the tools, as JSON. */
const scriptApi: HostApi = {
  scene: async () => currentScene(),
  layer: async (id) => layersOf(await currentScene()).find((l) => l.id === id) ?? null,
  layers: async (group) => layersOf(await currentScene()).filter((l) => group === undefined || l.group === group),
  add: async (lines) => writeLines(String(lines)),
  apply: async (ops) => {
    const res = await bridge.applyOps(aliasPatchFields(ops as Record<string, unknown>[], layersOf(await currentScene())) as Op[]);
    if (!res.ok) throw new Error(res.error ?? "rejected");
    session.editsSinceReview = true;
    return { ok: true };
  },
  layout: async (times, ids) => {
    const list = await layoutAt(times as number[]);
    if (!list) throw new Error("the editor is not connected");
    const want = Array.isArray(ids) && ids.length ? new Set(ids as string[]) : null;
    return list.flatMap((f) => f.layers.filter((r) => !want || want.has(r.id)).map((r) => ({ t: f.t, id: r.id, box: r.screen, visible: r.visible })));
  },
  lint: async (ids) => {
    const { scene, byId, set } = await lintScope(ids as string[] | undefined);
    const issues = await lintTouched([...byId.values()] as LintLayer[], set, scene);
    if (!issues) throw new Error("the editor is not connected");
    return issues.map(brief);
  },
  autofix: async (ids) => {
    const { scene, byId, set } = await lintScope(ids as string[] | undefined);
    const issues = await lintTouched([...byId.values()] as LintLayer[], set, scene);
    if (!issues) throw new Error("the editor is not connected");
    const { fixed, remaining } = await autofix(issues, byId, set, scene);
    return { fixed, remaining: remaining.map(brief) };
  },
  attention: async () => {
    const scene = await currentScene();
    if (!scene) return null;
    return { curve: attentionSparkline(attentionCurve(scene).bins), issues: attentionIssues(scene) };
  },
  sounds: async () => (await api.sounds()).map(({ url: _url, ...s }) => s),
  tool: async (name, args) => {
    if (name === "run") throw new Error("run cannot call itself");
    const t = toolHandlers.get(String(name));
    if (!t) throw new Error(`no tool '${String(name)}' for this agent`);
    const res = await t.cb(z.object(t.schema).parse(args ?? {}) as Record<string, unknown>);
    const out = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (res.isError) throw new Error(out);
    const images = res.content.filter((c) => c.type === "image").length;
    return images ? `${out}\n(${images} image(s) left out: call ${String(name)} directly to see them)` : out;
  },
};

server.registerTool(
  "run",
  {
    description: `CODE MODE: one JavaScript script instead of a chain of tool calls. Prefer it whenever a step needs more than one call (write → measure → fix, many similar layers, checking every beat): the data between calls stays in the script and only what you console.log or return comes back, so it is far cheaper than separate calls.
Calls are synchronous (no await); the code is a function body, \`return\` a small result.
mo.add(lines) → {count, notes}: add_layers compact lines (placement + lint run, exact lint fixes auto-applied; notes say what is left)
mo.apply(ops) → {ok}: apply_ops · mo.scene() · mo.layer(id) · mo.layers(group?)
mo.layout(times, ids?) → [{t, id, box:[x0,y0,x1,y1], visible}] in scene px
mo.lint(ids?) → [{kind, id, message, fix?}] · mo.autofix(ids?) → {fixed, remaining}
mo.attention() → {curve, issues} (vertical/square videos) · mo.sounds() → [{name, category, duration, peak, shape, hits, every, description}]
mo.tool(name, args) → any other tool of yours as text (images left out: look with render_frames / review_video directly)
Example: const r = mo.add(\`title text 0-3 x=540 y=420 size=96 "Hello"\`); const b = mo.layout([0.5], ["title"])[0].box; if (b[2] > 1040) mo.apply([{op:"patch", id:"title", fields:{size:80}}]); console.log(r.notes.join(" | "), b);
Limits: ${RUN_CPU_MS / 1000} s of script time, 64 MB, no network or files; the log shows the first ${LOG_CHARS} characters.`,
    inputSchema: { code: z.string().min(1).max(30_000) },
  },
  guard(async ({ code }) => {
    scriptDepth += 1;
    let r;
    try {
      r = await runScript(code, scriptApi, RUN_CPU_MS);
    } finally {
      scriptDepth -= 1;
    }
    const value = r.value === undefined ? "" : JSON.stringify(r.value);
    const lines = [
      `${r.ok ? "ok" : "error"} · ${r.calls} calls · ${(r.ms / 1000).toFixed(1)} s`,
      ...r.logs,
      value ? `return: ${value.length > RUN_RETURN_CHARS ? `${value.slice(0, RUN_RETURN_CHARS)}… (cut)` : value}` : "",
      r.ok ? "" : `error: ${r.error}`,
    ].filter(Boolean);
    return r.ok ? text(lines.join("\n")) : fail(lines.join("\n"));
  }),
);

function describeProject(p: Project): string {
  const lines = [`Project "${p.name}"`, `Brief: ${p.brief.trim() || "(empty — ask the user what the video is about)"}`, ""];
  lines.push(`Format: ${p.format}`);
  if (p.voiceScript.trim()) lines.push(`Voice script (ElevenLabs; the video is built on it):\n${p.voiceScript.trim()}`);
  if (p.references?.length) lines.push(`Reference images from the user (look with view_image): ${p.references.join(", ")}`);
  const imported = (p.imageCredits ?? []).filter((c) => c.src);
  if (imported.length) lines.push(`Imported material: ${imported.map(assetLine).join("; ")}`);
  if (p.direction) lines.push(`Direction (set_direction): ${p.direction.genre} — ${p.direction.concept}${p.direction.techniques.length ? ` · techniques: ${p.direction.techniques.join(", ")}` : ""}`);
  if (p.favorite) lines.push("The user starred THIS video as a favorite: keep what they love about it when editing.");
  if (p.constraints?.length) lines.push(`Creative constraints this video must honor: ${p.constraints.map((c, i) => `(${i + 1}) ${c}`).join(" ")}`);
  if (p.audio || !p.footage?.length) lines.push(p.audio ? `Voice uploaded: ${p.audio.name}. inspect's summary has its voice timeline (phrases, pauses, LONG pauses = scene changes) and captions carry word timings: time the beats to them.` : "Voice: not uploaded yet.");
  if (p.footage?.length) {
    const clips = p.footage.map((c) => `${c.id} "${c.name}" ${c.duration?.toFixed(0) ?? "?"}s${c.words ? "" : " (not transcribed yet)"}`).join(", ");
    lines.push(`Footage (the user's own clips, this video is an EDIT of them): ${clips}. Read get_footage, cut with edit_footage, then add graphics on top.`);
  }
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

const startProject = process.env.MOTIONILY_PROJECT;
if (!account) useVideo(startProject!, token);
else if (startProject) {
  await openVideo(startProject).catch((e: Error) => console.error(`[motionily] could not open project ${startProject}: ${e.message}`));
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
