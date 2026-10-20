import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConflictException, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Types } from "mongoose";
import { TokenScope, type JwtPayload } from "../auth/auth";
import { ProjectsService } from "./projects.service";
import { AgentEffort, AgentModel, GenerateMode, type GenerateDto } from "./projects.dto";
import { VideoFormat, type AgentRunUsage } from "./project.schema";

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

/** What makes motion graphics look professional instead of "a title and a box". Shared by every role. */
const CRAFT = `MOTION DESIGN CRAFT (non-negotiable) — the engine is an After Effects: use it, never settle for flat.
- Depth in 3 planes: a living background (soft gradient blobs drifting with expressions, never a flat color for
  a whole beat), mid content (cards, UI, type), foreground accents (glows, particles, light trails).
- Kinetic type: headlines animate per character or word with a text animator (expo_out, stagger 0.02-0.06 s),
  key words in a gradient, reveals through a matte, scale punches on the key word, tight letter spacing (ls<0)
  on big type.
- Premium surfaces: white/glass cards with rounded corners, a soft COLORED drop shadow (tint of the palette, low
  opacity, big blur), thin pastel outlines; real product screenshots inside device/card frames.
- Graphic language: paths that draw on (trim) for connectors, underlines and icons; dashed curves; glowing light
  trails (stroke + glow + blend add, best on dark); dot grids and particle fields with repeaters; counters,
  progress bars, chips, cursors. Repeat one motif across beats.
- Motion: everything eases (expo_out for UI, back/spring for pops, elastic sparingly); secondary motion (what
  enters makes something react); subtle constant drift (wiggle) so nothing is dead; parallax by parenting layers to
  invisible "camera" nulls and moving/scaling those; match cuts and wipes (a shape grows to become the next
  background), never hard cuts.
- Rhythm: something meaningful changes every 0.5-1.5 s; hold the key message ~1 s to be read.
- Composition: strong grid, generous margins (≥ 8% of the frame), max 2 type sizes per beat + 1 small label.
- Finish like After Effects: motion blur (mblur) on anything that travels fast, shapes that morph into the next
  shape, objects flying along curved motion paths, follow-through via layer references, a subtle grain or color
  grade adjustment layer to glue the look, luma/alpha matte reveals.
- Save tokens with expressions, repeaters, loops (time=(mod(t,P))) and layer references instead of many
  hand-made keyframes/layers.`;

/**
 * What professional 2D motion graphics (SaaS launch films, product promos on Pinterest/Dribbble)
 * look like, distilled from reference videos the team collected. The planner picks a family per
 * brief (or blends two); builders execute it with the recipes.
 */
