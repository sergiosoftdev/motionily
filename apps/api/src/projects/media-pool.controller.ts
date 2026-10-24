import { execFile } from "node:child_process";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { FileInterceptor } from "@nestjs/platform-express";
import { InjectModel } from "@nestjs/mongoose";
import { diskStorage } from "multer";
import { Model } from "mongoose";
import sharp from "sharp";
import { CurrentUser, TokenScope, type AuthUser } from "../auth/auth";
import { MEDIA_DIR, mediaName, removeMedia } from "../media";
import { MediaKind, Project, type MediaItem } from "./project.schema";
import { describeVideo, VIDEO_TYPES } from "../brands/video-asset";
import { ProjectsService } from "./projects.service";
import { BridgeHub } from "../bridge-hub";

const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const run = promisify(execFile);

/** `.cube` files have no registered type; the pool names them this. */
const LUT_MIME = "application/x-cube-lut";
const isCube = (name: string) => extname(name).toLowerCase() === ".cube";

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
  [LUT_MIME]: MediaKind.Lut,
};
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
/** Rendered videos the browser editor hands back for an agent's export. */
const RENDER_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
const MAX_RENDER_BYTES = 2 * 1024 * 1024 * 1024;
/** Type by extension, for local files and URLs that do not say. */
const BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".cube": LUT_MIME,
};

class ImportMediaDto {
  /** An http(s) URL, or (desktop app) an absolute path on this machine. */
  @IsString() @MinLength(1) @MaxLength(4000) source: string;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
}

