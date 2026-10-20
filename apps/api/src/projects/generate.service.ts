import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConflictException, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Types } from "mongoose";
import { TokenScope, type JwtPayload } from "../auth/auth";
import { ProjectsService } from "./projects.service";
import { AgentEffort, AgentModel, GenerateMode, type GenerateDto } from "./projects.dto";
import { VideoFormat, type AgentRunUsage } from "./project.schema";
import { filmNotes } from "../references/film";

export enum GenerateStatus {
  Idle = "idle",
  Running = "running",
  Done = "done",
  Failed = "failed",
  Stopped = "stopped",
  /** The API restarted mid-run; its agents were stopped. */
  Interrupted = "interrupted",
}

export enum GenerateEventKind {
  /** The agent called a Motionily tool. */
  Tool = "tool",
  /** The agent said something. */
  Text = "text",
  Error = "error",
  /** Team phase started: text is a GeneratePhase. */
  Phase = "phase",
  /** The plan: text is JSON [{group,start,end}]. */
  Plan = "plan",
  /** A role finished: text is the role (beat group, "plan" or "review"). */
  Done = "done",
}

export enum GeneratePhase {
  Plan = "plan",
  Build = "build",
  Review = "review",
}

export type GenerateEvent = { at: string; kind: GenerateEventKind; text: string };

type Run = { projectId?: string; processes: Set<ChildProcess>; status: GenerateStatus; events: GenerateEvent[]; summary: string | null; usage: AgentRunUsage | null };

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

/** Agent docs shared with the MCP server's manual (docs/agent): one source for every prompt. */
const DOCS_DIR = resolve(process.env.MOTIONILY_DOCS_DIR ?? join(process.cwd(), "../../docs/agent"));
const doc = (name: string) => readFileSync(join(DOCS_DIR, name), "utf8").trim();

/** What makes motion graphics look professional instead of "a title and a box". Shared by every role. */
const CRAFT = doc("craft.md");

/**
 * What professional 2D motion graphics (SaaS launch films, product promos on Pinterest/Dribbble)
 * look like, distilled from reference videos the team collected. The planner picks a family per
 * brief (or blends two); builders execute it with the recipes.
 */
const MOTION_2D = doc("motion-2d.md");

/** Mirrors FORMAT_SIZE in @motionily/protocol. */
const FORMAT_SIZE: Record<VideoFormat, [number, number]> = {
  [VideoFormat.Vertical]: [1080, 1920],
  [VideoFormat.Horizontal]: [1920, 1080],
  [VideoFormat.Square]: [1080, 1080],
  [VideoFormat.Portrait]: [1080, 1350],
};

/** Everything a builder needs to write layers, inline (no get_reference round trip), with the exact camera math. */
const COMPACT_REF = doc("syntax.md");
/** Workflow, tools, ops and 3D: the rest of the manual the MCP server hands to outside agents. */
const MANUAL = doc("manual.md");
/** Agents that guess instead of reading burn minutes on test layers; say it in every role. */
const NO_PROBING = `Never test how the engine behaves (no debug rectangles, no trial renders to see what z, rx or the camera do): the
rules below are exact. To know where something lands on screen, get_layout returns the boxes as numbers.`;

/** MCP tools each role sees (each tool description costs context on every turn). */
const ROLE_TOOLS = {
  planner: ["get_project", "get_brand", "view_image", "view_asset", "search_fonts", "set_font", "apply_ops", "add_layers", "search_images", "import_image", "define_component", "get_component"],
  builder: ["add_layers", "apply_ops", "get_layout", "render_frames", "view_asset", "view_image", "get_brand", "find_icons", "define_component", "get_component"],
  finisher: ["review_video", "get_layout", "render_frames", "get_group", "add_layers", "apply_ops", "list_sounds", "add_sfx", "get_component"],
} as const;

