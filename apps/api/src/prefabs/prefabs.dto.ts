import { IsEnum, IsObject, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { PrefabKind } from "./prefab.schema";

/** Prefab names are snake_case, like brick ids. */
export const PREFAB_NAME = /^[a-z0-9_]{2,40}$/;

export class SavePrefabDto {
  @IsEnum(PrefabKind) kind: PrefabKind;
  @IsObject() node: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(400) description?: string;
}

export class ClonePrefabDto {
  @Matches(PREFAB_NAME) name: string;
  @IsOptional() @IsString() @MaxLength(400) description?: string;
}
