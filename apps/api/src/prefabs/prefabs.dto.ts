import { IsEnum, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { AgentEffort, AgentModel } from "../projects/projects.dto";
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

export class EditPrefabDto {
  @IsString() @MinLength(2) @MaxLength(2000) instruction: string;
  @IsOptional() @IsEnum(AgentModel) model?: AgentModel;
  @IsOptional() @IsEnum(AgentEffort) effort?: AgentEffort;
}