const MOTION_2D = `PRO 2D MOTION GRAPHICS — the bar is a studio launch film, not a slideshow. Pick ONE look family per video
(say which in the direction) and execute its signature moves:
A. LIGHT 3D PRODUCT TOUR — white/pale-blue world, the product's UI (cards, hero, pricing tiles, chips) laid out
   flat on a 3D plane: a null with rx=40..60 and ry=-15..15 that every UI layer is parented to; the camera "flies"
   over it (animate the null's y, z and rx with eo), strong motion blur (mblur=180,8 on the null's children is
   implied by the move: put mblur on fast flyers), floating glossy objects (soft-shadowed rounded shapes,
   icons) drifting above the plane, colorful pill tags (orange/green/yellow/blue, rad=h/2) popping in with
   back/spring, depth of field (blur=8..20 on the nearest/farthest elements). Ends flat: the plane rotates
   to rx=0 and settles into a clean centered card + title.
B. DARK KINETIC TYPE — near-black background with slow glossy light ribbons (wide soft gradient paths, glow,
   blend=add, drifting with expressions) or a dark gradient; short lines centered, ONE phrase at a time,
   words entering one by one: {"animate":{"by":"word","stagger":0.12,"duration":0.6,"ease":"ease_out",
   "from":{"opacity":0,"blur":16,"scale":1.12}}}; the key word in the accent color or a gradient; big single
   words ("Meet", "Introducing") char by char with blur; phrases exit by blurring out/fading as the next arrives
   (≈1-1.5 s each). Product UI shown in slight perspective (rx=8..20) with collaboration cursors (path arrow +
   name pill), a typed prompt with caret. Logo reveal: mark scales down from huge with blur, letters fly in.
C. NEON GLASS ICONS — pure black, app-icon tiles (rad≈26% of size) with a dark fill, a conic gradient outline
   (sgrad=con:… orange→magenta→violet→blue, angle animated) plus glow, a bright colorful icon inside (paths with
   gradients); tiles orbit/scatter around a centered short word ("Any case"), push in and out with spring,
   one tile flies to the center and morphs/pulses with a big soft purple bloom behind it (blurred ellipse,
   blend=add). Loops with time=(mod(t,P)).
D. WARM FLUID + AGENT UI — full-bleed liquid cloud gradient (2-4 huge soft ellipses in warm oranges/reds/violet
   with turb=120..200,350..450,0.4..0.7, slowly drifting) behind white UI cards: a prompt box typing with caret
   (reveal + caret), a node graph whose nodes pop in connected by curved paths drawn with trim, images/cards
   popping into a collage grid, a big gradient headline with a typing caret ("2 settings|").
E. DARK DASHBOARD + GLOWING PROMPT — near-black (#05050c→#12121a) with one faint colored glow (plum or steel), a pill prompt bar with an animated
   conic glowing outline (stroke-only layer: sgrad + glow, angle=(t*90)), text typing with caret, a cursor
   that moves to the send button and clicks (scale 1>0.85>1), then a dashboard flies in tilted (rx/ry) and
   straightens; inside: counters (count=… with {n}), bar/line charts drawing on (paths with te), donut rings
   (stroke trim), maps or grids filling in with staggered repeaters.
COLOR — unique, never "vibe coded". Unless the brand gives a palette, build one the way these films do (measured):
- Neutrals own the frame (60-90%): pure black #000000/#05070c, near-black #12121a, white #fdfdfd, warm grey
  #ececec/#f4f2ef, charcoal #343640, slate #3f4658. Backgrounds are neutral or ONE hue very dark/very pale.
- ONE hue family carries the film, in a few tones: sky #91cff2/#57a0db/#c9e3f2 (Maily) · vermilion/ember
  #d54b2c/#e87c3d/#ecc6ae (Flows) · cobalt steel #354978/#0e2745/#809bbc (Synaps) · powder blue + plum
  #92b6cc/#2c1b2e on #12121a (Fuse) · deep indigo glow #3c3f90/#2b0062 on black (youmotion).
- Saturation is small and precious: the key word, an icon, a chip, a light edge — ≤10-15% of the pixels.
  Small pops of 2-3 candy colors (pills/tags) are fine on a neutral page.
- Gradients stay within one family (adjacent hues) or go hue → neutral; light comes from glows on dark.
- BANNED unless the brand demands it: violet+magenta+cyan neon, indigo→pink "AI" gradients, rainbow, saturated
  full-frame backgrounds, pure #7c5cff/#a855f7/#ec4899/#22d3ee-style Tailwind defaults.
- Pick something specific to the brief (an ember-orange fintech, a cobalt architecture tool, a sage-green
  health app) and name it in the direction with its hex codes; review_video flags saturated or neon palettes.
Shared grammar (all families):
- Camera never static: slow push (cam null s=1>1.06) plus one or two decisive moves per beat; transitions are
  moves (fly-through, whip pan with mblur, zoom through an element, blur-out/blur-in), never hard cuts.
- Layer depth: background (gradient/fluid/ribbons), mid (UI, type), foreground (floating objects, particles,
  bloom). Defocus what is not the subject (blur 6-20).
- UI is real-looking and dense: rows of skeleton text (thin rounded bars at 15-30% opacity), avatars (circles
  with gradients), chips, toggles, icons drawn with paths, numbers that count. Simulate the product, don't
  describe it.
- Type: one line at a time, 1 accent word, tight letter spacing on big type, readable for ≥0.8 s.
- Timing: 0.4-0.7 s eo entrances, overlapping staggers, a beat every ≤1.5 s, holds only on the payoff/logo.
- Finish: subtle grain (adjustment layer grain=0.03-0.06) and bloom on light sources; end on logo + one line CTA.`;

