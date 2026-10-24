import { basename, extname, join } from "node:path";
import { BadGatewayException, Injectable } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsEnum, IsIn, Matches, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { AgentEffort, AgentModel, MAX_REFERENCES } from "../projects/projects.dto";
import { MEDIA_DIR, MEDIA_PATH } from "../media";
import { VideoFormat, type AgentRunUsage } from "../projects/project.schema";
import { usageFrom } from "../projects/generate.service";
import { askAgent } from "../common/agent-once";
import { rolePrompt } from "../common/prompts";

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

const ANGLES = [
  "humor: a relatable everyday situation told with comic timing",
  "myth-busting: correct something the audience already believes about a famous name, event or habit ('X wasn't Y'); prove it in steps, reveal who made the myth, end on where it still lives today",
  "bold kinetic typography driven by the voice, punchy and rhythmic",
  "the product in action: real screens/UI walked through step by step",
  "data and proof: numbers, counters, before/after",
  "a visual metaphor that carries the whole video",
  "emotional micro-story of one person, from problem to relief",
];

type BrandContext = { name: string; notes: string; palettes: unknown[]; assets: { kind: string; name: string; description: string }[] };


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
      rolePrompt((dto.format ?? VideoFormat.Vertical) === VideoFormat.Horizontal ? "story-classic" : "story-short-form", { devices: DEVICES.join(" | ") }),
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
    return askAgent({ prompt, system: rolePrompt("concepts"), model, effort, timeoutMs: CONCEPT_TIMEOUT_MS, files });
  }
}