/** Plans the video and sets the look; builders do the heavy writing in parallel. */
const PLANNER_GUIDE = `You are Motionily's art director. There are NO presets: everything is designed by the team.
Your job is ONLY to plan, set the global look and lay out the WORLD, fast. Do not build the beats' content.
0. This is a NEW video from scratch: your very first call is apply_ops [{"op":"clear_layers"}] (drops any old cut).
1. get_project, get_brand (and view_image for any reference images). If a voice script or captions exist, the
   beats follow its paragraphs / word timings.
2. Decide an art direction (concept, palette with hex codes following COLOR below, typography, motion language,
   recurring motif) for THIS brief. Unique palette: never the generic violet/magenta/cyan AI look.
2b. REAL PHOTOS: if the brief asks for real images or its subject is real (history, events, places, people, nature,
   documentary), ONE search_images call with all queries (one per subject, English, specific: names, places, years;
   at most one more call for empty subjects), pick by looking at the
   thumbnails (sharp, on topic, fits the format) and import_image the chosen ones in ONE call (one or two per beat).
   Write each photo's src and how to show it (slow push/pan, grade, what text sits on it) into the beat's brief:
   builders only know the photos you hand them. Brand/product videos use get_brand images instead.
3. Apply the global look with tools: set_palette op (apply_ops), set_font, set_duration op.
4. WORLD FIRST: the video is ONE continuous space the camera travels through (like the reference films), not
   slides. With ONE add_layers call create the global layers (group "world"): the background (fixed=1 for
   screen-pinned backgrounds, or big world planes with z for parallax) and the camera "cam" (a vis=0 layer with
   cam=FOCAL[,FOCUS,APERTURE]) keyed for the WHOLE video: x/y = where it looks, z = dolly, s = zoom; eased moves
   between beat regions (eio), slow drift while a beat plays. Give each beat its own region of the world (x/y
   center, depth z, optional tilt rx/ry) that the camera visits on time.
5. If there is a REFERENCE FILM: first write a shot-by-shot breakdown from its sheets and timing (what is on
   screen, layout, camera move, transition, duration of each shot) and mirror its rhythm and techniques.
6. Answer with ONLY this JSON (no prose): {"direction":"…","motif":"…","reference":"shot-by-shot breakdown, or empty",
   "beats":[{"group":"hook","start":0,"end":2.5,"region":"x=960 y=540 z=0 (rx=…)","brief":"what this beat shows,
   its layout, its motion, how it hands over to the next"}]} — 2 to ${MAX_BEATS} beats, contiguous, covering the
   duration, group names snake_case and unique.
${CRAFT}
${MOTION_2D}`;

const BUILDER_GUIDE = `You are one motion designer of a team building a video in Motionily, in parallel with others.
There are NO presets: write every animation as keyframes yourself. Work ONLY on your beat:
- Every layer you add has "group" set to your group and an id starting with your group name.
- Your layers live inside your time span (start/end), plus up to 0.4 s of overlap for the transition out.
- Never remove, edit or read other groups. Do not change palette, font, size or duration.
- The camera ("cam") and the world background exist already: never add a camera. Build your beat in YOUR region
  of the world (its x/y center and depth z): the camera arrives there on time. Use z for depth inside your beat
  (foreground pieces at z<0, far ones z>0) so the camera move gives real parallax.
- Write ALL your layers in ONE add_layers call (fewer turns = cheaper and faster), then ONE get_layout and ONE
  render_frames at 2 moments of your span; fix only what is clearly broken with one more add_layers. Do not run review_video.
${NO_PROBING}
- Product screenshots/logos: get_brand lists them; use their src in image layers.
${COMPACT_REF}
${CRAFT}
${MOTION_2D}
Reply with one short sentence when done.`;

const FINISHER_GUIDE = `You are the finishing editor of a Motionily video built by a team in parallel.
1. review_video. If there is a reference film, put your sheet next to its sheets (view_image) and name the 3
biggest gaps (palette, density, camera, transitions, rhythm); fix them first. 2. Fix only what is wrong (overlaps between beats, off-frame, dead air, broken transitions,
unreadable text): get_group to read a group as compact lines, get_layout for exact screen boxes, add_layers to fix.
${NO_PROBING} 3. Review again only if you
changed a lot (max 2 rounds).
4. SOUND DESIGN: list_sounds, then ONE add_sfx call with a cue on every key motion moment of the timings below
   (whoosh on transitions, pop on entrances, impact on hero text, ticks on counters, riser before the reveal,
   chime on the payoff). If the library is empty, skip this.
${COMPACT_REF}
Finish with a 2-3 sentence summary in Spanish: the art direction and what the video shows.
${CRAFT}`;

/**
 * Premium builds the film beat by beat: the user watches it grow, each turn stays short (no
 * minutes of silent planning of the whole film) and a cut-off run keeps what it built.
 */