/** Mirrors FORMAT_SIZE in @motionily/protocol. */
const FORMAT_SIZE: Record<VideoFormat, [number, number]> = {
  [VideoFormat.Vertical]: [1080, 1920],
  [VideoFormat.Horizontal]: [1920, 1080],
  [VideoFormat.Square]: [1080, 1080],
  [VideoFormat.Portrait]: [1080, 1350],
};

/** Everything a builder needs to write layers, inline (no get_reference round trip). */
const COMPACT_REF = `WRITING LAYERS — add_layers, one line per layer (never JSON):
  id type start[-end] key=value… "text or path data" {optional JSON merged into the layer}
  types: rect | ellipse | text | image | path. Scene pixels, x/y = CENTER, origin top-left. w,h required (not for path).
  value: number · tween from>to@t0-t1[:ease] · keys t:v[:ease],t:v… (t from the layer start) · (expression)
  eases: o i io b h · eo ei eio (expo; eo = premium UI) · el (elastic) · bo (bounce)
  expressions: (540 + 40*sin(t*2)) (wiggle(2,8)) (spring(t,2.2,7)) (lerp(0,1,ease(t/0.6))) — vars t (layer s),
    T (scene s), i/n (repeater copy/count); funcs sin cos noise rand wiggle spring ease ease_in ease_out back
    elastic bounce clamp lerp smoothstep step min max abs floor fract mod pulse saw tri
    · other layers: (card.x) (card.y(T-0.15)) — props x y w h s r o, now or at a scene time (follow-through, echoes)
  transform: x y w h s(scale) r(rotation°) o(opacity) rad(corner) pivot=x,y parent=layer_id (inherits its transform)
  paint: fill=slot|#rrggbb[aa] | color keys fill=0:#ffffff,0.6:#ff3d5a:eo · grad=lin:ANGLE:color@pos,color@pos… | grad=rad:CX,CY:R:color@pos,… (up to 4 stops)
    · stroke=WIDTH:COLOR[:DASH,GAP] · soft=FEATHER_PX (blobs: big soft ellipses = mesh gradient)
  effects (in order): shadow=X,Y,BLUR,COLOR[,OPACITY] · glow=RADIUS[,STRENGTH[,COLOR]] · blur=RADIUS · blend=add|screen|multiply
    · mblur=SHUTTER°,SAMPLES (motion blur on fast movers: mblur=180,8) · color=HUE°,SAT,BRIGHT,CONTRAST · rgb=PX (RGB split)
    · wave=AMP,WAVELENGTH,SPEED (warp) · grain=AMOUNT
  adj=1: adjustment layer — its effects apply to everything below, inside its own shape (full-frame rect = whole picture)
    · turb=AMOUNT,CELL_PX,SPEED (turbulent displace: on huge soft blobs = liquid/cloud backgrounds)
  matte=layer_id[:inv|:luma|:lumainv] (that layer's alpha or brightness masks this one; give the matte vis=0) · vis=0 hides a layer
  3D: rx=DEG (top leans back) ry=DEG z=PX (away) persp=PX on a layer (usually an invisible null): it and all layers
    parented to it are drawn flat then projected in perspective (UI pages lying back, dashboards turning).
    Inside a 3D layer, children's own effects are ignored: fake their shadows with soft rects (soft=).
  gradients: grad=con:CX,CY:ANGLE:stops (conic; animate ANGLE=(t*90) for rotating light) · sgrad=… paints the stroke
    (glowing borders: stroke=3:#fff sgrad=con:0.5,0.5:(t*90):#57a0db@0,#c9e3f2@.5,#57a0db@1 glow=24,1.2)
  motion: mp="SVG path in scene px" mpp=PROGRESS 0..1 orient=1 (moves along the path, turning with it; x/y add an offset)
    · time=(EXPR) time remap of the layer's clock: (mod(t,1.2)) loops, (t*0.5) slow motion, keys freeze/reverse
    · morph a path between shapes via JSON {"morph":[{"t":0,"d":"M…"},{"t":0.8,"d":"M…","ease":"expo_in_out"}]}
  repeat: rep=COUNT:DX,DY[:cols=N][:rot=DEG][:sc=K][:op=K][:delay=S] (grids, particles, staggered lists)
  text: size= role=heading|body align= lh= ls=LETTER_SPACING · ONE layer per phrase: mark the key word "Just *ask.*"
    (accent=COLOR, default palette accent) — never split a phrase into word layers (they collide or jam); per-unit animation via JSON:
    {"animate":{"by":"char|word|line","stagger":0.03,"duration":0.5,"delay":0,"ease":"expo_out","from":{"x":0,"y":40,"scale":0.8,"rotation":0,"opacity":0}}}
    · text on a path: tp="M-700 0 C-300 -250 300 250 700 0" (relative to x,y) tpo=OFFSET_PX (animate it to crawl along)
    · animator "from" also takes "blur":16 (words coming into focus)
    · counter: count=0>12480@0-2:eo dec=0 and "{n}" in the text ("{n} users", "$ {n}") — thousands separators added
    · typewriter: reveal=(max(0,(t-0.3)*16)) chars typed (spaces not counted) caret=1 (blinking caret)
  path: "SVG path data" relative to x,y (M L H V C S Q T A Z) · ts= te= to= trim start/end/offset 0..1 (te=0>1@0-.8:o draws it on)
    · filled=1 fills closed subpaths with fill/grad.
  Same id again = replace that layer.
recipes:
  bg_a ellipse 0 x=(420+60*sin(t*0.6)) y=(260+40*cos(t*0.5)) w=1100 h=900 fill=#f7b9e0 soft=260 o=.85
  card rect .3 x=960 y=560 w=820 h=420 rad=32 fill=surface s=.92>1@0-.7:eo o=0>1@0-.3 stroke=2:#ffd0dd shadow=0,30,70,#ff6f91,.35
  key text 3.6 x=960 y=900 w=1500 h=180 size=140 role=heading ls=-4 grad=lin:0:text@0,text@.4,#ff3d5a@.46,#ffa23d@1 "is the problem" {"animate":{"by":"char","stagger":0.035,"from":{"y":70,"opacity":0,"scale":0.8}}}
  link path 1.2 stroke=3:text:10,10 te=0>1@0-.9:o "M330 260 C480 260 520 420 560 470"
  trail path 1.8 stroke=4:#ff8a5b ts=(max(0,(t-0.4)*1.4)) te=(min(1,t*1.6)) glow=18,1.6,#ff6f3c blend=add "M560 470 C600 520 640 560 700 560"
  dots ellipse 0 x=160 y=140 w=6 h=6 fill=text o=(0.12+0.1*sin(T*2+i*0.7)) rep=60:145,160:cols=12
  arrow path .4 fill=primary filled=1 mp="M150 900 C600 150 1200 1050 1750 250" mpp=0>1@0-1.2:eio orient=1 mblur=180,8 "M30 0 L-20 -16 L-12 0 L-20 16 Z"
  pulse ellipse 0 x=1500 y=300 w=40 h=40 fill=accent time=(mod(t,1.4)) s=1>2.4@0-1.2:eo o=.6>0@0-1.2:o
  echo rect 1 x=(card.x(T-0.12)) y=(card.y(T-0.12)) w=820 h=420 rad=32 fill=#ffffff40   (a ghost trailing "card")
  plane rect 0 vis=0 x=1100 y=620 w=1 h=1 rx=58>40@0-2.4:eo ry=-12 z=500>0@0-2.4:eo   (children: parent=plane, x/y relative)
  border rect 1 x=960 y=540 w=760 h=120 rad=60 fill=#00000000 stroke=3:#ffffff sgrad=con:0.5,0.5:(t*90):#e87c3d@0,#ecc6ae@0.3,#343640@0.6,#e87c3d@1 glow=24,1.2
  typed text 1.2 x=960 y=540 w=640 h=60 size=34 align=left fill=#ffffff reveal=(max(0,(t-0.3)*16)) caret=1 "Provide complex widgets"
  fluid ellipse 0 x=520 y=320 w=1200 h=900 fill=#ff6a2b soft=320 turb=150,400,0.5
  glitch rect 5.8-6.2 x=CENTER_X y=CENTER_Y w=FULL_W h=FULL_H adj=1 rgb=8 wave=6,120,3 grain=.06   (a quick transition hit)
  cam rect 0 vis=0 x=0 y=0 w=1 h=1 pivot=CENTER_X,CENTER_Y s=1>1.06@0-6:io   (a camera null: layers with parent=cam keep
    their absolute x/y and get a slow push-in around the frame center; animate cam x/y/r for pans and tilts)
Other ops via apply_ops: {"op":"remove_layer","id":…} {"op":"remove_group","group":…} {"op":"set_palette","palette":{"background":"#…","surface":"#…","primary":"#…","accent":"#…","text":"#…"}} {"op":"set_duration","duration":12}`;

