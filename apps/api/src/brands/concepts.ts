import { basename, extname, join } from "node:path";
import { BadGatewayException, Injectable } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsEnum, IsIn, Matches, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { AgentEffort, AgentModel, MAX_REFERENCES } from "../projects/projects.dto";
import { MEDIA_DIR, MEDIA_PATH } from "../media";
import { VideoFormat, type AgentRunUsage } from "../projects/project.schema";
import { usageFrom } from "../projects/generate.service";
import { askClaude } from "../common/claude-once";

export const MAX_CONCEPTS = 6;
const CONCEPT_TIMEOUT_MS = 180_000;

/** What a beat does for attention. Mirrors AttentionDevice in @motionily/protocol. */
const DEVICES = ["hook", "open_loop", "payoff", "twist", "stakes_up", "reveal", "proof", "pattern_interrupt", "countdown", "question", "callback", "cta"] as const;

export class ConceptBeatDto {
  @IsString() at: string;
  @IsString() what: string;
  /** How hard the beat grabs attention, 0-100: the beats trace the video's attention curve. */
  @IsOptional() @IsInt() @Min(0) @Max(100) energy?: number;
  @IsOptional() @IsIn(DEVICES) device?: (typeof DEVICES)[number];
}

/** One way to make the video, as the agent pitches it. */
export class ConceptDto {
  @IsString() title: string;
  @IsString() hook: string;
  @IsString() direction: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ConceptBeatDto) beats: ConceptBeatDto[];
  @IsString() voiceover: string;
  /** Full brief handed to the generator; the user can edit it. */
  @IsString() prompt: string;
}

export class ConceptsRequestDto {
  @IsString() @MinLength(3) @MaxLength(4000) idea: string;
  @IsOptional() @IsEnum(VideoFormat) format?: VideoFormat;
  @IsInt() @Min(1) @Max(MAX_CONCEPTS) count: number;
  /** When set, pitch only the concept for this angle (the client asks for each in parallel). */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_CONCEPTS - 1) angle?: number;
  /** "más humor", "menos texto"… applied to a new round. */
  @IsOptional() @IsString() @MaxLength(1000) steer?: string;
  /** Titles already shown, so a new round brings different ideas. */
  @IsOptional() @IsArray() @IsString({ each: true }) avoid?: string[];
  @IsOptional() @IsEnum(AgentModel) model?: AgentModel;
  @IsOptional() @IsEnum(AgentEffort) effort?: AgentEffort;
  /** Reference images the user attached to the idea (media paths). */
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_REFERENCES) @Matches(MEDIA_PATH, { each: true }) references?: string[];
}

/** Different directions so parallel pitches don't converge on the same idea. */
/** Reels, TikTok and Shorts (9:16, 4:5, 1:1): the attention sawtooth (docs/agent/craft.md). */
const SHORT_FORM_STORY = `STORY SHAPE: this format is short-form (Reels, TikTok, Shorts), so attention is a sawtooth, not an arc.
- Start at 70%: the first beat opens in medias res on the most surprising result, conflict or image. No setup, no logo.
- Re-hook every 4-7 s: each beat opens a question, pays part of it with a concrete fact or visual, and opens the next
  before closing the last.
- A pattern interrupt around 30% (a twist, "but…"); peaks escalate; the biggest reveal in the last 20%.
- End on the peak: last reveal + CTA in the final 2-3 s, no outro, no goodbye; the last line hands back to the first so
  the video loops.
- Valleys still teach: a fact per beat, never filler.
- The sawtooth lives in WHAT HAPPENS, not in inserted teaser lines: each re-hook is a turn of the one continuous story
  (a consequence, a discovery, a twist), told in connected sentences.
- Tag every beat with "energy" (0-100, how hard it grabs) and "device" (${DEVICES.join(" | ")}). The energies trace the
  sawtooth: the first ≥70, dips never under 35, each peak higher than the one before, the final beat the highest.`;
