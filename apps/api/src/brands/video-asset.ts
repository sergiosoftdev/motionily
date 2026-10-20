import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe, sheet, SHEET_FRAMES } from "../references/film";

/** Clips a user can put in a `video` layer (the editor decodes them with WebCodecs). */
export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** What an agent needs to cut a clip without probing it: length, size and a contact sheet. */
export type VideoFacts = { duration: number; width: number; height: number; poster: string | null };

/** Seconds of the frames in a clip's contact sheet (left to right, top to bottom). */
export function posterTimes(duration: number): number[] {
  return Array.from({ length: SHEET_FRAMES }, (_, i) => +((duration * (i + 0.5)) / SHEET_FRAMES).toFixed(2));
}

/** Probe an uploaded clip with ffmpeg; null when ffmpeg is missing or the file is unreadable. */
export async function describeVideo(file: string): Promise<VideoFacts | null> {
  try {
    const { duration, width, height } = await probe(file);
    if (!duration) return null;
    const dir = await mkdtemp(join(tmpdir(), "clip-"));
    try {
      const poster = await sheet(file, posterTimes(duration), dir, "p").catch(() => null);
      return { duration: +duration.toFixed(3), width, height, poster };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}
