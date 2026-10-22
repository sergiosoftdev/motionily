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
  Sound = "sound",
}

export type GenerateEvent = { at: string; kind: GenerateEventKind; text: string };

/** A phrase of the voice-over with its timing: what the video must show while it is said. */
type VoiceLine = { start: number; end: number; text: string };

type Run = { voice?: VoiceLine[]; projectId?: string; processes: Set<ChildProcess>; status: GenerateStatus; events: GenerateEvent[]; summary: string | null; usage: AgentRunUsage | null };

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
  planner: [
    "get_project",
    "get_brand",
    "view_image",
    "view_asset",
    "search_fonts",
    "set_font",
    "apply_ops",
    "add_layers",
    "search_assets",
    "import_assets",
    "cut_out",
    "list_library",
    "generate_image",
    "set_direction",
    "examples",
    "define_component",
    "get_component",
  ],
  builder: ["run", "add_layers", "edit_layers", "apply_ops", "get_layout", "render_frames", "view_asset", "view_image", "get_brand", "find_icons", "add_vector", "add_map", "cut_out", "define_component", "get_component"],
  finisher: ["run", "get_feedback", "edit_layers", "review_video", "get_layout", "render_frames", "inspect", "add_layers", "apply_ops", "list_sounds", "make_sound", "add_sfx", "get_component", "set_font", "search_fonts"],
  sound: ["get_project", "list_sounds", "make_sound", "add_sfx"],
} as const;

/** The timed voice-over, phrase by phrase (the engine's own phrasing: a pause or 12 words starts a new line). */
function voiceLines(scene: unknown): VoiceLine[] {
  const words = (scene as { captions?: { words?: { text: string; start: number; end: number }[] } } | null)?.captions?.words ?? [];
  const lines: VoiceLine[] = [];
  for (const w of words) {
    const cur = lines.at(-1);
    if (cur && w.start - cur.end <= 0.6 && cur.text.split(" ").length < 12) {
      cur.text += ` ${w.text}`;
      cur.end = w.end;
    } else {
      lines.push({ start: w.start, end: w.end, text: w.text });
    }
  }
  return lines;
}

function voiceDuring(lines: VoiceLine[], from: number, to: number): string {
  return lines
    .filter((l) => l.end >= from && l.start <= to)
    .map((l) => `${l.start.toFixed(1)}-${l.end.toFixed(1)}s "${l.text}"`)
    .join("\n");
}

/** What the voice says during this beat, so the builder shows it. */
function voiceFor(run: Run, beat: Beat): string {
  const said = voiceDuring(run.voice ?? [], beat.start, beat.end);
  return said ? `\nThe voice-over says during this beat (show these words on screen, in order):\n${said}` : "";
}

/** Interrupted run without a saved plan: finish whatever is missing on the cut already on screen. */
const CONTINUE_PROMPT = `The previous run of this video was interrupted. Continue it: read get_project and inspect, see which beats are
already on screen, build only the missing ones (never clear what exists), then finish with review_video and fix what it shows.`;

/** What happens at a moment of the cut. */
const MomentKind = { Enter: "enter", Exit: "exit", Animation: "animation", Voice: "voice", Emphasis: "emphasis" } as const;
type MomentKind = (typeof MomentKind)[keyof typeof MomentKind];

/** A moment of the cut where a sound can land: a layer enters or leaves, an animation starts, a phrase or an emphasis word. */
type Moment = { at: number; kind: MomentKind; what: string };

/** Layer `type` of video clips (the user's footage) in the scene JSON. */
const VIDEO_LAYER = "video";

/** A cue the team already placed covers the moments this close to it. */
const CUE_COVERS_S = 0.4;

/**
 * The moments the sound pass places sounds on, read from the scene (the agent can't infer them from the brief).
 * Moments next to a cue the team already placed are left out, so the pass fills gaps instead of doubling sounds.
 */
