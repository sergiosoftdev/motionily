import { Body, Controller, Get, Injectable, Param, Put } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { Model, Types } from "mongoose";
import { CurrentUser, type AuthUser } from "../auth/auth";
import { Project, type ProjectDocument } from "../projects/project.schema";
import { ProjectsService } from "../projects/projects.service";
import { CONSTRAINT_MEMORY, CONSTRAINTS, CONSTRAINTS_PER_VIDEO, Genre, REFERENCE_FILMS, REFERENCES_PER_DIRECTION, type ReferenceFilm } from "./direction-data";

/** What the agent declares about a video's look before building it. */
export type Direction = { genre: Genre; concept: string; techniques: string[]; setAt: string };

/** How an earlier video of the account looked, so the next one goes elsewhere. */
export type Fingerprint = { name: string; genre: Genre | null; concept: string | null; techniques: string[]; font: string | null; primary: string | null; background: string | null; constraints: string[] };

/** Earlier videos compared against. */
const RECENT = 6;

class DirectionDto {
  @IsEnum(Genre) genre: Genre;
  @IsString() @MinLength(10) @MaxLength(400) concept: string;
  @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(120, { each: true }) techniques: string[];
  /** Draw new constraints (a fresh take on the same video). */
  @IsOptional() @IsBoolean() redraw?: boolean;
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

@Injectable()
export class DirectionService {
  constructor(@InjectModel(Project.name) private readonly projects: Model<Project>) {}

  /** The account's latest other videos that have a scene, newest first. */
  async recent(ownerId: Types.ObjectId, exceptId: string): Promise<Fingerprint[]> {
    const rows = await this.projects
      .find({ ownerId, _id: { $ne: new Types.ObjectId(exceptId) }, scene: { $ne: null } })
      .select({ name: 1, direction: 1, constraints: 1, "scene.typography": 1, "scene.palette": 1 })
      .sort({ updatedAt: -1 })
      .limit(RECENT)
      .lean<Pick<Project, "name" | "direction" | "constraints" | "scene">[]>();
    return rows.map((p) => {
      const scene = p.scene as { typography?: { family?: string }; palette?: { primary?: string; background?: string } } | null;
      return {
        name: p.name,
        genre: p.direction?.genre ?? null,
        concept: p.direction?.concept ?? null,
        techniques: p.direction?.techniques ?? [],
        font: scene?.typography?.family ?? null,
        primary: scene?.palette?.primary ?? null,
        background: scene?.palette?.background ?? null,
        constraints: p.constraints ?? [],
      };
    });
  }

  /** Two constraints not used by the last few videos. */
  draw(recent: Fingerprint[]): string[] {
    const used = new Set(recent.slice(0, CONSTRAINT_MEMORY).flatMap((r) => r.constraints));
    const fresh = CONSTRAINTS.filter((c) => !used.has(c));
    return shuffle(fresh.length >= CONSTRAINTS_PER_VIDEO ? fresh : CONSTRAINTS).slice(0, CONSTRAINTS_PER_VIDEO);
  }

  references(genre: Genre): ReferenceFilm[] {
    return shuffle(REFERENCE_FILMS.filter((r) => r.genre === genre)).slice(0, REFERENCES_PER_DIRECTION);
  }

  async set(ownerId: Types.ObjectId, project: ProjectDocument, dto: DirectionDto) {
    const recent = await this.recent(ownerId, project.id);
    const direction: Direction = { genre: dto.genre, concept: dto.concept.trim(), techniques: dto.techniques.map((t) => t.trim()).filter(Boolean), setAt: new Date().toISOString() };
    const constraints = dto.redraw || !project.constraints?.length ? this.draw(recent) : project.constraints;
    await this.projects.updateOne({ _id: project._id }, { $set: { direction, constraints } });
    return { direction, constraints, references: this.references(dto.genre), recent };
  }
}

/** A video's art direction: genre, concept, techniques; plus the constraints it drew and what the account did lately. */
@Controller("projects/:id/direction")
export class DirectionController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly direction: DirectionService,
  ) {}

  @Get()
  async get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const project = await this.projects.get(user.id, id);
    return { direction: project.direction ?? null, constraints: project.constraints ?? [], recent: await this.direction.recent(user.id, id), genres: Object.values(Genre) };
  }

  @Put()
  async set(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: DirectionDto) {
    const project = await this.projects.get(user.id, id);
    return this.direction.set(user.id, project, dto);
  }
}
