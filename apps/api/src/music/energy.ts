import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

/** Loudness is measured in windows this long (s). */
export const ENERGY_WINDOW = 0.5;
/** Sample rate the loudness is measured at (plenty for energy). */
const RATE = 8000;
/** Songs are read up to this far (s): enough to place any video in them. */
const MAX_READ = 600;
/** Smoothing for "sections": 2 s of windows. */
const SMOOTH = 4;
/** The loud part starts where the song first comes within this many dB of its loudest stretch. */
const PEAK_DB = 3;
/** The intro ends where the song first comes within this many dB of its loudest stretch. */
const INTRO_DB = 10;

/** How a song's energy moves: where the quiet intro ends, where the loud part starts, how long it is. */
export type SongEnergy = { duration: number; introEnd: number; peakAt: number; summary: string };

/** Loudness (dB RMS) of every half second of an audio file or URL, mono at 8 kHz. */
export async function loudness(source: string): Promise<number[]> {
  const { stdout } = await run(
    FFMPEG,
    // asetnsamples makes every audio frame exactly one window; astats then measures each frame on its own.
    ["-v", "error", "-t", String(MAX_READ), "-i", source, "-ac", "1", "-ar", String(RATE), "-af", `asetnsamples=n=${RATE * ENERGY_WINDOW}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`, "-f", "null", "-"],
    { maxBuffer: 16 * 1024 * 1024, timeout: 90_000 },
  );
  return [...stdout.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === "-inf" ? -120 : Math.max(-120, Number(m[1]))));
}

/** Read the curve: intro, loud part and a one-line description an agent can plan with. */
export function describeEnergy(db: number[]): SongEnergy {
  const duration = db.length * ENERGY_WINDOW;
  const smooth = db.map((_, i) => {
    const part = db.slice(Math.max(0, i - SMOOTH + 1), i + 1);
    return part.reduce((a, b) => a + b, 0) / part.length;
  });
  const max = Math.max(...smooth);
  const at = (limit: number) => Math.max(0, (smooth.findIndex((v) => v >= max - limit) - SMOOTH + 1) * ENERGY_WINDOW);
  const introEnd = at(INTRO_DB);
  const peakAt = Math.max(introEnd, at(PEAK_DB));
  const parts = [
    introEnd > 1 ? `quiet intro to ${introEnd.toFixed(1)} s` : "starts strong",
    peakAt > introEnd + 1 ? `builds to its loudest part at ${peakAt.toFixed(1)} s` : `loudest from ${peakAt.toFixed(1)} s`,
    `${duration.toFixed(0)} s long`,
  ];
  return { duration, introEnd, peakAt, summary: parts.join(", ") };
}

export async function songEnergy(source: string): Promise<SongEnergy | null> {
  const db = await loudness(source).catch(() => null);
  return db?.length ? describeEnergy(db) : null;
}

/**
 * Where in the song the video should start so its loud part lands on the video's key moment
 * (`dropAt`); without one, it only skips a long quiet intro.
 */
export function fitSong(energy: SongEnergy, videoLength: number, dropAt: number | null): number {
  const start = dropAt === null ? Math.max(0, energy.introEnd - 0.5) : Math.max(0, energy.peakAt - dropAt);
  // Never so late that the song runs out before the video does.
  return Math.round(Math.max(0, Math.min(start, energy.duration - videoLength)) * 10) / 10;
}