function sceneMoments(scene: Record<string, unknown> | null): { moments: Moment[]; placed: number } {
  const s = scene as {
    duration?: number;
    layers?: { id: string; type?: string; start?: number; end?: number | null; anims?: { use: string; at?: number }[] }[];
    captions?: { words?: { text: string; start: number; end: number; emphasis?: boolean }[] };
    sfx?: { at: number }[];
  } | null;
  const duration = s?.duration ?? 0;
  const moments: Moment[] = [];
  for (const l of s?.layers ?? []) {
    // The user's footage: each cut is a layer, and a sound on every jump cut would be noise.
    if (l.type === VIDEO_LAYER) continue;
    const start = l.start ?? 0;
    if (start > 0.05) moments.push({ at: start, kind: MomentKind.Enter, what: l.id });
    if (l.end != null && l.end < duration - 0.1) moments.push({ at: l.end, kind: MomentKind.Exit, what: l.id });
    for (const a of l.anims ?? []) moments.push({ at: start + (a.at ?? 0), kind: MomentKind.Animation, what: `${l.id} ${a.use}` });
  }
  const words = s?.captions?.words ?? [];
  words.forEach((w, i) => {
    if (i === 0 || w.start - (words[i - 1]?.end ?? 0) > 0.6) moments.push({ at: w.start, kind: MomentKind.Voice, what: w.text });
    if (w.emphasis) moments.push({ at: w.start, kind: MomentKind.Emphasis, what: w.text });
  });
  const cues = (s?.sfx ?? []).map((c) => c.at);
  // Sorted, and never two moments closer than 0.25 s: one sound per beat of the picture, not a stream.
  moments.sort((a, b) => a.at - b.at);
  const kept: Moment[] = [];
  for (const m of moments) {
    if (cues.some((at) => Math.abs(at - m.at) < CUE_COVERS_S)) continue;
    if (!kept.length || m.at - kept[kept.length - 1]!.at >= 0.25) kept.push(m);
  }
  return { moments: kept.slice(0, 60), placed: cues.length };
}

/** Last pass after the cut is built: sound effects always land on the timeline, whatever the builders did. */
const SOUND_GUIDE = `You are Motionily's sound designer. The video is already built. You get its moments (exact times
where something happens on screen or in the voice) and its brief, which sets the tone. Choose at most one sound per
moment and place it there.
1. list_sounds for the user's library. Then design this video's OWN sounds with make_sound: 2-4 that give it a
   signature (its main transition whoosh, its reveal impact, a chime or riser in its tone), named after the video
   and the moment; design every sound you need when the library is empty. Use library sounds for the rest.
2. Match the tone of the brief first.
   - Upbeat, product or playful videos: enter → pop or whoosh_fast · animation → whoosh (start it ~0.1 s before the
     moment) · exit → click or tick · voice → tick, very quiet · emphasis → impact or hit_dry, a little louder.
   - Serious, documentary, historical or emotional videos: never pops, dings or other cheerful sounds. Soft whooshes
     on moves, ticks and dry hits on entrances, low booms only on the heaviest moments; leaving a moment silent is fine.
3. Skip moments that do not need sound. Gains 0.3-0.6 under a voice, up to 0.8 without one. Never two cues in the
   same 0.25 s.
3b. Vertical or square videos follow the attention sawtooth: a riser or whoosh leading into each beat change and
   reveal, an impact on the reveals, and leave the half second before the final reveal silent so it lands harder.
4. Cues the team already placed stay: never remove or move them. Your ids start with "snd_" so they never replace one.
5. ONE add_sfx with one line per cue: "id sound_name at [gain]", at = the moment's time. Change nothing else.
Reply with one short sentence: how many cues and why you skipped the rest.`;

