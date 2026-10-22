import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import type { Response } from "express";
import { Public } from "./auth/auth";
import { analyzeFilm } from "./references/film";

/** Uploaded media lives on local disk for now (swap for object storage in production). */
export const MEDIA_DIR = resolve(process.env.MEDIA_DIR ?? join(process.cwd(), "uploads"));
mkdirSync(MEDIA_DIR, { recursive: true });

export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const SAFE_NAME = /^[a-f0-9-]{36}\.[a-z0-9]{1,5}$/;

/** Random, unguessable file name so media can be served without auth headers (<audio src>). */
export function mediaName(original: string) {
  const ext = extname(original).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 6) || ".bin";
  return `${randomUUID()}${ext}`;
}

export async function removeMedia(file: string | undefined) {
  if (file && SAFE_NAME.test(file)) await unlink(join(MEDIA_DIR, file)).catch(() => undefined);
}

export const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
/** Reference films are cut into contact sheets on upload; the video itself is not kept. */
export const MAX_REFERENCE_VIDEO_BYTES = 150 * 1024 * 1024;
/** Raster formats Claude can see (no SVG: it is not an image to the model and could carry scripts). */
const REFERENCE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const REFERENCE_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
/** Media paths a user can attach as reference images. */
export const MEDIA_PATH = /^\/media\/[a-f0-9-]{36}\.[a-z0-9]{1,5}$/;

/** Reference images the user pastes into a prompt, so the agent can see what they mean. */
@Controller("references")
export class ReferencesController {
  @Post()
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: MEDIA_DIR, filename: (_req, f, cb) => cb(null, mediaName(f.originalname || "ref.png")) }),
      limits: { fileSize: MAX_REFERENCE_VIDEO_BYTES },
      fileFilter: (_req, f, cb) => cb(null, REFERENCE_TYPES.includes(f.mimetype) || REFERENCE_VIDEO_TYPES.includes(f.mimetype)),
    }),
  )
  async upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException("an image or video file is required");
    if (REFERENCE_TYPES.includes(file.mimetype)) {
      if (file.size > MAX_REFERENCE_BYTES) {
        await removeMedia(file.filename);
        throw new BadRequestException("reference images are limited to 15 MB");
      }
      return { url: `/media/${file.filename}`, urls: [`/media/${file.filename}`] };
    }
    // A film: keep what the agents read (contact sheets + timing), not the video.
    try {
      const film = await analyzeFilm(join(MEDIA_DIR, file.filename));
      return { url: film.sheets[0], urls: film.sheets, film: film.notes };
    } catch (e) {
      throw new BadRequestException(`could not read that video: ${(e as Error).message}`);
    } finally {
      await removeMedia(file.filename);
    }
  }
}

@Public()
@Controller("media")
export class MediaController {
  @Get(":file")
  serve(@Param("file") file: string, @Res() res: Response) {
    if (!SAFE_NAME.test(file)) throw new NotFoundException();
    // Imported SVGs are sanitized; opened directly they still must not run anything.
    if (file.endsWith(".svg")) res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    res.sendFile(join(MEDIA_DIR, file), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }
}
