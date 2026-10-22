import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { CurrentUser, type AuthUser } from "../auth/auth";
import { MEDIA_PATH } from "../media";
import { ProjectsService } from "../projects/projects.service";
import { AssetKind, Orientation } from "./asset-types";
import { AssetsService } from "./assets.service";
import { libraryRow, LibraryQuery, LibraryService } from "./library";

const MAX_QUERIES = 10;
const MAX_PER_QUERY = 12;
const DEFAULT_PER_QUERY = 8;
const MAX_IMPORTS = 16;
const MAX_ICON_IDS = 60;

class AssetQuery {
  @IsString() @MinLength(2) @MaxLength(120) q: string;
  @IsEnum(AssetKind) kind: AssetKind;
}

class SearchAssetsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_QUERIES) @ValidateNested({ each: true }) @Type(() => AssetQuery) queries: AssetQuery[];
  @IsOptional() @IsInt() @Min(1) @Max(MAX_PER_QUERY) perQuery?: number;
}

class ImportAssetsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_IMPORTS) @IsString({ each: true }) @MaxLength(300, { each: true }) ids: string[];
  /** The words the agent searched with: they make the library findable later. */
  @IsOptional() @IsString() @MaxLength(300) query?: string;
}

class CutoutDto {
  @Matches(MEDIA_PATH) src: string;
}

class GenerateImageDto {
  @IsString() @MinLength(8) @MaxLength(4000) prompt: string;
  @IsOptional() @IsBoolean() transparent?: boolean;
  @IsOptional() @IsEnum(Orientation) orientation?: Orientation;
}

class IconsQuery {
  @IsString() @MinLength(1) @MaxLength(120) q: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(96) limit?: number;
}

class IconDataQuery {
  @Transform(({ value }: { value: string }) => String(value).split(",").filter(Boolean))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ICON_IDS)
  @IsString({ each: true })
  ids: string[];
}

/** Material for a video: search every library, import (into the video and the user's library), cut out, generate. */
@Controller("projects/:id/assets")
export class AssetsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly assets: AssetsService,
    private readonly library: LibraryService,
  ) {}

  @Post("search")
  async search(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: SearchAssetsDto) {
    const project = await this.projects.get(user.id, id);
    return this.assets.search(user.id, project, dto.queries, dto.perQuery ?? DEFAULT_PER_QUERY);
  }

  @Post("import")
  async import(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: ImportAssetsDto) {
    const project = await this.projects.get(user.id, id);
    return this.assets.import(user.id, project, dto.ids, dto.query);
  }

  @Post("cutout")
  async cutout(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: CutoutDto) {
    const project = await this.projects.get(user.id, id);
    return this.assets.cutout(user.id, project, dto.src);
  }

  @Post("generate")
  async generate(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: GenerateImageDto) {
    const project = await this.projects.get(user.id, id);
    return this.assets.generate(user.id, project, dto.prompt, dto.transparent ?? false, dto.orientation);
  }

  @Get("library")
  async listLibrary(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query() query: LibraryQuery) {
    await this.projects.get(user.id, id);
    return (await this.library.list(user.id, query.kind, query.limit)).map(libraryRow);
  }

  @Get("icons")
  async icons(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query() query: IconsQuery) {
    await this.projects.get(user.id, id);
    return this.assets.icons(query.q, query.limit ?? 24);
  }

  @Get("icon-data")
  async iconData(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query() query: IconDataQuery) {
    const project = await this.projects.get(user.id, id);
    return this.assets.iconData(project, query.ids);
  }
}
