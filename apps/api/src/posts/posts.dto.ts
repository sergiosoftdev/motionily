import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsEnum, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from "class-validator";
import { Platform, PostStatus } from "./post.schema";

/** Both platforms cap a caption at 2,200 characters. */
export const MAX_CAPTION = 2200;
/** Instagram allows 30 hashtags; a handful works better anyway. */
export const MAX_HASHTAGS = 30;
/** `?due=1`: only scheduled posts whose time has come. */
export const DUE_ONLY = "1";
/** A hashtag without its "#": letters (any script), digits and underscores. */
const HASHTAG = /^[\p{L}\p{N}_]{1,100}$/u;

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
  @IsArray() @ArrayMaxSize(2) @ValidateNested({ each: true }) @Type(() => PostCopyDto) copy: PostCopyDto[];
}

export class UpdatePostDto {
  @IsOptional() @IsDateString() scheduledAt?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsEnum(Platform, { each: true }) platforms?: Platform[];
  @IsOptional() @IsArray() @ArrayMaxSize(2) @ValidateNested({ each: true }) @Type(() => PostCopyDto) copy?: PostCopyDto[];
  @IsOptional() @IsEnum(PostStatus) status?: PostStatus;
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
