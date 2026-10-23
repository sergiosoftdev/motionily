import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { Logger } from "@nestjs/common";
import { loudness } from "../music/energy";

/**
 * Motionily's sound effect library: audio files the team curates in one folder, shared by every account.
 * Each subfolder is a category; dropping a file in is all it takes. The agents cannot listen, so every file
 * is measured once (cached in the folder): its length, where it hits hardest, its shape and, in longer
 * recordings, where each hit is, so a cue can land a riser's peak on a reveal or play one click of a reel.
 */
export const SOUNDS_DIR = resolve(process.env.SOUNDS_DIR ?? join(homedir(), ".motionily", "sounds"));

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"]);
/** Measurements, by file, so each one is read only when it changes. */
const INDEX_FILE = ".index.json";
/** Bump when `measure` changes: every file is measured again. */
const INDEX_VERSION = 2;
/** Category of files dropped straight into the folder. */
const UNSORTED = "Other";
/** Loudness is read in windows this long (s): fine enough to find a click. */
const WINDOW = 0.02;
/** Files measured at once on a first scan. */
const PARALLEL = 4;
const SOUND_NAME_MAX = 40;

/** How a sound moves in time: what an editor sees in its waveform. */
export const SoundShape = {
  /** Loudest at once, then decays: pops, clicks, impacts, drops. */
  Hit: "hit",
  /** Grows to its peak late: risers, reverse swells, whooshes into a cut. */
  Build: "build",
  /** Rises and falls around the middle: passes, swooshes. */
  Swell: "swell",
  /** About as loud the whole time: loops, beds, ticking, static. */
  Steady: "steady",
} as const;
export type SoundShape = (typeof SoundShape)[keyof typeof SoundShape];

/** Where a sound hits hardest and how it moves, measured from its file. */
type Measure = {
  duration: number;
  /** Seconds into the file of its loudest moment. */
  peak: number;
  shape: SoundShape;
  /** Seconds into the file where each separate hit starts (clicks of a camera, ticks…), at most MAX_HITS. */
  hits: number[];
  /** Seconds between hits when they come at a steady pace (a clock), else null. */
  every: number | null;
};

export type LibrarySound = Measure & { name: string; category: string; description: string; file: string };

type IndexEntry = { size: number; mtime: number; measure: Measure | null };
type Index = { version: number; files: Record<string, IndexEntry> };

/** A hit is a jump of this many dB within RISE_WINDOWS… */
const HIT_RISE_DB = 9;
const RISE_WINDOWS = 5;
/** …that reaches within this many dB of the loudest moment… */
const HIT_FLOOR_DB = 20;
/** …and comes at least this long after the previous one. */
const HIT_GAP = 0.2;
const MAX_HITS = 12;
/** A steady pace: hit intervals vary less than this share of their mean. */
const STEADY_PACE = 0.15;
/** A sound is steady when this share of it is within 10 dB of its loudest… */
const STEADY_SHARE = 0.5;
/** …or when it keeps hitting (at least this many times, until late in the file: ticking, typing). */
const REPEATING_HITS = 8;
const STEADY_MIN_LENGTH = 5;

const log = new Logger("SoundLibrary");
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Read a sound's shape from its loudness curve (dB per WINDOW). */
export function measure(db: number[]): Measure {
  const duration = round2(db.length * WINDOW);
  const max = Math.max(...db);
  const peakAt = db.indexOf(max);
  const peak = round2((peakAt + 0.5) * WINDOW);
  const all: number[] = [];
  for (let i = 1; i < db.length; i++) {
    const before = Math.min(...db.slice(Math.max(0, i - RISE_WINDOWS), i));
    const t = i * WINDOW;
    if (db[i]! >= max - HIT_FLOOR_DB && db[i]! - before >= HIT_RISE_DB && t - (all.at(-1) ?? -Infinity) >= HIT_GAP) all.push(round2(t));
  }
  const hits = all.slice(0, MAX_HITS);
  const repeating = all.length >= REPEATING_HITS && all.at(-1)! >= duration * 0.7;
  const gaps = hits.slice(1).map((t, i) => t - hits[i]!);
  const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
  const spread = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / (gaps.length || 1));
  const every = gaps.length >= 3 && spread / mean < STEADY_PACE ? round2(mean) : null;
  const loudShare = db.filter((v) => v >= max - 10).length / db.length;
  const shape =
    duration >= STEADY_MIN_LENGTH && (loudShare >= STEADY_SHARE || every !== null || repeating)
      ? SoundShape.Steady
      : peak <= Math.max(0.15, duration * 0.2)
        ? SoundShape.Hit
        : peak >= duration * 0.6
          ? SoundShape.Build
          : SoundShape.Swell;
  return { duration, peak, shape, hits: hits.length > 1 || duration > 2 ? hits : [], every };
}

