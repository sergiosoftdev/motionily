import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { BadRequestException, Body, Controller, ForbiddenException, Param, Post } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { IsString, MinLength } from "class-validator";
import { Model } from "mongoose";
import { CurrentUser, TokenScope, type AuthUser } from "../auth/auth";
import { BrandsService } from "../brands/brands.service";
import { MEDIA_DIR } from "../media";
import { Project } from "./project.schema";
import { ProjectsService } from "./projects.service";

/** A project saved as a folder: `<name>.motionily/project.json` plus `media/` with every file it uses. */
const FOLDER_EXT = ".motionily";
const MANIFEST = "project.json";
const FOLDER_VERSION = 1;
/** Media paths inside a project (uploads are random UUID names). */
const MEDIA_REF = /\/media\/([a-f0-9-]{36}\.[a-z0-9]{1,5})/g;
/** What a folder keeps: the video, its sound and its writing. Usage logs, live runs and owners stay local. */
const KEPT_FIELDS = ["name", "brief", "wantsScript", "voiceScript", "references", "build", "format", "scene", "audio", "music", "sunoPrompt", "postCopy", "footage", "media", "imageCredits", "direction", "constraints"] as const;

class FolderDto {
  /** Absolute path of a folder on this machine. */
  @IsString() @MinLength(1) path: string;
}

/** Every uploaded file a project document points at. */
function mediaFiles(doc: unknown): string[] {
  return [...new Set([...JSON.stringify(doc).matchAll(MEDIA_REF)].map((m) => m[1]!))];
}

/**
 * Projects as folders on disk, so a video can be backed up, moved to another machine or shared, and
 * opened again. Desktop app only: the API reads and writes local paths, which only makes sense when
 * it runs on the user's own machine.
 */
@Controller("projects")
export class ProjectFolderController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly brands: BrandsService,
    @InjectModel(Project.name) private readonly model: Model<Project>,
  ) {}

  private guard(user: AuthUser, path: string) {
    if (process.env.MOTIONILY_DESKTOP !== "1") throw new ForbiddenException("project folders are available in the desktop app");
    if (user.scope && user.scope !== TokenScope.User) throw new ForbiddenException("only the user can do this");
    if (!isAbsolute(path)) throw new BadRequestException("the folder must be an absolute path");
  }

  /** Writes the project into `<path>/<name>.motionily/` (numbered when taken); returns that folder. */
  @Post(":id/folder")
  async save(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: FolderDto) {
    this.guard(user, dto.path);
    const project = (await this.projects.get(user.id, id)).toObject();
    const kept = Object.fromEntries(KEPT_FIELDS.map((k) => [k, project[k]]));
    const safe = project.name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Motionily video";
    let folder = join(dto.path, `${safe}${FOLDER_EXT}`);
    for (let n = 2; existsSync(folder); n++) folder = join(dto.path, `${safe} ${n}${FOLDER_EXT}`);
    mkdirSync(join(folder, "media"), { recursive: true });
    const files = mediaFiles(kept);
    for (const f of files) if (existsSync(join(MEDIA_DIR, f))) copyFileSync(join(MEDIA_DIR, f), join(folder, "media", f));
    writeFileSync(join(folder, MANIFEST), JSON.stringify({ motionily: FOLDER_VERSION, savedAt: new Date().toISOString(), project: kept }, null, 2));
    return { folder, media: files.length };
  }

  /** Opens a `.motionily` folder as a new project in the user's default brand kit. */
  @Post("import-folder")
  async open(@CurrentUser() user: AuthUser, @Body() dto: FolderDto) {
    this.guard(user, dto.path);
    const manifest = join(dto.path, MANIFEST);
    if (!existsSync(manifest)) throw new BadRequestException(`${basename(dto.path)} is not a Motionily project folder (no ${MANIFEST})`);
    let data: { motionily?: number; project?: Record<string, unknown> };
    try {
      data = JSON.parse(readFileSync(manifest, "utf8")) as typeof data;
    } catch {
      throw new BadRequestException(`${MANIFEST} is not valid JSON`);
    }
    if (!data.project || typeof data.project !== "object") throw new BadRequestException(`${MANIFEST} has no project`);
    if ((data.motionily ?? 0) > FOLDER_VERSION) throw new BadRequestException("this folder was saved by a newer Motionily; update the app");
    const media = join(dto.path, "media");
    if (existsSync(media)) {
      mkdirSync(MEDIA_DIR, { recursive: true });
      // Upload names are unique: a file already here is the same file.
      for (const f of readdirSync(media)) if (/^[a-f0-9-]{36}\.[a-z0-9]{1,5}$/.test(f) && !existsSync(join(MEDIA_DIR, f))) copyFileSync(join(media, f), join(MEDIA_DIR, f));
    }
    const brand = await this.brands.ensureDefault(user.id);
    const fields = Object.fromEntries(KEPT_FIELDS.filter((k) => k in data.project!).map((k) => [k, data.project![k]]));
    const created = await this.model.create({ ...fields, name: String(fields.name ?? "Imported video"), ownerId: user.id, brandId: brand._id, sceneRevision: 0 });
    return { id: String(created._id), name: created.name };
  }
}