/** MCP tools each role sees (each tool description costs context on every turn). */
const ROLE_TOOLS = {
  planner: ["get_project", "get_brand", "view_image", "view_asset", "search_fonts", "set_font", "apply_ops"],
  builder: ["add_layers", "apply_ops", "render_frames", "view_asset", "view_image", "get_brand", "find_icons"],
  finisher: ["review_video", "render_frames", "get_group", "add_layers", "apply_ops", "list_sounds", "add_sfx"],
} as const;

/** Plans the video and sets the look; builders do the heavy writing in parallel. */
const PLANNER_GUIDE = `You are Motionily's art director. There are NO presets: everything is designed by the team.
Your job is ONLY to plan and set the global look, fast. Do NOT build layers.
1. get_project, get_brand (and view_image for any reference images). If a voice script or captions exist, the
   beats follow its paragraphs / word timings.
2. Decide an art direction (concept, palette with hex codes following COLOR below, typography, motion language,
   recurring motif) for THIS brief. Unique palette: never the generic violet/magenta/cyan AI look.
3. Apply the global look with tools: set_palette op (apply_ops), set_font, set_duration op.
4. Answer with ONLY this JSON (no prose): {"direction":"…","motif":"…","beats":[{"group":"hook","start":0,"end":2.5,
   "brief":"what this beat shows, its layout, its motion, how it transitions out"}]} — 2 to ${MAX_BEATS} beats,
   contiguous, covering the duration, group names snake_case and unique.
${CRAFT}
${MOTION_2D}`;