/** A video made from the user's own clips: cut them by their transcript, then add graphics on top. */
const FOOTAGE_GUIDE = `You are Motionily's video editor. The user uploaded their own footage (usually someone talking to camera)
and wants a tight, engaging short video from it, with motion graphics on top. You edit through the motionily MCP tools.
1. get_project (the brief says what the user wants: length, tone, audience) and get_footage (each clip's transcript in
   numbered lines, and its contact sheet: where the face is and what space is free).
2. Decide the cut from the transcript like a top short-form editor: open on the strongest line (a hook in the first
   1.5 s, even if it is said later), keep one good take of each idea (drop false starts, repeated takes, tangents and dead
   air), end on a clear payoff or call to action. Length: what the brief asks; otherwise 30-60 s for a vertical video.
   Vertical and square videos are cut as the attention sawtooth (craft: SHORT-FORM ATTENTION CURVE): open on the
   strongest or most surprising line even if it comes from the end (flash-forward), then loops of question → partial
   answer every 4-7 s, a twist or contrast around 30%, the strongest payoff kept for the last 20% and ended on with the
   CTA (no goodbye, no outro). Cuts every 2-4 s; a stronger punch_in on each re-hook.
3. ONE edit_footage call with the ranges in order, punch_in 1.08-1.12 to hide the jump cuts. Read what it returns: the new
   timeline. Change the cut only with another edit_footage call; never move or trim footage layers by hand.
4. The footage is the backdrop: no background layers and nothing over the face (check the contact sheet and render_frames).
   The built-in captions show every kept word low in the frame and carry the word timing: never hide them.
5. Graphics on top, few and precise, timed with @word/@phrase refs: a hook title in the first seconds, kinetic key words
   or numbers when they are said, a graphic or sound hit on each re-hook, a lower third with the speaker's name only if the brief or the footage gives it, icons,
   UI or simple diagrams when an idea needs showing. Keep them in the top third or at the sides, clear of the captions.
   set_font for your text; design every animation yourself.
6. render_frames at a few cuts, review_video, fix what it shows. Finish with 2-3 lines: what you kept and dropped, and the
   graphics you added.`;

/** Plans the video and sets the look; builders do the heavy writing in parallel. */
const PLANNER_GUIDE = `You are Motionily's art director. There are NO presets: everything is designed by the team.
Your job is ONLY to plan, set the global look and lay out the WORLD, fast. Do not build the beats' content.
0. This is a NEW video from scratch: your very first call is apply_ops [{"op":"clear_layers"}] (drops any old cut).
1. get_project, get_brand (and view_image for any reference images). If a voice script or captions exist, the
   beats follow its paragraphs / word timings.
2. Decide an art direction (concept, palette with hex codes following COLOR below, typography, motion language,
   recurring motif) for THIS brief. Unique palette: never the generic violet/magenta/cyan AI look.
2b. MATERIAL, like a human editor: list what the viewer should SEE in each beat (the real logo, the place, the person,
   the object, a texture, a map) and gather it in ONE search_assets call (kinds photo|footage|logo|texture, one query
   per subject, English, specific; at most one more call for empty needs), pick by looking at the numbered sheets and
   import_assets the chosen ids in ONE call; cut_out subjects you want to collage. Write into each beat's brief the
   srcs to use and how: photos (src, slow push/pan, grade, text beside), logos (svg for add_vector: which pieces
   animate how, or the PNG src), footage (video src, in/out seconds), cutouts, maps (add_map focus/highlight/points)
   and the icon set (find_icons ids) — builders only know the material you hand them. Brand videos start from
   get_brand and search only for what the kit lacks.
2c. examples find (the user's FAVORITE videos: their taste) and set_direction with the genre (STYLE VOCABULARY),
   concept and techniques; honor the two constraints it returns, keep the principles of the favorites and make this
   video look unlike the account's latest other ones it lists (font, main color, moves). Put the constraints
   and how each beat honors them into the plan.
3. Apply the global look with tools: set_palette op (apply_ops), set_font, set_duration op.
4. WORLD FIRST: the video is ONE continuous space the camera travels through (like the reference films), not
   slides. With ONE add_layers call create the global layers (group "world"): the background (fixed=1 for
   screen-pinned backgrounds, or big world planes with z for parallax) and the camera "cam" (a vis=0 layer with
   cam=FOCAL[,FOCUS,APERTURE]) keyed for the WHOLE video: x/y = where it looks, z = dolly, s = zoom; eased moves
   between beat regions (eio), slow drift while a beat plays. Give each beat its own region of the world (x/y
   center, depth z, optional tilt rx/ry) that the camera visits on time.
5. If there is a REFERENCE FILM: first write a shot-by-shot breakdown from its sheets and timing (what is on
   screen, layout, camera move, transition, duration of each shot) and mirror its rhythm and techniques.
5b. STORY SHAPE: a canvas taller than wide or square (Reels, TikTok, Shorts) is told as the attention sawtooth of
   craft (SHORT-FORM ATTENTION CURVE), never as a classic arc: the first beat opens in medias res at energy ≥70, a
   re-hook every 4-7 s, a pattern interrupt at ~30%, peaks that escalate, the last beat the highest (reveal + CTA, no
   outro, no fade) handing back to the first. Each beat's brief says WHEN inside its span its own peak lands and how
   (device). 16:9 keeps a classic arc.
6. Answer with ONLY this JSON (no prose): {"direction":"…","motif":"…","reference":"shot-by-shot breakdown, or empty",
   "beats":[{"group":"hook","start":0,"end":2.5,"energy":85,"device":"hook","region":"x=960 y=540 z=0 (rx=…)",
   "brief":"what this beat shows, its layout, its motion, where its peak lands, how it hands over to the next"}]} — 2 to
   ${MAX_BEATS} beats, contiguous, covering the duration, group names snake_case and unique. energy = 0-100, how hard
   the beat grabs; device = hook | open_loop | payoff | twist | stakes_up | reveal | proof | pattern_interrupt |
   countdown | question | callback | cta.
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
- Build your beat in ONE run script (fewer turns = cheaper and faster): mo.add with ALL your layers, mo.layout at your
  key instants, fix what is off with mo.apply / mo.autofix, console.log a 2-3 line summary. Then ONE render_frames at
  2 moments of your span to look at it; fix only what is clearly broken with one more run. Do not run review_video.
${NO_PROBING}
- Product screenshots/logos: get_brand lists them; use their src in image layers.
${COMPACT_REF}
${CRAFT}
${MOTION_2D}
Reply with one short sentence when done.`;

