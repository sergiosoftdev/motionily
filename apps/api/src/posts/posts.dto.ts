import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsEnum, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from "class-validator";
import { Platform, PostStatus } from "./post.schema";

/** Instagram and TikTok cap a caption at 2,200 characters (YouTube allows more; one limit for all). */
export const MAX_CAPTION = 2200;
/** A post's texts: at most one per platform. */
export const PLATFORM_COUNT = Object.values(Platform).length;
/** Instagram allows 30 hashtags; a handful works better anyway. */
export const MAX_HASHTAGS = 30;
/** `?due=1`: only scheduled posts whose time has come. */
export const DUE_ONLY = "1";
/** A hashtag without its "#": letters (any script), digits and underscores. */
const HASHTAG = /^[\p{L}\p{N}_]{1,100}$/u;
/** A hook variant's name, as layers carry it ("A", "B"…). */
const VARIANT = /^[A-Za-z0-9]{1,8}$/;

export class PostCopyDto {
  @IsEnum(Platform) platform: Platform;
  @IsString() @MaxLength(MAX_CAPTION) caption: string;
  @IsArray() @ArrayMaxSize(MAX_HASHTAGS) @Matches(HASHTAG, { each: true }) hashtags: string[];
}

export class WriteCopyDto {
  @IsMongoId() projectId: string;
  @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsEnum(Platform, { each: true }) platforms: Platform[];
  /** What to change from the last draft ("shorter", "no emojis"). */
  @IsOptional() @IsString() @MaxLength(500) steer?: string;
}

export class CreatePostDto {
  @IsMongoId() projectId: string;
  @IsDateString() scheduledAt: string;
  @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsEnum(Platform, { each: true }) platforms: Platform[];
  @IsArray() @ArrayMaxSize(PLATFORM_COUNT) @ValidateNested({ each: true }) @Type(() => PostCopyDto) copy: PostCopyDto[];
  /** The hook variant the file plays (videos with several openings). */
  @IsOptional() @Matches(VARIANT) variant?: string | null;
}

export class UpdatePostDto {
  @IsOptional() @IsDateString() scheduledAt?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsEnum(Platform, { each: true }) platforms?: Platform[];
  @IsOptional() @IsArray() @ArrayMaxSize(PLATFORM_COUNT) @ValidateNested({ each: true }) @Type(() => PostCopyDto) copy?: PostCopyDto[];
  @IsOptional() @IsEnum(PostStatus) status?: PostStatus;
  @IsOptional() @Matches(VARIANT) variant?: string | null;
}

export class UploadPostVideoDto {
  /** Scene revision the file was rendered from. */
  @Type(() => Number) @IsInt() @Min(0) sceneRevision: number;
}

export class ListPostsQuery {
  @IsOptional() @IsMongoId() projectId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn([DUE_ONLY]) due?: typeof DUE_ONLY;
}