/** "CAMERA-35MM-SLR-SHUTTER" → "Camera 35mm slr shutter"; "Whoosh 1" stays. */
function describe(stem: string) {
  const words = stem.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words === words.toUpperCase() ? words.charAt(0) + words.slice(1).toLowerCase() : words;
}

/** snake_case name the agents write: "Mechanical Key Medium by Bigmonmulgrew" → mechanical_key_medium. */
function nameOf(stem: string) {
  const slug = stem
    .replace(/\s+by\s+[\w.-]+$/i, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, SOUND_NAME_MAX)
    .replace(/_+$/, "");
  return /^[a-z]/.test(slug) ? slug : `s_${slug}`.slice(0, SOUND_NAME_MAX);
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(path)));
    else if (AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase())) out.push(path);
  }
  return out;
}

class SoundLibrary {
  private index: Index | null = null;
  private scanning: Promise<LibrarySound[]> | null = null;
  private byName = new Map<string, LibrarySound>();

  /** Every sound in the folder, measured, sorted by category then name. */
  list(): Promise<LibrarySound[]> {
    this.scanning ??= this.scan().finally(() => (this.scanning = null));
    return this.scanning;
  }

  /** Absolute path of a sound's file, or null. Only ever inside SOUNDS_DIR. */
  async fileOf(name: string): Promise<string | null> {
    if (!this.byName.has(name)) await this.list();
    const s = this.byName.get(name);
    const path = s ? resolve(SOUNDS_DIR, s.file) : null;
    return path && path.startsWith(SOUNDS_DIR + sep) ? path : null;
  }

  private async scan(): Promise<LibrarySound[]> {
    await mkdir(SOUNDS_DIR, { recursive: true });
    this.index ??= await readFile(join(SOUNDS_DIR, INDEX_FILE), "utf8")
      .then((t) => JSON.parse(t) as Index)
      .then((i) => (i.version === INDEX_VERSION ? i : null))
      .catch(() => null);
    this.index ??= { version: INDEX_VERSION, files: {} };
    const index = this.index.files;
    const files = (await walk(SOUNDS_DIR)).map((p) => relative(SOUNDS_DIR, p)).sort();
    let changed = false;
    const queue = [...files];
    const work = async () => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        const info = await stat(join(SOUNDS_DIR, file));
        const known = index[file];
        if (known && known.size === info.size && known.mtime === info.mtimeMs) continue;
        const db = await loudness(join(SOUNDS_DIR, file), WINDOW).catch((e: Error) => {
          log.warn(`could not read ${file}: ${e.message}`);
          return [];
        });
        index[file] = { size: info.size, mtime: info.mtimeMs, measure: db.length ? measure(db) : null };
        changed = true;
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, work));
    for (const file of Object.keys(index)) {
      if (!files.includes(file)) {
        delete index[file];
        changed = true;
      }
    }
    if (changed) await writeFile(join(SOUNDS_DIR, INDEX_FILE), JSON.stringify(this.index)).catch((e: Error) => log.warn(`could not save the index: ${e.message}`));

    const taken = new Set<string>();
    const sounds: LibrarySound[] = [];
    for (const file of files) {
      const m = index[file]?.measure;
      if (!m) continue;
      const parts = file.split(sep);
      const stem = parts.at(-1)!.slice(0, -extname(file).length);
      let name = nameOf(stem);
      for (let n = 2; taken.has(name); n++) name = `${nameOf(stem).slice(0, SOUND_NAME_MAX - 3)}_${n}`;
      taken.add(name);
      sounds.push({ ...m, name, category: parts.length > 1 ? parts[0]! : UNSORTED, description: describe(stem), file });
    }
    sounds.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    this.byName = new Map(sounds.map((s) => [s.name, s]));
    return sounds;
  }
}

export const soundLibrary = new SoundLibrary();