const FINISHER_GUIDE = `You are the finishing editor of a Motionily video built by a team in parallel.
0. get_feedback FIRST: the user may have left notes while the team worked. Apply notes about the WHOLE video (font →
   set_font, background, palette → set_palette, pace, colors) across every group before anything else; then the notes
   pinned to a second or a layer. Call get_feedback again before you finish.
1. review_video. If there is a reference film, put your sheet next to its sheets (view_image) and name the 3
biggest gaps (palette, density, camera, transitions, rhythm); fix them first. On vertical or square videos, fix every
item of its attention section next (still frame 0, flat stretches, no pattern interrupt, weak finale, fade-out
ending): it decides whether people keep watching. 2. Fix only what is wrong (overlaps between beats, off-frame, dead air, broken transitions,
unreadable text): batch the reading and fixing in run scripts (mo.layers, mo.layout for exact screen boxes, mo.lint,
mo.apply, mo.add) instead of one tool call per check.
${NO_PROBING} 3. Review again only if you
changed a lot (max 2 rounds).
4. SOUND DESIGN: list_sounds, then ONE add_sfx call with a cue on every key motion moment of the timings below
   (whoosh on transitions, pop on entrances, impact on hero text, ticks on counters, riser before the reveal,
   chime on the payoff). Design what the library lacks with make_sound (named after this video) and place it too.
${COMPACT_REF}
Finish with a 2-3 sentence summary in English: the art direction and what the video shows.
${CRAFT}`;

/**
 * Premium builds the film beat by beat: the user watches it grow, each turn stays short (no
 * minutes of silent planning of the whole film) and a cut-off run keeps what it built.
 */