/** 16:9 (YouTube, web): a classic arc still works there. */
const CLASSIC_STORY = `STORY SHAPE: 16:9 keeps a classic arc (setup, rising interest, climax, short resolution). Still tag every beat with
"energy" (0-100) and "device" (${DEVICES.join(" | ")}).`;

const ANGLES = [
  "humor: a relatable everyday situation told with comic timing",
  "bold kinetic typography driven by the voice, punchy and rhythmic",
  "the product in action: real screens/UI walked through step by step",
  "data and proof: numbers, counters, before/after",
  "a visual metaphor that carries the whole video",
  "emotional micro-story of one person, from problem to relief",
];

type BrandContext = { name: string; notes: string; palettes: unknown[]; assets: { kind: string; name: string; description: string }[] };

const SYSTEM = `You are the creative director of Motionily, a tool where an AI agent builds motion-graphics videos
by hand (no presets: it writes every keyframe). Motionily is a MOTION GRAPHICS tool first: kinetic typography,
shapes, color blocks, icons, UI/product screens animated in 2D. 3D (procedural sets, faceless black stickmen) is an
occasional ingredient: use it in at most one concept and only when a scene with people/places truly carries the
idea or the user asks for it. Most concepts must be pure 2D motion graphics. Pitch genuinely different concepts for the user's idea: different metaphors, structures, tones and
visual worlds — never variations of one idea. The format sets the STORY SHAPE (given with the request); always: hook in
the first 1.5 s (max 6 words), one idea per beat. The video is built ON TOP of the voice-over, so the script comes first.
"voiceover" is the script ready to paste in ElevenLabs v3:
- One tone tag first line only: [confident], [warm] or [playful].
- ONE continuous story, the way a person tells it to a friend: every sentence follows from the one before (so, but,
  because, which meant, until), with real names, places and stakes, building to the end; read aloud without the video
  it still makes complete sense. Never a list of punchy lines, slogan fragments or teaser filler ("But wait…",
  "Here's the thing", "You won't believe…").
- Storytelling, each paragraph flowing from the previous; natural spoken language (see LANGUAGE), irregular rhythm,
  never "Tuesday, ten a.m." openings or three punchy fragments in a row.
- EXPLAIN, do not tease. For history, science, news or any educational topic the script teaches: say who, what,
  where, when and why, with the concrete facts (names, places, dates, numbers, cause and consequence), 3-5 full
  sentences per scene, so a viewer who knows nothing finishes understanding the story. A reel of 60-90 s is
  expected to carry 150-200 words. Never a slogan-length script for an explanatory topic.
- Paragraph 1 = cold hook without the brand name; the brand appears in paragraph 2.
- Short-form formats: each paragraph ends opening the question the next one answers, one "but…" twist around a
  third of the way, the biggest reveal in the last paragraph, and the closing line (with the CTA) echoes the first.
- Between scenes exactly "[long pause] [long pause]" on its own line; inside a paragraph only commas/periods.
- Numbers and times written in letters. Only true claims about the product.
- ~2.3 words per second of video: the length of the script sets the length of the video. Last sentence = the CTA.
- What is said mirrors the text that will appear on screen.
- Art direction and prompt: real material carries the picture (archive photos and footage, real documents and newspaper
  pages photographed, maps, logos, the product's real screens); plain captions; one accent colour. Never write AI tells
  into a brief, even if the brand notes mention them: rubber stamps, censorship or redaction bars, fake documents drawn
  with shapes, tilted paper strips, marker underlines, decorative counters, a kicker on every scene, "interface screens"
  for a story that is not about software, words cut by the frame edge, 3D text used as flat type. Brand palettes and
  fonts are starting points, not a uniform: leave the final palette, type and genre to the builder (set_direction).
Answer ONLY with JSON: {"concepts":[{"title","hook","direction","beats":[{"at":"0-1.5s","what":"…","energy":80,"device":"hook"}],"voiceover","prompt"}]}.
"direction" = art direction in 1-2 sentences (concept, palette, type, motion, camera). "prompt" = the complete brief
for the builder agent (in English, 80-200 words): beats tied to the script's paragraphs with their energy and device,
art direction, what to show of the product. Beats' "at" follow the script timing.
LANGUAGE: "title", "hook", the beats' "what" and the "voiceover" are written in the language of the user's Idea line.
Detect it from the Idea alone: brand notes, asset names, palettes and references never decide it. If the idea is too
short to tell or mixes languages, use American English (the audience is mostly in the United States). "direction" and
"prompt" are always in English (they are for the builder agent); "prompt" names the video's language so on-screen text
matches the voice.`;