const BUILDER_GUIDE = `You are one motion designer of a team building a video in Motionily, in parallel with others.
There are NO presets: write every animation as keyframes yourself. Work ONLY on your beat:
- Every layer you add has "group" set to your group and an id starting with your group name.
- Your layers live inside your time span (start/end), plus up to 0.4 s of overlap for the transition out.
- Never remove, edit or read other groups. Do not change palette, font, size or duration.
- Write ALL your layers in ONE add_layers call (fewer turns = cheaper and faster), then ONE render_frames at
  2 moments of your span; fix only what is clearly broken with one more add_layers. Do not run review_video.
- Product screenshots/logos: get_brand lists them; use their src in image layers.
${COMPACT_REF}
${CRAFT}
${MOTION_2D}
Reply with one short sentence when done.`;

const FINISHER_GUIDE = `You are the finishing editor of a Motionily video built by a team in parallel.
1. review_video. 2. Fix only what is wrong (overlaps between beats, off-frame, dead air, broken transitions,
unreadable text): get_group to read a group as compact lines, add_layers to fix. 3. Review again only if you
changed a lot (max 2 rounds).
4. SOUND DESIGN: list_sounds, then ONE add_sfx call with a cue on every key motion moment of the timings below
   (whoosh on transitions, pop on entrances, impact on hero text, ticks on counters, riser before the reveal,
   chime on the payoff). If the library is empty, skip this.
${COMPACT_REF}
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
${MOTION_2D}
Prefer add_layers (compact lines) over JSON for writing layers. Sound: list_sounds + add_sfx to sync effects to the motion.
${COMPACT_REF}
Finish with a 2-3 sentence summary in Spanish: the art direction you chose and what the video shows.`;