const SOLO_STEPS = `Build it STEP BY STEP, as ONE continuous world the camera travels through:
1. Gather like a human editor: get_project, get_brand, references; then ONE search_assets with everything the viewer
   should see (real logos, places, people, objects, footage, textures), ONE import_assets with your picks (cut_out
   for collage subjects), and set_direction (genre, concept, techniques: honor its two constraints, avoid the looks
   of the account's latest videos; examples find shows the user's favorite videos: keep what makes them work). Decide the
   beat list briefly; do not compose every beat in your head now.
2. Write ONE short line of plain text in English: the art direction. Then apply_ops (palette, duration), set_font and
   ONE add_layers with ONLY the world: the background and the camera "cam" keyed for the whole film, visiting one
   region per beat.
3. Then each beat IN ORDER: first a plain-text line "Scene N: <what it shows>" (the user sees it), then ONE run script
   that adds only that beat's layers (its own group) with mo.add, measures them at its key instants with mo.layout and
   fixes what is off (mo.apply / mo.autofix), logging a short summary. Never put two beats in one script, and do not
   design the next beat until this one is on screen.
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
   Gather real material like a human editor (ONE search_assets with every need: logos as SVG, photos, footage,
   textures; ONE import_assets; cut_out, add_vector for logos, add_map for places) and declare the look with
   set_direction before building: honor its two constraints and do not repeat the account's latest looks.
   The VOICE-OVER drives the video: if there are captions (the user uploaded the voice), tie every beat, text
   and cut to the words' timings and make on-screen text mirror what is said. If there is only a voice script
   (get_project), time beats to its paragraphs (~2.3 words/s, "[long pause]" = scene change) and keep it.
2. Lay out the WORLD first: one camera layer ("cam", cam=…) keyed for the whole film and a region (x/y, depth z)
   per beat that the camera travels to; the film is one continuous space, not slides.
   Decide an art direction that fits THIS brief (one sentence: concept, visual metaphor, mood, pacing), then plan
   2-5 beats. One idea per beat, strong hierarchy, big legible type, deliberate composition. On a vertical or square
   canvas the beats follow the attention sawtooth (craft: SHORT-FORM ATTENTION CURVE): open at 70% in medias res,
   re-hook every 4-7 s, interrupt at ~30%, escalate, end on the highest peak; review_video measures it.
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
5. The user can leave notes while you work: call get_feedback after each beat you finish and at the end, and apply
   them right away (notes about the WHOLE video change every beat: font, background, palette, pace).
${NO_PROBING}
${CRAFT}
${MOTION_2D}
Prefer add_layers (compact lines) over JSON for writing layers. Sound: list_sounds + add_sfx to sync effects to the motion.
${MANUAL}
${COMPACT_REF}
Finish with a 2-3 sentence summary in English: the art direction you chose and what the video shows.`;

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

/** `energy` (0-100) and `device` trace the attention curve the planner designed (craft: SHORT-FORM ATTENTION CURVE). */
type Beat = { group: string; start: number; end: number; brief: string; region?: string; energy?: number; device?: string };

/** Energy from which a beat is a peak, and under which it is a valley. */
const PEAK_ENERGY = 80;
const VALLEY_ENERGY = 50;

