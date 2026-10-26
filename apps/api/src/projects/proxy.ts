import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { MEDIA_DIR, mediaName, removeMedia } from "../media";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const run = promisify(execFile);

/** Short side (px) of a proxy: light to decode, enough for a preview panel. */
export const PROXY_SHORT_SIDE = 540;
/** Clips get a proxy on upload when their long side is above this (4K, 2.7K, 1440p…). */
export const PROXY_FROM = 1920;

/** Whether a clip of this size gets a proxy on its own. */
export const wantsProxy = (width: number | null, height: number | null) => Math.max(width ?? 0, height ?? 0) > PROXY_FROM;

/**
 * A preview proxy of a clip (Resolve's proxy media): 540p H.264 with a keyframe every half second (cheap
 * to scrub), the sound kept; same length and timing as the original, which exports always use.
 * Returns its file name in the media folder.
 */
export async function createProxy(file: string): Promise<string> {
  const out = mediaName("proxy.mp4");
  const s = PROXY_SHORT_SIDE;
  try {
    await run(
      FFMPEG,
      ["-v", "error", "-y", "-i", join(MEDIA_DIR, file), "-vf", `scale='if(gt(iw,ih),-2,${s})':'if(gt(iw,ih),${s},-2)'`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", join(MEDIA_DIR, out)],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return out;
  } catch (e) {
    await removeMedia(out);
    throw e;
  }
}
