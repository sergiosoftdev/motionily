import { Type } from "class-transformer";
import { IsArray, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from "class-validator";
import { AssetKind } from "./brand.schema";

const HEX = /^#[0-9a-fA-F]{6}$/;

export class BrandPaletteDto {
  @IsString() @MaxLength(60) name: string;
  @Matches(HEX) background: string;
  @Matches(HEX) surface: string;
  @Matches(HEX) primary: string;
  @Matches(HEX) accent: string;
  @Matches(HEX) text: string;
}

export class CreateBrandDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class UpdateBrandDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BrandPaletteDto) palettes?: BrandPaletteDto[];
}

export class AssetMetaDto {
  @IsOptional() @IsEnum(AssetKind) kind?: AssetKind;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}