/** What a beat's energy asks of its builder. */
function energyNote(beat: Beat): string {
  if (beat.energy === undefined) return "";
  const how =
    beat.energy >= PEAK_ENERGY
      ? "A PEAK: hit it hard (camera move or whip, scale punch or color flip, big type, impact moment) and land it early in your span."
      : beat.energy >= VALLEY_ENERGY
        ? "A RE-HOOK: one clear new thing early in your span (a reveal, a number, a twist), then keep it moving."
        : "A VALLEY: calmer drift and smaller type, but a fact on screen and something moving every 0.5-1.5 s.";
  return `\nAttention: energy ${beat.energy}/100${beat.device ? `, device ${beat.device}` : ""}. ${how}`;
}
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

  async start(ownerId: Types.ObjectId, email: string, projectId: string, { instruction, model, effort, references, mode, resume, sfxOnly }: GenerateDto) {
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
    const voice = voiceLines(project.scene);
    run.voice = voice;
    const voiceNote = voice.length ? `\nVoice-over, timed (what is said when; the video must show it at that moment):\n${voiceDuring(voice, 0, Infinity)}` : "";
    const refs = (await referencePrompt([...new Set([...(project.references ?? []), ...(references ?? [])])])) + voiceNote;
    const opts: AgentOpts = { config, model, effort, size: FORMAT_SIZE[project.format] ?? FORMAT_SIZE[VideoFormat.Vertical] };

    // Callers without a mode (prefab workshop, older clients) keep their explicit model/effort.
    mode ??= model ? GenerateMode.Custom : GenerateMode.Balanced;
    const team = teamFor(mode, model, effort);
    // A fresh start drops any plan from an earlier run; a resume keeps it when one was saved.
    const saved = resume ? await this.projects.buildPlanOf(project.id) : null;
    if (!resume) await this.projects.setBuildPlan(project.id, null);
    const build = sfxOnly
      ? null
      : resume
      ? saved
        ? this.resume(run, refs, { ...opts, ...team.build }, team, saved)
        : this.single(run, CONTINUE_PROMPT + refs, { ...opts, ...team.build })
      : instruction?.trim()
      ? this.single(run, `The user asks: "${instruction.trim()}". Apply it to the current video (read get_project and inspect first; finish with review_video and fix what it shows).${refs}`, { ...opts, ...team.build })
      : project.footage?.length
      ? this.editFootage(run, refs, { ...opts, ...team.build })
      : this.team(run, refs, opts, team, mode);
    // Sound-only: just the sound pass on the video that is already on screen.
    const work = build
      ? build.then(async (usage) => {
          if (run.status === GenerateStatus.Running) await this.projects.logAgentRun(project.id, await this.soundPass(run, { ...opts, ...team.review }));
          return usage;
        })
      : this.soundPass(run, { ...opts, ...team.review });
    void work
      .then(async (usage) => {
        run.usage = usage;
        if (run.status === GenerateStatus.Running) run.status = GenerateStatus.Done;
        if (run.status === GenerateStatus.Done) await this.projects.setBuildPlan(project.id, null);
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

  /** A failed sound pass never fails the video: the cut is already done, so it only leaves a note. */
  private async soundPass(run: Run, o: AgentOpts): Promise<AgentRunUsage> {
    const t0 = Date.now();
    const results: ResultLine[] = [];
    this.push(run, GenerateEventKind.Phase, GeneratePhase.Sound);
    try {
      const { scene, brief } = await this.projects.soundInputOf(run.projectId!);
      const { moments, placed } = sceneMoments(scene);
      if (placed && !moments.length) {
        this.push(run, GenerateEventKind.Text, `Sound: the team already placed ${placed} cues, so nothing was added.`);
        return sumUsage(results, t0, { ...o, model: "sound", effort: undefined });
      }
      const list = moments.map((m) => `${m.at.toFixed(2)} ${m.kind} ${m.what}`).join("\n");
      const tone = brief.trim() ? `Brief (sets the tone):\n${brief.trim().slice(0, 1200)}\n\n` : "";
      const team = placed ? `The team already placed ${placed} cues; keep them and add only on these free moments.\n` : "";
      const prompt = moments.length
        ? `${tone}${team}Place sounds on these moments of the cut (seconds, kind, what). Use the time exactly as written, one add_sfx call:\n${list}`
        : `${tone}Add the sound effects to this video.`;
      const r = await this.agent(run, prompt, SOUND_GUIDE, { ...o, effort: AgentEffort.Low }, "sound", ROLE_TOOLS.sound);
      results.push(r.result);
      // What the sound agent says it did, so an empty result is visible in the log instead of silent.
      this.push(run, GenerateEventKind.Text, `Sound: ${r.text}`);
      // The builders' summary describes the video; the sound line only stands in when there is none.
      if (!run.summary) run.summary = r.text;
    } catch (e) {
      this.push(run, GenerateEventKind.Error, `sound: ${(e as Error).message}`);
      if (!run.summary) run.summary = `Sound: ${(e as Error).message}`;
    }
    return sumUsage(results, t0, { ...o, model: "sound", effort: undefined });
  }

  /** One editor cuts the user's clips and adds the graphics: the cut needs a single view of the whole transcript. */
  private async editFootage(run: Run, refs: string, o: AgentOpts): Promise<AgentRunUsage> {
    const r = await this.agent(run, `Edit this video from the user's footage.${refs}`, FOOTAGE_GUIDE, o, "edit", undefined);
    run.summary = r.text;
    return usageFrom(r.result, "edit", o.model ?? null, o.effort ?? null);
  }

  private async single(run: Run, prompt: string, o: AgentOpts): Promise<AgentRunUsage> {
    const r = await this.agent(run, prompt, AGENT_GUIDE, o, "", undefined);
    run.summary = r.text;
    return usageFrom(r.result, "edit", o.model ?? null, o.effort ?? null);
  }

  /** Plan, build beats in parallel, finish. Wall time ≈ planner + slowest beat + finisher. */
  private async team(run: Run, refs: string, base: AgentOpts, team: TeamSetup, mode: GenerateMode): Promise<AgentRunUsage> {
    // The cost log names the mode rather than one model (each role may run a different one).
    const label: AgentOpts = { ...base, model: `${mode} mode`, effort: undefined };
    const o: AgentOpts = { ...base, ...team.plan };
    const results: ResultLine[] = [];
    const t0 = Date.now();
    if (team.solo) return this.solo(run, refs, base, team, label, t0);
    this.push(run, GenerateEventKind.Phase, GeneratePhase.Plan);
    const planned = await this.agent(run, `Plan this video from its brief.${refs}`, PLANNER_GUIDE, o, "plan", ROLE_TOOLS.planner);
    results.push(planned.result);
    const plan = parsePlan(planned.text);
    await this.projects.setBuildPlan(run.projectId!, { plan: { ...plan }, done: [] });
    this.push(run, GenerateEventKind.Text, plan.direction);
    this.push(run, GenerateEventKind.Plan, JSON.stringify(plan.beats.map(({ group, start, end }) => ({ group, start, end }))));
    return this.buildFrom(run, plan, plan.beats, refs, base, team, results, label, t0);
  }

  /** Continue an interrupted team run: the saved plan, only the beats not built yet, then the review. */
  private async resume(run: Run, refs: string, base: AgentOpts, team: TeamSetup, saved: { plan: Record<string, unknown>; done: string[] }): Promise<AgentRunUsage> {
    const plan = saved.plan as Plan;
    const label: AgentOpts = { ...base, model: "continue", effort: undefined };
    this.push(run, GenerateEventKind.Text, plan.direction);
    return this.buildFrom(run, plan, plan.beats.filter((b) => !saved.done.includes(b.group)), refs, base, team, [], label, Date.now());
  }

  /** Builders write the given beats in parallel, then the finisher reviews the whole cut. */
  private async buildFrom(run: Run, plan: Plan, beats: Beat[], refs: string, base: AgentOpts, team: TeamSetup, results: ResultLine[], label: AgentOpts, t0: number): Promise<AgentRunUsage> {
    const o = base;
    this.push(run, GenerateEventKind.Phase, GeneratePhase.Build);

    // The plan already did the thinking: builders and finisher execute it with low effort (thinking is output tokens).
    const crew: AgentOpts = { ...base, ...team.build };
    const overview = plan.beats.map((b) => `- ${b.group} ${b.start}-${b.end}s${b.energy !== undefined ? ` (energy ${b.energy}${b.device ? `, ${b.device}` : ""})` : ""}: ${b.brief}`).join("\n");
    const queue = [...beats];
    const worker = async () => {
      for (let beat = queue.shift(); beat && run.status === GenerateStatus.Running; beat = queue.shift()) {
        const reference = plan.reference ? `\nReference breakdown (match its techniques and rhythm):\n${plan.reference}` : "";
        const prompt = `Art direction: ${plan.direction}\nRecurring motif: ${plan.motif ?? "—"}${reference}\nWhole video:\n${overview}\n\nYOUR BEAT: group "${beat.group}", ${beat.start}-${beat.end}s, world region ${beat.region ?? "centered"}.\n${beat.brief}${energyNote(beat)}${voiceFor(run, beat)}\nCanvas ${o.size[0]}x${o.size[1]} px. Palette and font are already set (use the slot names). Build it now.`;
        const r = await this.agent(run, prompt, BUILDER_GUIDE, crew, beat.group, ROLE_TOOLS.builder).catch((e: Error) => {
          this.push(run, GenerateEventKind.Error, `${beat!.group}: ${e.message}`);
          return null;
        });
        if (r) {
          results.push(r.result);
          await this.projects.markBeatDone(run.projectId!, beat.group);
        }
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
      child.on("error", (e) => reject(new Error(`Could not start Claude Code: ${e.message}`)));
      child.on("close", (code) => {
        run.processes.delete(child);
        if (child.pid && run.projectId) void this.projects.trackPid(run.projectId, child.pid, false);
        if (code === 0 && final) return resolvePromise({ text: final.result?.trim() ?? "", result: final });
        reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || `claude exited with code ${code}`));
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
    throw new Error("The planner did not return a valid plan; try again.");
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
