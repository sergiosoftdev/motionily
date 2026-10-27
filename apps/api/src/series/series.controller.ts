import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { CurrentUser, TokenScope, type AuthUser } from "../auth/auth";
import { SeriesService } from "./series.service";

const MAX_NOTE = 1000;

class SaveSeriesDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(MAX_NOTE) note?: string;
  /** `seriesBlueprint(scene)` of the video as it is now (@motionily/protocol). */
  @IsObject() blueprint: Record<string, unknown>;
}

class UpdateSeriesDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(MAX_NOTE) note?: string;
}

class ListSeriesQuery {
  @IsOptional() @IsString() brandId?: string;
}

function userOnly(user: AuthUser) {
  if (user.scope !== TokenScope.User) throw new ForbiddenException("only the user can do this");
  return user.id;
}

/** The user's series templates. */
@Controller("series")
export class SeriesController {
  constructor(private readonly series: SeriesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListSeriesQuery) {
    return this.series.list(userOnly(user), q.brandId);
  }

  @Patch(":id")
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: UpdateSeriesDto) {
    return this.series.update(userOnly(user), id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.series.remove(userOnly(user), id);
  }
}

/** A video's side of it: save it as a series, or read the series it is an episode of (its agent too). */
@Controller("projects")
export class ProjectSeriesController {
  constructor(private readonly series: SeriesService) {}

  @Post(":id/series")
  save(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: SaveSeriesDto) {
    return this.series.create(user.id, id, dto);
  }

  @Get(":id/series")
  async of(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return { series: await this.series.ofProject(user.id, id) };
  }
}