const SOLO_STEPS = `Build it STEP BY STEP, as ONE continuous world the camera travels through:
1. Gather: get_project, get_brand, references and photos. Decide the direction and the beat list briefly; do not
   compose every beat in your head now.
2. Write ONE short line of plain text in Spanish: the art direction. Then apply_ops (palette, duration), set_font and
   ONE add_layers with ONLY the world: the background and the camera "cam" keyed for the whole film, visiting one
   region per beat.
3. Then each beat IN ORDER: first a plain-text line "Escena N: <what it shows>" (the user sees it), then ONE add_layers
   with only that beat's layers (its own group), then get_layout at its key instants and fix what is off. Never put
   two beats in one add_layers, and do not design the next beat until this one is on screen.
4. When every beat is in: review_video, fix, review again until clean (max 3 rounds).`;

/** How the agent should work when launched from the editor's Generate button. */
const AGENT_GUIDE = `You are Motionily's motion designer and art director. You build the WHOLE video through the motionily MCP tools.
There are NO presets in Motionily: no built-in animations, transitions, styles, templates or stock models.
You decide the concept, look, colors, typography and you write every animation yourself as keyframes,
exactly like a motion designer building a spot by hand. Avoid generic videos. Work like a senior motion designer:
1. get_project (brief) and get_brand (product notes, brand palettes, logos, screenshots with descriptions) in
   parallel. The manual is below: no get_reference. If the brand has palettes, build from them; if not, choose your own
   palette for the concept.
   Show and explain the real product (view_asset to look at screenshots; image layers to show them).
   The VOICE-OVER drives the video: if there are captions (the user uploaded the voice), tie every beat, text
   and cut to the words' timings and make on-screen text mirror what is said. If there is only a voice script
   (get_project), time beats to its paragraphs (~2.3 words/s, "[long pause]" = scene change) and keep it.
2. Lay out the WORLD first: one camera layer ("cam", cam=…) keyed for the whole film and a region (x/y, depth z)
   per beat that the camera travels to; the film is one continuous space, not slides.
   Decide an art direction that fits THIS brief (one sentence: concept, visual metaphor, mood, pacing), then plan
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
${NO_PROBING}
${CRAFT}
${MOTION_2D}
Prefer add_layers (compact lines) over JSON for writing layers. Sound: list_sounds + add_sfx to sync effects to the motion.
${MANUAL}
${COMPACT_REF}
Finish with a 2-3 sentence summary in Spanish: the art direction you chose and what the video shows.`;

type RoleModel = { model: AgentModel; effort: AgentEffort };
type TeamSetup = {
  plan: RoleModel;
  build: RoleModel;
  review: RoleModel;
  reviewRounds: number;
  /** One designer owns the whole video (no split into parallel beats): best continuity. */
  solo?: boolean;
};

/**
 * Who does what in each mode. Premium is all Opus thinking hard (best motion design, slowest and
 * priciest); Economy is Sonnet executing a Sonnet plan.
 */
const TEAM: Record<Exclude<GenerateMode, GenerateMode.Custom>, TeamSetup> = {
  [GenerateMode.Premium]: {
    plan: { model: AgentModel.Opus, effort: AgentEffort.High },
    build: { model: AgentModel.Opus, effort: AgentEffort.High },
    review: { model: AgentModel.Opus, effort: AgentEffort.Medium },
    reviewRounds: 3,
    solo: true,
  },
  [GenerateMode.Balanced]: {
    plan: { model: AgentModel.Opus, effort: AgentEffort.Medium },
    build: { model: AgentModel.Sonnet, effort: AgentEffort.Medium },
    review: { model: AgentModel.Sonnet, effort: AgentEffort.Medium },
    reviewRounds: 2,
  },
  [GenerateMode.Economy]: {
    plan: { model: AgentModel.Sonnet, effort: AgentEffort.Medium },
    build: { model: AgentModel.Sonnet, effort: AgentEffort.Low },
    review: { model: AgentModel.Sonnet, effort: AgentEffort.Low },
    reviewRounds: 1,
  },
};

function teamFor(mode: GenerateMode | undefined, model?: AgentModel, effort?: AgentEffort): TeamSetup {
  if (mode && mode !== GenerateMode.Custom) return TEAM[mode];
  const m = model ?? AgentModel.Sonnet;
  const e = effort ?? AgentEffort.Medium;
  return { plan: { model: m, effort: e }, build: { model: m, effort: e }, review: { model: m, effort: e }, reviewRounds: 2 };
}

type Beat = { group: string; start: number; end: number; brief: string; region?: string };
type Plan = { direction: string; motif?: string; reference?: string; beats: Beat[] };

