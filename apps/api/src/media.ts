import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Controller, Get, NotFoundException, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "./auth/auth";

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

@Public()
@Controller("media")
export class MediaController {
  @Get(":file")
  serve(@Param("file") file: string, @Res() res: Response) {
    if (!SAFE_NAME.test(file)) throw new NotFoundException();
    res.sendFile(join(MEDIA_DIR, file), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }
}
