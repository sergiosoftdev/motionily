import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { BadRequestException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { InjectModel } from "@nestjs/mongoose";
import { diskStorage } from "multer";
import { Model } from "mongoose";
import sharp from "sharp";
import { CurrentUser, TokenScope, type AuthUser } from "../auth/auth";
import { MEDIA_DIR, mediaName, removeMedia } from "../media";
import { MediaKind, Project, type MediaItem } from "./project.schema";
import { ProjectsService } from "./projects.service";

const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const run = promisify(execFile);

/** What the media pool takes besides video clips (those go to /footage, which transcribes them). */
const KIND_OF: Record<string, MediaKind> = {
  "audio/mpeg": MediaKind.Audio,
  "audio/mp3": MediaKind.Audio,
  "audio/wav": MediaKind.Audio,
  "audio/x-wav": MediaKind.Audio,
  "audio/wave": MediaKind.Audio,
  "audio/mp4": MediaKind.Audio,
  "audio/x-m4a": MediaKind.Audio,
  "audio/aac": MediaKind.Audio,
  "audio/ogg": MediaKind.Audio,
  "audio/flac": MediaKind.Audio,
  "audio/webm": MediaKind.Audio,
  "image/png": MediaKind.Image,
  "image/jpeg": MediaKind.Image,
  "image/webp": MediaKind.Image,
  "image/gif": MediaKind.Image,
};
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

/** Seconds of a sound file (null when ffprobe is missing or cannot read it). */
async function audioSeconds(file: string): Promise<number | null> {
  try {
    const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    const s = Number(stdout.trim());
    return Number.isFinite(s) && s > 0 ? +s.toFixed(3) : null;
  } catch {
    return null;
  }
}

/**
 * A video's media pool, besides its clips: songs, sound and voice files, photos and graphics the user
 * brings in, to drop on the timeline. Video clips keep their own route (/footage) for transcription.
 */
@Controller("projects")
export class MediaPoolController {
  constructor(
    private readonly projects: ProjectsService,
    @InjectModel(Project.name) private readonly model: Model<Project>,
  ) {}

  @Get(":id/media")
  async list(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return (await this.projects.get(user.id, id)).media ?? [];
  }

  @Post(":id/media")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: MEDIA_DIR, filename: (_req, f, cb) => cb(null, mediaName(f.originalname || "media.bin")) }),
      limits: { fileSize: MAX_MEDIA_BYTES },
      fileFilter: (_req, f, cb) => cb(null, f.mimetype in KIND_OF),
    }),
  )
  async upload(@CurrentUser() user: AuthUser, @Param("id") id: string, @UploadedFile() file?: Express.Multer.File) {
    if (user.scope && user.scope !== TokenScope.User) throw new ForbiddenException("only the user can do this");
    if (!file) throw new BadRequestException("send a sound (mp3, wav, m4a, ogg, flac) or an image (png, jpg, webp, gif) in 'file'; videos go to /footage");
    try {
      const project = await this.projects.get(user.id, id);
      const kind = KIND_OF[file.mimetype]!;
      const path = join(MEDIA_DIR, file.filename);
      const meta = kind === MediaKind.Image ? await sharp(path).metadata().catch(() => null) : null;
      const taken = (project.media ?? []).map((m) => Number(m.id.slice(1)) || 0);
      const item: MediaItem = {
        id: `m${Math.max(0, ...taken) + 1}`,
        kind,
        file: file.filename,
        url: `/media/${file.filename}`,
        name: file.originalname,
        mime: file.mimetype,
        size: file.size,
        duration: kind === MediaKind.Audio ? await audioSeconds(path) : null,
        width: meta?.width ?? null,
        height: meta?.height ?? null,
      };
      await this.model.updateOne({ _id: project._id }, { $push: { media: item } });
      return item;
    } catch (e) {
      await removeMedia(file.filename);
      throw e;
    }
  }

  @Delete(":id/media/:mediaId")
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("mediaId") mediaId: string) {
    if (user.scope && user.scope !== TokenScope.User) throw new ForbiddenException("only the user can do this");
    const project = await this.projects.get(user.id, id);
    const item = (project.media ?? []).find((m) => m.id === mediaId);
    if (!item) throw new NotFoundException(`no media '${mediaId}' in this video`);
    await this.model.updateOne({ _id: project._id }, { $pull: { media: { id: mediaId } } });
    // The file stays while a layer still uses it (undo, other clips); unused uploads are cheap to keep.
    if (!JSON.stringify(project.scene ?? {}).includes(item.url)) await removeMedia(item.file);
    return { ok: true };
  }
}