/**
 * Runs Claude Code headless (`claude -p`) for a project, with the Motionily MCP
 * server preconfigured and scoped to that project. Uses the local Claude login;
 * a hosted version would swap this for the Agent SDK with an API key.
 *
 * A full build is a small team: a planner sets the look and splits the video into
 * beats, builders write each beat at the same time, and a finisher reviews the cut.
 * Requests on top of an existing video use a single agent.
 */
/** Is this pid a live claude process (and not some unrelated process that reused the pid)? */
function isClaude(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="]).toString().includes("claude");
  } catch {
    return false;
  }
}

@Injectable()
export class GenerateService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(GenerateService.name);
  private runs = new Map<string, Run>();

  constructor(
    private readonly projects: ProjectsService,
    private readonly jwt: JwtService,
  ) {}

  /** After a restart: agents a previous API process left behind are stopped and their runs marked interrupted. */
  async onModuleInit() {
    for (const p of await this.projects.liveRuns()) {
      const pids = p.liveRun?.pids ?? [];
      for (const pid of pids) if (isClaude(pid)) process.kill(pid, "SIGKILL");
      // A run that logged its result after it started actually finished: just clear the marker.
      const startedAt = p.liveRun?.startedAt ?? "";
      if (!pids.length && (p.agentRuns ?? []).some((r) => r.at >= startedAt)) {
        await this.projects.setLiveRun(String(p._id), null);
        continue;
      }
      await this.projects.setLiveRun(String(p._id), { status: GenerateStatus.Interrupted, startedAt: p.liveRun!.startedAt, pids: [] });
      this.logger.warn(`run on ${String(p._id)} interrupted by a restart (${pids.length} agents stopped)`);
    }
  }

  /** Hot reload / shutdown: never leave claude processes burning tokens with nobody tracking them. */
  async onApplicationShutdown() {
    for (const [projectId, run] of this.runs) {
      if (run.status !== GenerateStatus.Running) continue;
      run.status = GenerateStatus.Interrupted;
      // Keep the pids: if the kill doesn't land before we exit, the next boot finishes the job.
      const pids = [...run.processes].flatMap((p) => (p.pid ? [p.pid] : []));
      for (const p of run.processes) p.kill("SIGKILL");
      await this.projects.setLiveRun(projectId, { status: GenerateStatus.Interrupted, startedAt: new Date().toISOString(), pids }).catch(() => undefined);
    }
  }

  isRunning(projectId: string) {
    return this.runs.get(projectId)?.status === GenerateStatus.Running;
  }

  status(projectId: string) {
    const run = this.runs.get(projectId);
    return run
      ? { status: run.status, events: run.events, summary: run.summary, usage: run.usage }
      : { status: GenerateStatus.Idle, events: [], summary: null, usage: null };
  }

  /** Status including runs this API process doesn't hold in memory (e.g. interrupted by a restart). */
  async statusOf(projectId: string) {
    if (this.runs.has(projectId)) return this.status(projectId);
    const live = await this.projects.liveRunOf(projectId);
    if (live?.status === GenerateStatus.Interrupted) return { status: GenerateStatus.Interrupted, events: [], summary: null, usage: null };
    return this.status(projectId);
  }

  async start(ownerId: Types.ObjectId, email: string, projectId: string, { instruction, model, effort, references, mode }: GenerateDto) {
    const project = await this.projects.get(ownerId, projectId);
    if (this.runs.get(project.id)?.status === GenerateStatus.Running) {
      throw new ConflictException("the agent is already working on this project");
    }
    // A team started by another API process (before a restart) may still be alive: never run two.
    const live = await this.projects.liveRunOf(project.id);
    if (live?.status === GenerateStatus.Running && live.pids.some(isClaude)) {
      throw new ConflictException("the agent is already working on this project");
    }
    const payload: JwtPayload = { sub: ownerId.toString(), email, scope: TokenScope.Agent, projectId: project.id };
    const token = await this.jwt.signAsync(payload, { expiresIn: "2h" });
    const config = (tools?: readonly string[]) => this.mcpConfig(project.id, token, tools);

    const run: Run = { processes: new Set(), status: GenerateStatus.Running, events: [], summary: null, usage: null };
    this.runs.set(project.id, run);
    await this.projects.setLiveRun(project.id, { status: GenerateStatus.Running, startedAt: new Date().toISOString(), pids: [] });
    run.projectId = project.id;
    const refs = await referencePrompt([...new Set([...(project.references ?? []), ...(references ?? [])])]);
    const opts: AgentOpts = { config, model, effort, size: FORMAT_SIZE[project.format] ?? FORMAT_SIZE[VideoFormat.Vertical] };

    // Callers without a mode (prefab workshop, older clients) keep their explicit model/effort.
    mode ??= model ? GenerateMode.Custom : GenerateMode.Balanced;
    const work = instruction?.trim()
      ? this.single(run, `The user asks: "${instruction.trim()}". Apply it to the current video (read get_project and get_scene first; finish with review_video and fix what it shows).${refs}`, { ...opts, ...teamFor(mode, model, effort).build })
      : this.team(run, refs, opts, teamFor(mode, model, effort), mode);
    void work
      .then(async (usage) => {
        run.usage = usage;
        if (run.status === GenerateStatus.Running) run.status = GenerateStatus.Done;
        // In order: the finished run is on record before the live marker goes.
        await this.projects.logAgentRun(project.id, usage);
        await this.projects.setLiveRun(project.id, null);
      })
      .catch((e: Error) => {
        if (run.status !== GenerateStatus.Running) return;
        this.push(run, GenerateEventKind.Error, e.message);
        run.status = GenerateStatus.Failed;
        void this.projects.setLiveRun(project.id, null);
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
    void this.projects.setLiveRun(projectId, null);
    return this.status(projectId);
  }

  private async single(run: Run, prompt: string, o: AgentOpts): Promise<AgentRunUsage> {
    const r = await this.agent(run, prompt, AGENT_GUIDE, o, "", undefined);
    run.summary = r.text;
    return usageFrom(r.result, "edit", o.model ?? null, o.effort ?? null);
  }

  /** Plan, build beats in parallel, finish. Wall time ≈ planner + slowest beat + finisher. */
  private async team(run: Run, refs: string, base: AgentOpts, team: TeamSetup, mode: GenerateMode): Promise<AgentRunUsage> {
    // The cost log names the mode rather than one model (each role may run a different one).
    const label: AgentOpts = { ...base, model: `modo ${mode}`, effort: undefined };
    const o: AgentOpts = { ...base, ...team.plan };
    const results: ResultLine[] = [];
    const t0 = Date.now();
    if (team.solo) return this.solo(run, refs, base, team, label, t0);
    this.push(run, GenerateEventKind.Phase, GeneratePhase.Plan);
    const planned = await this.agent(run, `Plan this video from its brief.${refs}`, PLANNER_GUIDE, o, "plan", ROLE_TOOLS.planner);
    results.push(planned.result);
    const plan = parsePlan(planned.text);
    this.push(run, GenerateEventKind.Text, plan.direction);
    this.push(run, GenerateEventKind.Plan, JSON.stringify(plan.beats.map(({ group, start, end }) => ({ group, start, end }))));
    this.push(run, GenerateEventKind.Phase, GeneratePhase.Build);

    // The plan already did the thinking: builders and finisher execute it with low effort (thinking is output tokens).
    const crew: AgentOpts = { ...base, ...team.build };
    const overview = plan.beats.map((b) => `- ${b.group} ${b.start}-${b.end}s: ${b.brief}`).join("\n");
    const queue = [...plan.beats];
    const worker = async () => {
      for (let beat = queue.shift(); beat && run.status === GenerateStatus.Running; beat = queue.shift()) {
        const reference = plan.reference ? `\nReference breakdown (match its techniques and rhythm):\n${plan.reference}` : "";
        const prompt = `Art direction: ${plan.direction}\nRecurring motif: ${plan.motif ?? "—"}${reference}\nWhole video:\n${overview}\n\nYOUR BEAT: group "${beat.group}", ${beat.start}-${beat.end}s, world region ${beat.region ?? "centered"}.\n${beat.brief}\nCanvas ${o.size[0]}x${o.size[1]} px. Palette and font are already set (use the slot names). Build it now.`;
        const r = await this.agent(run, prompt, BUILDER_GUIDE, crew, beat.group, ROLE_TOOLS.builder).catch((e: Error) => {
          this.push(run, GenerateEventKind.Error, `${beat!.group}: ${e.message}`);
          return null;
        });
        if (r) results.push(r.result);
        this.push(run, GenerateEventKind.Done, beat.group);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_BUILDERS, plan.beats.length) }, worker));
    if (run.status !== GenerateStatus.Running) return sumUsage(results, t0, label);

    this.push(run, GenerateEventKind.Phase, GeneratePhase.Review);
    const finished = await this.agent(run, `Review and polish the whole video. Canvas ${o.size[0]}x${o.size[1]} px. Groups: ${plan.beats.map((b) => `${b.group} ${b.start}-${b.end}s`).join(", ")}.${refs}`, FINISHER_GUIDE.replace("(max 2 rounds)", `(max ${team.reviewRounds} rounds)`), { ...base, ...team.review }, "review", ROLE_TOOLS.finisher);
    results.push(finished.result);
    run.summary = finished.text;
    return sumUsage(results, t0, label);
  }

  /** Premium: one designer builds the whole film as one continuous world, then a reviewer polishes it. */
  private async solo(run: Run, refs: string, base: AgentOpts, team: TeamSetup, label: AgentOpts, t0: number): Promise<AgentRunUsage> {
    const results: ResultLine[] = [];
    this.push(run, GenerateEventKind.Phase, GeneratePhase.Build);
    const designer = await this.agent(
      run,
      `This is a NEW video from scratch: first call apply_ops [{"op":"clear_layers"}] to drop any old cut. Canvas ${base.size[0]}x${base.size[1]} px.${refs}\n${SOLO_STEPS}`,
      AGENT_GUIDE,
      { ...base, ...team.build },
      "design",
      undefined,
    );
    results.push(designer.result);
    if (run.status !== GenerateStatus.Running) return sumUsage(results, t0, label);
    this.push(run, GenerateEventKind.Phase, GeneratePhase.Review);
    const finished = await this.agent(
      run,
      `Review and polish the whole video. Canvas ${base.size[0]}x${base.size[1]} px.${refs}`,
      FINISHER_GUIDE.replace("(max 2 rounds)", `(max ${team.reviewRounds} rounds)`),
      { ...base, ...team.review },
      "review",
      ROLE_TOOLS.finisher,
    );
    results.push(finished.result);
    run.summary = finished.text;
    return sumUsage(results, t0, label);
  }

  /** One claude process; events are tagged with its role so the UI can show who is doing what. */
  private agent(run: Run, prompt: string, guide: string, o: AgentOpts, role: string, tools: readonly string[] | undefined): Promise<{ text: string; result: ResultLine }> {
    // Fresh empty folder: the agent must not pick up any repo's CLAUDE.md or files.
    const cwd = mkdtempSync(join(tmpdir(), "motionily-agent-"));
    const child = spawn(
      process.env.CLAUDE_BIN ?? "claude",
      [
        "-p",
        prompt,
        // Our own lean system prompt and no built-in tools: ~5k tokens of base context instead of ~27k, on every turn.
        "--system-prompt",
        guide,
        "--tools",
        "",
        "--mcp-config",
        o.config(tools),
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
    if (child.pid && run.projectId) void this.projects.trackPid(run.projectId, child.pid, true);
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
        if (child.pid && run.projectId) void this.projects.trackPid(run.projectId, child.pid, false);
        if (code === 0 && final) return resolvePromise({ text: final.result?.trim() ?? "", result: final });
        reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || `claude terminó con código ${code}`));
      });
    });
  }

  private mcpConfig(projectId: string, token: string, tools?: readonly string[]) {
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
            env: { MOTIONILY_API: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3100}`, MOTIONILY_PROJECT: projectId, MOTIONILY_TOKEN: token, MOTIONILY_MANUAL: "0", ...(tools ? { MOTIONILY_TOOLS: tools.join(",") } : {}) },
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

type AgentOpts = { config: (tools?: readonly string[]) => string; model?: string; effort?: string; size: [number, number] };

function parsePlan(text: string): Plan {
  try {
    const plan = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Plan;
    const beats = (plan.beats ?? []).filter((b) => b.group && b.end > b.start).slice(0, MAX_BEATS);
    if (!beats.length) throw new Error("no beats");
    return { direction: plan.direction ?? "", motif: plan.motif, reference: plan.reference, beats };
  } catch {
    throw new Error("El planificador no devolvió un plan válido; vuelve a intentarlo.");
  }
}

/** What the agents are told about the user's references (images, and films cut into sheets + timing). */
async function referencePrompt(paths: string[]): Promise<string> {
  if (!paths.length) return "";
  const films = (await Promise.all(paths.map(filmNotes))).filter((n): n is string => !!n);
  const unique = [...new Set(films)];
  const film = unique.length
    ? ` REFERENCE FILM(S) — the quality bar: match their palette, density, camera language, transitions and shot rhythm. ${unique.join(" ")}`
    : "";
  return ` The user attached references; look at each with view_image first: ${paths.join(", ")}.${film}`;
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