/** Asks Claude (no tools, one shot) for N different ways to make a video. */
@Injectable()
export class ConceptsService {
  async pitch(dto: ConceptsRequestDto, brand: BrandContext): Promise<{ concepts: ConceptDto[]; usage: AgentRunUsage | null }> {
    const kit = [
      `Brand/project: ${brand.name}`,
      brand.notes && `About the product: ${brand.notes}`,
      brand.palettes.length ? `Brand palettes: ${JSON.stringify(brand.palettes)}` : "",
      ...brand.assets.map((a) => `Asset (${a.kind}) "${a.name}": ${a.description || "no description"}`),
    ].filter(Boolean);
    const prompt = [
      ...(dto.angle !== undefined
        ? [
            `MANDATORY ANGLE for this concept: ${ANGLES[dto.angle % ANGLES.length]}.`,
            "Title, hook, structure, visuals and script must all come from this angle; other writers cover the other angles, so do not fall back to the obvious take.",
          ]
        : []),
      `Idea: ${dto.idea.trim()}`,
      `Format: ${dto.format ?? VideoFormat.Vertical}`,
      (dto.format ?? VideoFormat.Vertical) === VideoFormat.Horizontal ? CLASSIC_STORY : SHORT_FORM_STORY,
      dto.steer?.trim() && `Steer this round: ${dto.steer.trim()}`,
      dto.avoid?.length && `Already pitched (bring different ones): ${dto.avoid.join(" | ")}`,
      ...kit,
      dto.references?.length && `The user attached ${dto.references.length} reference image(s): ${dto.references.map((_, i) => `ref-${i + 1}${extname(dto.references![i]!)}`).join(", ")} in the current folder. Read each one first and let them shape the concepts.`,
      dto.angle !== undefined
        ? "Give exactly 1 concept."
        : `Give exactly ${dto.count} concept(s), each with a different angle among: ${ANGLES.slice(0, dto.count).join(" | ")}.`,
    ]
      .filter(Boolean)
      .join("\n");
    // Pitches should feel quick: Sonnet with low effort unless the user asks to think more.
    const model = dto.model ?? AgentModel.Sonnet;
    const effort = dto.effort ?? AgentEffort.Low;
    const { text: out, usage } = await this.run(prompt, model, effort, dto.references ?? []);
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    try {
      const concepts = (JSON.parse(json) as { concepts: ConceptDto[] }).concepts;
      return { concepts: concepts.slice(0, dto.angle !== undefined ? 1 : dto.count), usage: usage && usageFrom(usage, "pitch", model, effort) };
    } catch {
      throw new BadGatewayException("the agent did not return valid concepts; try again");
    }
  }

  private run(prompt: string, model: AgentModel, effort: AgentEffort, references: string[]) {
    // Reference images go next to it so Claude can Read (see) them; nothing else is allowed.
    const files = references.map((ref, i) => ({ from: join(MEDIA_DIR, basename(ref)), as: `ref-${i + 1}${extname(ref)}` }));
    return askClaude({ prompt, system: SYSTEM, model, effort, timeoutMs: CONCEPT_TIMEOUT_MS, files });
  }
}
