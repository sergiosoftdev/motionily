import { Type } from "class-transformer";
import { MEDIA_PATH } from "../media";
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  Matches,
  IsMongoId,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { FeedbackKind, VideoFormat } from "./project.schema";
import { VoiceModel } from "../voice/elevenlabs";

/** Reference images per prompt. */
export const MAX_REFERENCES = 8;
/** About an hour of speech. */
export const MAX_FOOTAGE_WORDS = 20_000;
/** Languages the editor transcribes footage in (ISO 639-1, as Whisper takes them). */
export const FOOTAGE_LANGUAGES = ["en", "es", "pt", "fr", "de", "it"] as const;

export class CreateProjectDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  /** Optional starting point; by default the agent designs the look itself from the brief. */
  @IsOptional() @IsString() motionStyle?: string;
  @IsOptional() @IsString() @MaxLength(4000) brief?: string;
  @IsOptional() @IsBoolean() wantsScript?: boolean;
  /** ElevenLabs script chosen in the pitch; the video is built on it. */
  @IsOptional() @IsString() @MaxLength(8000) voiceScript?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_REFERENCES) @Matches(MEDIA_PATH, { each: true }) references?: string[];
  @IsOptional() @IsEnum(VideoFormat) format?: VideoFormat;
  /** Project (brand kit) to put the video in; defaults to the user's first project. */
  @IsOptional() @IsMongoId() brandId?: string;
}

export class UpdateProjectDto {
  @IsOptional() @IsEnum(VideoFormat) format?: VideoFormat;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(4000) brief?: string;
  @IsOptional() @IsBoolean() wantsScript?: boolean;
  @IsOptional() @IsString() @MaxLength(8000) voiceScript?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_REFERENCES) @Matches(MEDIA_PATH, { each: true }) references?: string[];
}

export class SetSlotDto {
  /** A key for single slots, a list for multi slots, null to empty an optional slot. */
  @Allow() value: string | string[] | null;
  /** Only for motion_style: also snap the new box's default bricks into every slot. */
  @IsOptional() @IsBoolean() applyKitDefaults?: boolean;
}

export class SaveSceneDto {
  @IsObject() scene: Record<string, unknown>;
  /** The revision the client last saw. Saving over a newer revision is rejected. */
  @IsInt() @Min(0) baseRevision: number;
}

export class CreateFeedbackDto {
  @IsEnum(FeedbackKind) kind: FeedbackKind;
  @IsOptional() @IsString() @MaxLength(2000) text?: string;
  @IsOptional() @IsNumber() @Min(0) at?: number;
  @IsOptional() @IsString() @MaxLength(80) layerId?: string;
}

/** Claude model aliases accepted by `claude --model`. */
export enum AgentModel {
  Fable = "fable",
  Opus = "opus",
  Sonnet = "sonnet",
  Haiku = "haiku",
}

/** Values accepted by `claude --effort`. */
export enum AgentEffort {
  Low = "low",
  Medium = "medium",
  High = "high",
  XHigh = "xhigh",
  Max = "max",
}

/** How much model the team gets: quality vs cost. "custom" uses model/effort for every role. */
export enum GenerateMode {
  Premium = "premium",
  Balanced = "balanced",
  Economy = "economy",
  Custom = "custom",
}

export class GenerateDto {
  /** Optional request on top of the brief ("make the title bigger"). */
  @IsOptional() @IsString() @MaxLength(2000) instruction?: string;
  @IsOptional() @IsEnum(AgentModel) model?: AgentModel;
  @IsOptional() @IsEnum(AgentEffort) effort?: AgentEffort;
  @IsOptional() @IsEnum(GenerateMode) mode?: GenerateMode;
  /** Continue an interrupted run from where it stopped instead of starting over. */
  @IsOptional() @IsBoolean() resume?: boolean;
  /** Only add the sound effects to the video that is already built. */
  @IsOptional() @IsBoolean() sfxOnly?: boolean;
  /** Images pasted with the request. */
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_REFERENCES) @Matches(MEDIA_PATH, { each: true }) references?: string[];
}

/** Read the video's script aloud with one of the user's ElevenLabs voices. */
export class GenerateVoiceDto {
  @IsString() @Matches(/^[A-Za-z0-9]{8,40}$/) voiceId: string;
  /** Shown as the audio's name. */
  @IsOptional() @IsString() @MaxLength(80) voiceName?: string;
  @IsOptional() @IsIn(Object.values(VoiceModel)) modelId?: VoiceModel;
  /** The script to read; it also becomes the video's script. Defaults to the saved one. */
  @IsOptional() @IsString() @MaxLength(40_000) text?: string;
}

export class FootageWordDto {
  @IsString() @MaxLength(100) text: string;
  @IsNumber() @Min(0) start: number;
  @IsNumber() @Min(0) end: number;
}

/** A clip's transcript, made in the editor (Whisper in the browser). */
export class FootageWordsDto {
  @IsArray() @ArrayMaxSize(MAX_FOOTAGE_WORDS) @ValidateNested({ each: true }) @Type(() => FootageWordDto) words: FootageWordDto[];
}

export class UploadFootageDto {
  @IsOptional() @IsIn(FOOTAGE_LANGUAGES) language?: (typeof FOOTAGE_LANGUAGES)[number];
}
