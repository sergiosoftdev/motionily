import { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Types } from "mongoose";
import { TokenScope, type JwtPayload } from "../auth/auth";
import { ProjectsService } from "./projects.service";
import type { GenerateDto } from "./projects.dto";
import type { AgentRunUsage } from "./project.schema";

export enum GenerateStatus {
  Idle = "idle",
  Running = "running",
  Done = "done",
  Failed = "failed",
  Stopped = "stopped",
}

export enum GenerateEventKind {
  /** The agent called a Motionily tool. */
  Tool = "tool",
  /** The agent said something. */
  Text = "text",
  Error = "error",
}

export type GenerateEvent = { at: string; kind: GenerateEventKind; text: string };

type Run = { processes: Set<ChildProcess>; status: GenerateStatus; events: GenerateEvent[]; summary: string | null; usage: AgentRunUsage | null };

/** The fields of claude's final `result` line we care about. */
type ResultLine = {
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

export function usageFrom(r: ResultLine, kind: string, model: string | null, effort: string | null): AgentRunUsage {
  return {
    at: new Date().toISOString(),
    kind,
    model,
    effort,
    costUsd: r.total_cost_usd ?? 0,
    inputTokens: r.usage?.input_tokens ?? 0,
    outputTokens: r.usage?.output_tokens ?? 0,
    cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: r.usage?.cache_creation_input_tokens ?? 0,
    turns: r.num_turns ?? 0,
    durationMs: r.duration_ms ?? 0,
  };
}

const MAX_EVENTS = 200;
const MCP_SERVER = "motionily";
/** Beats built at the same time (each is its own claude process). */
const MAX_PARALLEL_BUILDERS = 4;
const MAX_BEATS = 6;

/** What makes motion graphics look professional instead of "a title and a box". Shared by every role. */
const CRAFT = `MOTION DESIGN CRAFT (non-negotiable):
- Density: 8-20 layers per beat. Build depth with 3 planes: background texture/shapes moving slowly, mid
  elements, foreground accents. The background is never a flat static color for a whole beat.
- Kinetic type: split headlines into one layer per word (or per line), stagger 0.05-0.12 s, entrances with
  overshoot (ease back), mask-like reveals (a shape that slides away), scale punches on the key word.
- Everything eases: no linear moves except loops. Pair motion: when something enters, something else reacts
  (secondary motion, a bounce, a ring that expands, lines that draw).
- Graphic language: lines that draw (thin rects scaling from 0), dots, rings, grids, arrows, counters, progress
  bars, UI cards, icons built from shapes. Repeat one motif across beats so the video feels designed.
- Transitions are designed, not cuts: full-frame color wipes, a shape that grows to fill the frame and becomes
  the next background, match cuts on shapes, zoom-through.
- Rhythm: something meaningful changes every 0.5-1.5 s. Hold the key message ~1 s to be read.
- Composition: strong grid, generous margins (≥ 8% of the frame), max 2 type sizes per beat + 1 small label.`;

/** Plans the video and sets the look; builders do the heavy writing in parallel. */
const PLANNER_GUIDE = `You are Motionily's art director. There are NO presets: everything is designed by the team.
Your job is ONLY to plan and set the global look, fast. Do NOT build layers.
1. get_project, get_brand (and view_image for any reference images). If a voice script or captions exist, the
   beats follow its paragraphs / word timings.
2. Decide an art direction (concept, palette, typography, motion language, recurring motif) for THIS brief.
3. Apply the global look with tools: set_palette op (apply_ops), set_font, set_duration op.
4. Answer with ONLY this JSON (no prose): {"direction":"…","motif":"…","beats":[{"group":"hook","start":0,"end":2.5,
   "brief":"what this beat shows, its layout, its motion, how it transitions out"}]} — 2 to ${MAX_BEATS} beats,
   contiguous, covering the duration, group names snake_case and unique.
${CRAFT}`;

const BUILDER_GUIDE = `You are one motion designer of a team building a video in Motionily, in parallel with others.
There are NO presets: write every animation as keyframes yourself. Work ONLY on your beat:
- Every layer you add has "group" set to your group and an id starting with your group name.
- Your layers live inside your time span (start/end), plus up to 0.4 s of overlap for the transition out.
- Never remove, edit or read other groups. Do not change palette, font, size or duration.
- Use ONE apply_ops call with all your layers when possible (fewer turns = faster), then one render_frames
  at 2 moments of your span; fix only if clearly broken. Do not run review_video.
${CRAFT}
Reply with one short sentence when done.`;

const FINISHER_GUIDE = `You are the finishing editor of a Motionily video built by a team in parallel.
1. review_video. 2. Fix only what is wrong (overlaps between beats, off-frame, dead air, broken transitions,
unreadable text) with small apply_ops. 3. Review again only if you changed a lot (max 2 rounds).
Finish with a 2-3 sentence summary in Spanish: the art direction and what the video shows.
${CRAFT}`;

/** How the agent should work when launched from the editor's Generate button. */
const AGENT_GUIDE = `You are Motionily's motion designer and art director. You build the WHOLE video through the motionily MCP tools.
There are NO presets in Motionily: no built-in animations, transitions, styles, templates or stock models.
You decide the concept, look, colors, typography and you write every animation yourself as keyframes,
exactly like a motion designer building a spot by hand. Avoid generic videos. Work like a senior motion designer:
1. get_project (brief), get_brand (product notes, brand palettes, logos, screenshots with descriptions), then
   get_reference once. If the brand has palettes, build from them; if not, choose your own palette for the concept.
   Show and explain the real product (view_asset to look at screenshots; image layers to show them).
   The VOICE-OVER drives the video: if there are captions (the user uploaded the voice), tie every beat, text
   and cut to the words' timings and make on-screen text mirror what is said. If there is only a voice script
   (get_project), time beats to its paragraphs (~2.3 words/s, "[long pause]" = scene change) and keep it.
2. Decide an art direction that fits THIS brief (one sentence: concept, visual metaphor, mood, pacing), then plan
   2-5 beats. One idea per beat, strong hierarchy, big legible type, deliberate composition.
3. Express that direction yourself: set_palette op with your own colors, a Google Font that fits (search_fonts +
   set_font), hand-written keyframes on every element (or your own define_anim keys reused across layers),
   your own cuts and wipes between beats.
   This is MOTION GRAPHICS first: build the video with 2D layers (kinetic type, shapes, color fields, masks made of
   shapes, product screenshots, icons drawn with shapes). Do NOT use the 3D stage unless the brief explicitly asks
   for 3D/characters in a scene or the user requests it. When 3D is asked for: list_prefabs first and reuse; otherwise
   design what the brief needs from primitives and save each piece with save_prefab so the user's library grows;
   place them with put_prop and give them behaviour with beats (go_to, sit_on, face, walk_to). People are ALWAYS
   stickman rigs. Move the camera with your own keyframes (set_camera) or set_shots for auto-framed moves.
   Put every layer in a named "group" (one per visual unit: hook, dashboard, cta…) so the user can edit pieces.
   MOTION IS THE PRODUCT: staggered entrances, emphasis on key words, characters always doing something, camera
   that moves with intent. Nothing should sit still for more than ~1.5 s.
4. SELF-REVIEW with review_video (contact sheet + automatic checks). Fix every reported issue and anything a
   motion designer would reject: cut or off-screen characters, overlapping or tiny text, dead air, flat camera,
   generic look. Use render_frames to zoom into a moment. Review again until it is clean (max 3 rounds).
   Never hand back a video you have not reviewed.
5. Check get_feedback at the end and apply it.
${CRAFT}
Finish with a 2-3 sentence summary in Spanish: the art direction you chose and what the video shows.`;

type Beat = { group: string; start: number; end: number; brief: string };
type Plan = { direction: string; motif?: string; beats: Beat[] };

/**
 * Runs Claude Code headless (`claude -p`) for a project, with the Motionily MCP
 * server preconfigured and scoped to that project. Uses the local Claude login;
 * a hosted version would swap this for the Agent SDK with an API key.
 *
 * A full build is a small team: a planner sets the look and splits the video into
 * beats, builders write each beat at the same time, and a finisher reviews the cut.
 * Requests on top of an existing video use a single agent.
 */
@Injectable()
export class GenerateService {
  private readonly logger = new Logger(GenerateService.name);
  private runs = new Map<string, Run>();

  constructor(
    private readonly projects: ProjectsService,
    private readonly jwt: JwtService,
  ) {}

  status(projectId: string) {
    const run = this.runs.get(projectId);
    return run
      ? { status: run.status, events: run.events, summary: run.summary, usage: run.usage }
      : { status: GenerateStatus.Idle, events: [], summary: null, usage: null };
  }

  async start(ownerId: Types.ObjectId, email: string, projectId: string, { instruction, model, effort, references }: GenerateDto) {
    const project = await this.projects.get(ownerId, projectId);
    if (this.runs.get(project.id)?.status === GenerateStatus.Running) {
      throw new ConflictException("the agent is already working on this project");
    }
    const payload: JwtPayload = { sub: ownerId.toString(), email, scope: TokenScope.Agent, projectId: project.id };
    const token = await this.jwt.signAsync(payload, { expiresIn: "2h" });
    const config = this.mcpConfig(project.id, token);

    const run: Run = { processes: new Set(), status: GenerateStatus.Running, events: [], summary: null, usage: null };
    this.runs.set(project.id, run);
    const refs = references?.length ? ` The user attached reference images; look at each with view_image first: ${references.join(", ")}.` : "";
    const opts = { config, model, effort };

    const work = instruction?.trim()
      ? this.single(run, `The user asks: "${instruction.trim()}". Apply it to the current video (read get_project and get_scene first; finish with review_video and fix what it shows).${refs}`, opts)
      : this.team(run, refs, opts);
    void work
      .then((usage) => {
        run.usage = usage;
        void this.projects.logAgentRun(project.id, usage);
        if (run.status === GenerateStatus.Running) run.status = GenerateStatus.Done;
      })
      .catch((e: Error) => {
        if (run.status !== GenerateStatus.Running) return;
        this.push(run, GenerateEventKind.Error, e.message);
        run.status = GenerateStatus.Failed;
      });
    this.logger.log(`agent started for project ${project.id}`);
    return this.status(project.id);
  }

  stop(projectId: string) {
    const run = this.runs.get(projectId);
    if (run?.status === GenerateStatus.Running) {
      run.status = GenerateStatus.Stopped;
      for (const p of run.processes) p.kill("SIGTERM");
    }
    return this.status(projectId);
  }

  private async single(run: Run, prompt: string, o: AgentOpts): Promise<AgentRunUsage> {
    const r = await this.agent(run, prompt, AGENT_GUIDE, o, "");
    run.summary = r.text;
    return usageFrom(r.result, "edit", o.model ?? null, o.effort ?? null);
  }

  /** Plan, build beats in parallel, finish. Wall time ≈ planner + slowest beat + finisher. */
  private async team(run: Run, refs: string, o: AgentOpts): Promise<AgentRunUsage> {
    const results: ResultLine[] = [];
    const t0 = Date.now();
    this.push(run, GenerateEventKind.Text, "Planificando la dirección de arte y los planos…");
    const planned = await this.agent(run, `Plan this video from its brief.${refs}`, PLANNER_GUIDE, o, "plan");
    results.push(planned.result);
    const plan = parsePlan(planned.text);
    this.push(run, GenerateEventKind.Text, `${plan.direction} — ${plan.beats.length} planos en paralelo: ${plan.beats.map((b) => b.group).join(", ")}`);

    const overview = plan.beats.map((b) => `- ${b.group} ${b.start}-${b.end}s: ${b.brief}`).join("\n");
    const queue = [...plan.beats];
    const worker = async () => {
      for (let beat = queue.shift(); beat && run.status === GenerateStatus.Running; beat = queue.shift()) {
        const prompt = `Art direction: ${plan.direction}\nRecurring motif: ${plan.motif ?? "—"}\nWhole video:\n${overview}\n\nYOUR BEAT: group "${beat.group}", ${beat.start}-${beat.end}s.\n${beat.brief}\nRead get_project once for palette/font/format, then build it.`;
        const r = await this.agent(run, prompt, BUILDER_GUIDE, o, beat.group).catch((e: Error) => {
          this.push(run, GenerateEventKind.Error, `${beat!.group}: ${e.message}`);
          return null;
        });
        if (r) results.push(r.result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_BUILDERS, plan.beats.length) }, worker));
    if (run.status !== GenerateStatus.Running) return sumUsage(results, t0, o);

    this.push(run, GenerateEventKind.Text, "Revisando el montaje completo…");
    const finished = await this.agent(run, "Review and polish the whole video.", FINISHER_GUIDE, o, "review");
    results.push(finished.result);
    run.summary = finished.text;
    return sumUsage(results, t0, o);
  }

  /** One claude process; events are tagged with its role so the UI can show who is doing what. */
  private agent(run: Run, prompt: string, guide: string, o: AgentOpts, role: string): Promise<{ text: string; result: ResultLine }> {
    // Fresh empty folder: the agent must not pick up any repo's CLAUDE.md or files.
    const cwd = mkdtempSync(join(tmpdir(), "motionily-agent-"));
    const child = spawn(
      process.env.CLAUDE_BIN ?? "claude",
      [
        "-p",
        prompt,
        "--append-system-prompt",
        guide,
        "--mcp-config",
        o.config,
        "--strict-mcp-config",
        "--allowedTools",
        `mcp__${MCP_SERVER}`,
        "--output-format",
        "stream-json",
        "--verbose",
        ...(o.model ? ["--model", o.model] : []),
        ...(o.effort ? ["--effort", o.effort] : []),
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    run.processes.add(child);
    const tag = role ? `[${role}] ` : "";
    return new Promise((resolvePromise, reject) => {
      let buffered = "";
      let final: (ResultLine & { result?: string }) | null = null;
      child.stdout!.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) final = this.onLine(line, run, tag) ?? final;
      });
      let stderr = "";
      child.stderr!.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)));
      child.on("error", (e) => reject(new Error(`No se pudo lanzar Claude Code: ${e.message}`)));
      child.on("close", (code) => {
        run.processes.delete(child);
        if (code === 0 && final) return resolvePromise({ text: final.result?.trim() ?? "", result: final });
        reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || `claude terminó con código ${code}`));
      });
    });
  }

  private mcpConfig(projectId: string, token: string) {
    const mcpDir = resolve(process.env.MOTIONILY_MCP_DIR ?? join(process.cwd(), "../../packages/mcp-server"));
    const dir = mkdtempSync(join(tmpdir(), "motionily-mcp-"));
    const config = join(dir, "mcp.json");
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          [MCP_SERVER]: {
            command: join(mcpDir, "node_modules/.bin/tsx"),
            args: [join(mcpDir, "src/index.ts")],
            env: { MOTIONILY_API: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3100}`, MOTIONILY_PROJECT: projectId, MOTIONILY_TOKEN: token },
          },
        },
      }),
    );
    return config;
  }

  private push(run: Run, kind: GenerateEventKind, text: string) {
    run.events.push({ at: new Date().toISOString(), kind, text });
    if (run.events.length > MAX_EVENTS) run.events.shift();
  }

  /** One stream-json line from claude: keep tool calls and text the user can follow. Returns the final result. */
  private onLine(line: string, run: Run, tag: string): (ResultLine & { result?: string }) | null {
    let msg: ResultLine & { type?: string; subtype?: string; result?: string; message?: { content?: { type: string; text?: string; name?: string }[] } };
    try {
      msg = JSON.parse(line);
    } catch {
      return null;
    }
    if (msg.type === "assistant") {
      for (const c of msg.message?.content ?? []) {
        if (c.type === "tool_use" && c.name) this.push(run, GenerateEventKind.Tool, `${tag}${c.name.replace(`mcp__${MCP_SERVER}__`, "")}`);
        if (c.type === "text" && c.text?.trim() && !tag.startsWith("[plan")) this.push(run, GenerateEventKind.Text, `${tag}${c.text.trim()}`);
      }
    }
    if (msg.type === "result") {
      if (msg.subtype && msg.subtype !== "success") this.push(run, GenerateEventKind.Error, `${tag}${msg.subtype}`);
      return msg;
    }
    return null;
  }
}

type AgentOpts = { config: string; model?: string; effort?: string };

function parsePlan(text: string): Plan {
  try {
    const plan = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Plan;
    const beats = (plan.beats ?? []).filter((b) => b.group && b.end > b.start).slice(0, MAX_BEATS);
    if (!beats.length) throw new Error("no beats");
    return { direction: plan.direction ?? "", motif: plan.motif, beats };
  } catch {
    throw new Error("El planificador no devolvió un plan válido; vuelve a intentarlo.");
  }
}

/** One usage row for the whole team (wall time, not the sum of each agent's time). */
function sumUsage(results: ResultLine[], t0: number, o: AgentOpts): AgentRunUsage {
  const total: ResultLine = { total_cost_usd: 0, num_turns: 0, duration_ms: Date.now() - t0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  for (const r of results) {
    total.total_cost_usd! += r.total_cost_usd ?? 0;
    total.num_turns! += r.num_turns ?? 0;
    const u = total.usage!;
    u.input_tokens! += r.usage?.input_tokens ?? 0;
    u.output_tokens! += r.usage?.output_tokens ?? 0;
    u.cache_read_input_tokens! += r.usage?.cache_read_input_tokens ?? 0;
    u.cache_creation_input_tokens! += r.usage?.cache_creation_input_tokens ?? 0;
  }
  return usageFrom(total, "generate", o.model ?? null, o.effort ?? null);
}