/** The user, the video's agent or its headless editor may change the pool; account tokens may not. */
function poolWriter(user: AuthUser) {
  if (user.scope === TokenScope.Account) throw new ForbiddenException("use the video's own token");
}

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
      fileFilter: (_req, f, cb) => cb(null, f.mimetype in KIND_OF || isCube(f.originalname)),
    }),
  )
  async upload(@CurrentUser() user: AuthUser, @Param("id") id: string, @UploadedFile() file?: Express.Multer.File) {
    poolWriter(user);
    if (!file) throw new BadRequestException("send a sound (mp3, wav, m4a, ogg, flac), an image (png, jpg, webp, gif) or a LUT (.cube) in 'file'; videos go to /footage");
    try {
      return await this.add(user, id, file.filename, file.originalname, isCube(file.originalname) ? LUT_MIME : file.mimetype, file.size);
    } catch (e) {
      await removeMedia(file.filename);
      throw e;
    }
  }

  /** A stored file joins the pool: sounds and pictures as media items, videos as footage (clips). */
  private async add(user: AuthUser, id: string, filename: string, name: string, mime: string, size: number): Promise<MediaItem | { footage: string }> {
    const project = await this.projects.get(user.id, id);
    const path = join(MEDIA_DIR, filename);
    if (VIDEO_TYPES.includes(mime)) {
      const facts = await describeVideo(path);
      const p = await this.projects.addFootage(user.id, id, {
        file: filename, name, mime, size,
        duration: facts?.duration ?? null, width: facts?.width ?? null, height: facts?.height ?? null, poster: facts?.poster ?? null,
        language: "en", words: null,
      });
      this.changed(user, id);
      return { footage: p.footage.at(-1)!.id };
    }
    const kind = KIND_OF[mime];
    if (!kind) throw new BadRequestException(`${name}: not a sound, picture, LUT or video Motionily takes`);
    if (kind === MediaKind.Lut) {
      const head = (await readFile(path, "utf8")).slice(0, 65536);
      if (!/^\s*LUT_(3D|1D)_SIZE\s+\d+/m.test(head)) throw new BadRequestException(`${name}: not a .cube LUT (no LUT_3D_SIZE line)`);
    }
    const meta = kind === MediaKind.Image ? await sharp(path).metadata().catch(() => null) : null;
    const taken = (project.media ?? []).map((m) => Number(m.id.slice(1)) || 0);
    const item: MediaItem = {
      id: `m${Math.max(0, ...taken) + 1}`,
      kind,
      file: filename,
      url: `/media/${filename}`,
      name,
      mime,
      size,
      duration: kind === MediaKind.Audio ? await audioSeconds(path) : null,
      width: meta?.width ?? null,
      height: meta?.height ?? null,
    };
    await this.model.updateOne({ _id: project._id }, { $push: { media: item } });
    this.changed(user, id);
    return item;
  }

  /** The editor reloads its pool when the agent changed it. */
  private changed(user: AuthUser, id: string) {
    if (user.scope === TokenScope.Agent) BridgeHub.instance?.notifyProjectChanged(id);
  }

  /**
   * Bring a file into the pool from a URL (http/https), or from a path on this machine in the desktop
   * app: what agents use, since they cannot drag files in.
   */
  @Post(":id/media/import")
  async importMedia(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: ImportMediaDto) {
    poolWriter(user);
    await this.projects.get(user.id, id);
    const local = isAbsolute(dto.source) && !/^https?:/i.test(dto.source);
    if (local && process.env.MOTIONILY_DESKTOP !== "1") throw new BadRequestException("local paths work in the desktop app; give an http(s) URL");
    if (!local && !/^https?:\/\//i.test(dto.source)) throw new BadRequestException("source must be an http(s) URL or, in the desktop app, an absolute path");
    let mime: string;
    let filename: string;
    let size: number;
    let name = dto.name ?? basename(dto.source.split("?")[0] ?? "media");
    if (local) {
      const st = await stat(dto.source).catch(() => null);
      if (!st?.isFile()) throw new BadRequestException(`no file at ${dto.source}`);
      if (st.size > MAX_MEDIA_BYTES) throw new BadRequestException("files are limited to 200 MB");
      mime = BY_EXT[extname(dto.source).toLowerCase()] ?? "";
      filename = mediaName(dto.source);
      await copyFile(dto.source, join(MEDIA_DIR, filename));
      size = st.size;
    } else {
      const res = await fetch(dto.source, { redirect: "follow" });
      if (!res.ok) throw new BadRequestException(`could not download it: HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_MEDIA_BYTES) throw new BadRequestException("files are limited to 200 MB");
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_MEDIA_BYTES) throw new BadRequestException("files are limited to 200 MB");
      mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
      if (!(mime in KIND_OF) && !VIDEO_TYPES.includes(mime)) mime = BY_EXT[extname(name).toLowerCase()] ?? mime;
      filename = mediaName(name.includes(".") ? name : `${name}${Object.entries(BY_EXT).find(([, m]) => m === mime)?.[0] ?? ".bin"}`);
      await writeFile(join(MEDIA_DIR, filename), bytes);
      size = bytes.length;
    }
    if (!name.trim()) name = filename;
    try {
      return await this.add(user, id, filename, name, mime, size);
    } catch (e) {
      await removeMedia(filename);
      throw e;
    }
  }

  /** A finished export from the browser editor, so the agent that asked for it gets a URL back. */
  @Post(":id/renders")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: MEDIA_DIR, filename: (_req, f, cb) => cb(null, mediaName(f.originalname || "render.mp4")) }),
      limits: { fileSize: MAX_RENDER_BYTES },
      fileFilter: (_req, f, cb) => cb(null, RENDER_TYPES.includes(f.mimetype)),
    }),
  )
  async render(@CurrentUser() user: AuthUser, @Param("id") id: string, @UploadedFile() file?: Express.Multer.File) {
    poolWriter(user);
    if (!file) throw new BadRequestException("send the rendered video (mp4, webm or mov) in 'file'");
    await this.projects.get(user.id, id);
    return { url: `/media/${file.filename}`, size: file.size };
  }

  @Delete(":id/media/:mediaId")
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("mediaId") mediaId: string) {
    poolWriter(user);
    const project = await this.projects.get(user.id, id);
    const item = (project.media ?? []).find((m) => m.id === mediaId);
    if (!item) throw new NotFoundException(`no media '${mediaId}' in this video`);
    await this.model.updateOne({ _id: project._id }, { $pull: { media: { id: mediaId } } });
    this.changed(user, id);
    // The file stays while a layer still uses it (undo, other clips); unused uploads are cheap to keep.
    if (!JSON.stringify(project.scene ?? {}).includes(item.url)) await removeMedia(item.file);
    return { ok: true };
  }
}
