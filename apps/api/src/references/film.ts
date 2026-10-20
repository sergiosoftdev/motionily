import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MEDIA_DIR, mediaName } from "../media";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
/** Frame-difference threshold ffmpeg's scene detector treats as a cut. */
const CUT_THRESHOLD = 0.32;
/** Shots shorter than this are merged (flashes, motion-blur frames). */
const MIN_SHOT = 0.35;
const SHEET_COLS = 4;
const SHEET_ROWS = 3;
const SHEET_FRAMES = SHEET_COLS * SHEET_ROWS;
const CELL_WIDTH = 480;

/** What the agents get from a reference film: two contact sheets and its timing. */
export type FilmReference = { sheets: string[]; notes: string };

const sidecar = (sheet: string) => join(MEDIA_DIR, `${sheet.replace(/^\/media\//, "")}.film.json`);

async function probe(file: string) {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]);
  const j = JSON.parse(stdout) as { streams?: { width: number; height: number }[]; format?: { duration?: string } };
  return { duration: Number(j.format?.duration ?? 0), width: j.streams?.[0]?.width ?? 0, height: j.streams?.[0]?.height ?? 0 };
}

async function cuts(file: string, duration: number): Promise<number[]> {
  const { stderr } = await run(FFMPEG, ["-hide_banner", "-i", file, "-vf", `select='gt(scene,${CUT_THRESHOLD})',showinfo`, "-an", "-f", "null", "-"], { maxBuffer: 32 * 1024 * 1024 });
  const times = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  const out: number[] = [0];
  for (const t of times) if (t - out[out.length - 1]! >= MIN_SHOT && duration - t >= MIN_SHOT) out.push(t);
  return out;
}

async function sheet(file: string, times: number[], dir: string, tag: string): Promise<string> {
  await Promise.all(
    times.map((t, i) => run(FFMPEG, ["-v", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${CELL_WIDTH}:-2`, join(dir, `${tag}${String(i).padStart(2, "0")}.jpg`)])),
  );
  const name = mediaName("sheet.jpg");
  await run(FFMPEG, ["-v", "error", "-y", "-framerate", "1", "-i", join(dir, `${tag}%02d.jpg`), "-vf", `tile=${SHEET_COLS}x${SHEET_ROWS}`, "-frames:v", "1", "-q:v", "3", join(MEDIA_DIR, name)]);
  return `/media/${name}`;
}

const s = (t: number) => `${t.toFixed(1)}s`;

/** Cut a reference video into what an agent can read: contact sheets + shot timing. */
export async function analyzeFilm(file: string): Promise<FilmReference> {
  const { duration, width, height } = await probe(file);
  if (!duration) throw new Error("could not read the video");
  const starts = await cuts(file, duration);
  const shots = starts.map((a, i) => [a, starts[i + 1] ?? duration] as const);
  const dir = await mkdtemp(join(tmpdir(), "film-"));
  try {
    const even = Array.from({ length: SHEET_FRAMES }, (_, i) => (duration * (i + 0.5)) / SHEET_FRAMES);
    // One frame per shot (its middle); long films keep an even sample of shots.
    const pick = shots.length <= SHEET_FRAMES ? shots : Array.from({ length: SHEET_FRAMES }, (_, i) => shots[Math.floor((i * shots.length) / SHEET_FRAMES)]!);
    const [overview, shotSheet] = await Promise.all([sheet(file, even, dir, "e"), sheet(file, pick.map(([a, b]) => (a + b) / 2), dir, "s")]);
    const lengths = shots.map(([a, b]) => b - a);
    const avg = lengths.reduce((x, y) => x + y, 0) / lengths.length;
    const notes =
      `Reference film ${s(duration)}, ${width}x${height}, ${shots.length} shots (average ${s(avg)}): ` +
      shots.map(([a, b], i) => `${i + 1}) ${s(a)}-${s(b)}`).join(", ") +
      `. Sheet ${overview}: ${SHEET_FRAMES} frames evenly every ${s(duration / SHEET_FRAMES)} (left to right, top to bottom). ` +
      `Sheet ${shotSheet}: the middle frame of ${pick.length === shots.length ? "each shot" : `${pick.length} of the shots`}, in order.`;
    const film: FilmReference = { sheets: [overview, shotSheet], notes };
    await Promise.all(film.sheets.map((sh) => writeFile(sidecar(sh), JSON.stringify({ notes }))));
    return film;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Timing notes stored next to a reference sheet, if it came from a film. */
export async function filmNotes(reference: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(sidecar(reference), "utf8")) as { notes: string }).notes;
  } catch {
    return null;
  }
}
