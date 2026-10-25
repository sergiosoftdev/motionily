import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
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
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
/** RNNoise's own speech model (Xiph, BSD-3-Clause), for voice isolation. */
const RNNOISE_MODEL = [join(__dirname, "..", "..", "models"), join(__dirname, "..", "..", "..", "models")].map((d) => join(d, "rnnoise-std.rnnn")).find((f) => existsSync(f)) ?? "rnnoise-std.rnnn";

/** How a sound is cleaned: `denoise` lowers steady noise (hiss, hum, fans); `voice` keeps speech and drops the rest (RNNoise). */
export const CleanMode = { Denoise: "denoise", Voice: "voice" } as const;
export type CleanMode = (typeof CleanMode)[keyof typeof CleanMode];
/** The voice-over (the project's audio) as a clean_audio source. */
const VOICE_SOURCE = "voice";
/** FFT noise reduction (dB) at strength 0 and 1. */
const DENOISE_DB: [number, number] = [6, 36];
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

class CleanAudioDto {
  /** A sound or clip of this video (`/media/…`), or `voice` for the voice-over. */
  @IsString() @MinLength(1) @MaxLength(200) source: string;
  @IsIn(Object.values(CleanMode)) mode: CleanMode;
  /** 0..1 (default 0.5): how hard `denoise` works; `voice` mixes the original back in below 1. */
  @IsOptional() @IsNumber() @Min(0) @Max(1) strength?: number;
}

class StabilizeDto {
  /** A clip of this video (`/media/…`, from list_media). */
  @IsString() @MinLength(1) @MaxLength(200) source: string;
  /** 0..1 (default 0.5): how much of the camera's own motion is smoothed away (0.5 ≈ a 1 s window). */
  @IsOptional() @IsNumber() @Min(0) @Max(1) strength?: number;
}

/** Frames vidstab averages the camera path over at strength 0 and 1. */
const SMOOTHING: [number, number] = [6, 60];

/** Whether this ffmpeg has vid.stab (the desktop app's does; some builds only have deshake). */
let vidstab: Promise<boolean> | null = null;
function hasVidstab(): Promise<boolean> {
  vidstab ??= run(FFMPEG, ["-hide_banner", "-filters"]).then((r) => r.stdout.includes("vidstabdetect"), () => false);
  return vidstab;
}