type RoleModel = { model: AgentModel; effort: AgentEffort };
type TeamSetup = { plan: RoleModel; build: RoleModel; review: RoleModel; reviewRounds: number };

/**
 * Who does what in each mode. Premium is all Opus thinking hard (best motion design, slowest and
 * priciest); Economy is Sonnet executing a Sonnet plan.
 */
const TEAM: Record<Exclude<GenerateMode, GenerateMode.Custom>, TeamSetup> = {
  [GenerateMode.Premium]: {
    plan: { model: AgentModel.Opus, effort: AgentEffort.High },
    build: { model: AgentModel.Opus, effort: AgentEffort.Medium },
    review: { model: AgentModel.Opus, effort: AgentEffort.Medium },
    reviewRounds: 3,
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
    const refs = references?.length ? ` The user attached reference images; look at each with view_image first: ${references.join(", ")}.` : "";
    const opts: AgentOpts = { config, model, effort, size: FORMAT_SIZE[project.format] ?? FORMAT_SIZE[VideoFormat.Vertical] };

    // Callers without a mode (prefab workshop, older clients) keep their explicit model/effort.
    mode ??= model ? GenerateMode.Custom : GenerateMode.Balanced;
    const work = instruction?.trim()
      ? this.single(run, `The user asks: "${instruction.trim()}". Apply it to the current video (read get_project and get_scene first; finish with review_video and fix what it shows).${refs}`, { ...opts, ...teamFor(mode, model, effort).build })
      : this.team(run, refs, opts, teamFor(mode, model, effort), mode);
    void work
      .then((usage) => {
        run.usage = usage;
        void this.projects.logAgentRun(project.id, usage);
        if (run.status === GenerateStatus.Running) run.status = GenerateStatus.Done;
        void this.projects.setLiveRun(project.id, null);
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
        const prompt = `Art direction: ${plan.direction}\nRecurring motif: ${plan.motif ?? "—"}\nWhole video:\n${overview}\n\nYOUR BEAT: group "${beat.group}", ${beat.start}-${beat.end}s.\n${beat.brief}\nCanvas ${o.size[0]}x${o.size[1]} px. Palette and font are already set (use the slot names). Build it now.`;
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
    const finished = await this.agent(run, `Review and polish the whole video. Canvas ${o.size[0]}x${o.size[1]} px. Groups: ${plan.beats.map((b) => `${b.group} ${b.start}-${b.end}s`).join(", ")}.`, FINISHER_GUIDE.replace("(max 2 rounds)", `(max ${team.reviewRounds} rounds)`), { ...base, ...team.review }, "review", ROLE_TOOLS.finisher);
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
            env: { MOTIONILY_API: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3100}`, MOTIONILY_PROJECT: projectId, MOTIONILY_TOKEN: token, ...(tools ? { MOTIONILY_TOOLS: tools.join(",") } : {}) },
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
