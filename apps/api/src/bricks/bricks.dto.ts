import { IsArray, IsEnum, IsObject, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { BrickSlot } from "./brick.enums";

export class ListBricksQuery {
  @IsOptional() @IsEnum(BrickSlot) slot?: BrickSlot;
  /** Motion style key, e.g. "motion_style/anime": returns bricks that fit it. */
  @IsOptional() @IsString() fits?: string;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
}

export class CreateBrickDto {
  @IsEnum(BrickSlot) slot: BrickSlot;
  /** snake_case name; the key becomes `${slot}/${id}`. */
  @Matches(/^[a-z0-9_]{2,40}$/) id: string;
  @IsString() @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(400) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) fits?: string[];
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
}
