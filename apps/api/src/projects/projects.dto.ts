import {
  Allow,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { FeedbackKind, VideoFormat } from "./project.schema";

export class CreateProjectDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  /** Key of the motion style "box", e.g. "motion_style/startup". */
  @IsString() motionStyle: string;
  @IsOptional() @IsString() @MaxLength(4000) brief?: string;
  @IsOptional() @IsEnum(VideoFormat) format?: VideoFormat;
}

export class UpdateProjectDto {
  @IsOptional() @IsEnum(VideoFormat) format?: VideoFormat;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(4000) brief?: string;
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

export class GenerateDto {
  /** Optional request on top of the brief ("make the title bigger"). */
  @IsOptional() @IsString() @MaxLength(2000) instruction?: string;
}