/** The ffmpeg filter for a cleaning (paths escaped for the filter syntax). */
function cleanFilter(mode: CleanMode, strength: number): string {
  if (mode === CleanMode.Denoise) {
    const nr = DENOISE_DB[0] + (DENOISE_DB[1] - DENOISE_DB[0]) * strength;
    return `afftdn=nr=${nr.toFixed(1)}:nf=-50:tn=1`;
  }
  const model = RNNOISE_MODEL.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  return `arnndn=m='${model}':mix=${strength.toFixed(2)}`;
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

  /**
   * A cleaned copy of a sound (non-destructive): the result joins the pool as a new sound; for the voice-over
   * it replaces the voice (timing, words and cuts stay, the file is the same length) and the original joins
   * the pool, so it can come back.
   */
  @Post(":id/media/clean")
  async clean(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: CleanAudioDto) {
    poolWriter(user);
    const project = await this.projects.get(user.id, id);
    const voice = dto.source === VOICE_SOURCE;
    const fromPool = (project.media ?? []).find((m) => m.url === dto.source && m.kind === MediaKind.Audio);
    const fromClips = (project.footage ?? []).find((c) => `/media/${c.file}` === dto.source);
    const file = voice ? project.audio?.file : (fromPool?.file ?? fromClips?.file);
    if (!file) throw new BadRequestException(voice ? "this video has no voice-over" : `${dto.source} is not a sound or a clip of this video (list_media shows them)`);
    const label = voice ? (project.audio?.name ?? "Voice-over") : (fromPool?.name ?? fromClips?.name ?? "sound");
    const out = mediaName(`${label}.wav`);
    const strength = dto.strength ?? (dto.mode === CleanMode.Voice ? 1 : 0.5);
    try {
      // 48 kHz, the source's channels, 16-bit WAV: lossless for further editing.
      await run(FFMPEG, ["-v", "error", "-y", "-i", join(MEDIA_DIR, file), "-vn", "-af", cleanFilter(dto.mode, strength), "-ar", "48000", "-c:a", "pcm_s16le", join(MEDIA_DIR, out)], { maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      await removeMedia(out);
      throw new BadRequestException(`ffmpeg could not clean it: ${(e as { stderr?: string }).stderr?.trim() || String(e)}`);
    }
    const what = dto.mode === CleanMode.Voice ? "voice isolated" : "denoised";
    const size = (await stat(join(MEDIA_DIR, out))).size;
    if (!voice) return this.add(user, id, out, `${label} (${what})`, "audio/wav", size);
    // The voice-over: the cleaned file takes its place; the original goes to the pool.
    const original = await this.add(user, id, file, `${label} (before cleaning)`, project.audio!.mime, (await stat(join(MEDIA_DIR, file))).size);
    await this.model.updateOne({ _id: project._id }, { $set: { audio: { ...project.audio!, file: out, mime: "audio/wav" } } });
    BridgeHub.instance?.notifyProjectChanged(id);
    return { voice: `/media/${out}`, original };
  }

  /**
   * A stabilized copy of a clip (non-destructive): vid.stab's two passes (motion measured, then the camera
   * path smoothed; borders filled by a slight zoom), or ffmpeg's deshake where vid.stab is missing. The
   * copy is a new clip with the same length, sound and transcript, to swap in (Replace).
   */
  @Post(":id/media/stabilize")
  async stabilize(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: StabilizeDto) {
    poolWriter(user);
    const project = await this.projects.get(user.id, id);
    const clip = (project.footage ?? []).find((c) => `/media/${c.file}` === dto.source);
    if (!clip) throw new BadRequestException(`${dto.source} is not a clip of this video (list_media shows them)`);
    const input = join(MEDIA_DIR, clip.file);
    const out = mediaName(`${clip.name}.mp4`);
    const strength = dto.strength ?? 0.5;
    const dir = await mkdtemp(join(tmpdir(), "stab-"));
    const encode = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart"];
    let how: string;
    try {
      if (await hasVidstab()) {
        const trf = join(dir, "motion.trf");
        await run(FFMPEG, ["-v", "error", "-y", "-i", input, "-vf", `vidstabdetect=shakiness=6:accuracy=15:result=${trf}`, "-f", "null", "-"], { maxBuffer: 16 * 1024 * 1024 });
        const smoothing = Math.round(SMOOTHING[0] + (SMOOTHING[1] - SMOOTHING[0]) * strength);
        await run(FFMPEG, ["-v", "error", "-y", "-i", input, "-vf", `vidstabtransform=input=${trf}:smoothing=${smoothing}:optzoom=1:interpol=bicubic,unsharp=5:5:0.6:3:3:0.3`, ...encode, join(MEDIA_DIR, out)], { maxBuffer: 16 * 1024 * 1024 });
        how = "vid.stab";
      } else {
        // Search range: 16..64 px, in steps of 16 (what deshake takes).
        const r = 16 * Math.round(1 + 3 * strength);
        await run(FFMPEG, ["-v", "error", "-y", "-i", input, "-vf", `deshake=rx=${r}:ry=${r}:edge=mirror`, ...encode, join(MEDIA_DIR, out)], { maxBuffer: 16 * 1024 * 1024 });
        how = "deshake";
      }
    } catch (e) {
      await removeMedia(out);
      throw new BadRequestException(`ffmpeg could not stabilize it: ${(e as { stderr?: string }).stderr?.trim() || String(e)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const facts = await describeVideo(join(MEDIA_DIR, out));
    const size = (await stat(join(MEDIA_DIR, out))).size;
    const p = await this.projects.addFootage(user.id, id, {
      file: out, name: `${clip.name} (stabilized)`, mime: "video/mp4", size,
      duration: facts?.duration ?? clip.duration, width: facts?.width ?? clip.width, height: facts?.height ?? clip.height, poster: facts?.poster ?? null,
      // Same picture timing: the transcript carries over.
      language: clip.language, words: clip.words,
    });
    this.changed(user, id);
    const made = p.footage.at(-1)!;
    return { footage: made.id, url: `/media/${made.file}`, method: how };
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
