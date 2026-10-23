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

/** A jump in a song's energy (the start of a drop or a chorus): when, and by how many dB over two seconds. */
export type Rise = { at: number; db: number };
/** How a song's energy moves: where the quiet intro ends, where the loud part starts, its big rises, how long it is. */
export type SongEnergy = { duration: number; introEnd: number; peakAt: number; rises: Rise[]; summary: string };

/** A rise this big (dB over two seconds) is a drop or a new section. */
const RISE_DB = 6;
/** An intro quieter than the song for longer than this is skipped. */
const LONG_INTRO = 3;
/** A song made for the video is never started more than this far in: its structure already follows the video. */
const MAX_SHIFT = 15;
/** A rise this far before the planned drop still counts as the drop. */
const EARLY_DROP = 5;

/** Loudness (dB RMS) of every `window` seconds (half a second by default) of an audio file or URL, mono at 8 kHz. */
export async function loudness(source: string, window = ENERGY_WINDOW): Promise<number[]> {
  const { stdout } = await run(
    FFMPEG,
    // Resample to mono 8 kHz inside the filter chain (output options would only apply after it), then
    // asetnsamples makes every audio frame exactly one window and astats measures each frame on its own.
    [
      "-v",
      "error",
      "-t",
      String(MAX_READ),
      "-i",
      source,
      "-af",
      `aresample=${RATE},aformat=channel_layouts=mono,asetnsamples=n=${Math.round(RATE * window)}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      "-f",
      "null",
      "-",
    ],
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
  // Rises: where the smoothed level climbs RISE_DB within SMOOTH windows, one per climb (its steepest point).
  const rises: Rise[] = [];
  for (let i = 0; i + SMOOTH < smooth.length; i++) {
    const db = smooth[i + SMOOTH]! - smooth[i]!;
    if (db < RISE_DB) continue;
    const last = rises.at(-1);
    // The first window past the quiet one: where the new section is heard.
    const t = (i + 1) * ENERGY_WINDOW;
    if (last && t - last.at < SMOOTH * ENERGY_WINDOW) {
      if (db > last.db) Object.assign(last, { at: t, db });
    } else rises.push({ at: t, db });
  }
  const parts = [
    introEnd > 1 ? `quiet intro to ${introEnd.toFixed(1)} s` : "starts strong",
    peakAt > introEnd + 1 ? `builds to its loudest part at ${peakAt.toFixed(1)} s` : `loudest from ${peakAt.toFixed(1)} s`,
    `${duration.toFixed(0)} s long`,
  ];
  return { duration, introEnd, peakAt, rises, summary: parts.join(", ") };
}

export async function songEnergy(source: string): Promise<SongEnergy | null> {
  const db = await loudness(source).catch(() => null);
  return db?.length ? describeEnergy(db) : null;
}

/**
 * Where in the song the video should start. From the beginning, skipping only a long quiet intro: a song
 * made for the video already follows it. With a planned drop (`dropAt`, video seconds), the song moves
 * at most MAX_SHIFT seconds so a clear rise near that point lands exactly on it.
 */
export function fitSong(energy: SongEnergy, videoLength: number, dropAt: number | null): number {
  const base = energy.introEnd > LONG_INTRO ? energy.introEnd - 0.5 : 0;
  let start = base;
  if (dropAt !== null) {
    const near = energy.rises.filter((r) => r.at >= base + dropAt - EARLY_DROP && r.at <= base + dropAt + MAX_SHIFT);
    const best = near.sort((a, b) => b.db - a.db)[0];
    if (best) start = Math.max(0, best.at - dropAt);
  }
  // Never so late that the song runs out before the video does.
  return Math.round(Math.max(0, Math.min(start, energy.duration - videoLength)) * 10) / 10;
}
