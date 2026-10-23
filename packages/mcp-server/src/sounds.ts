/**
 * Motionily's sound effect library as the agents read it, and add_sfx lines. Sounds are measured files
 * (apps/api/src/sounds/library.ts): the agent cannot listen, so it places them by their numbers.
 */

/** A library sound (mirrors the API's /sounds rows). */
export type LibrarySound = {
  name: string;
  category: string;
  description: string;
  duration: number;
  /** Seconds into the file of its loudest moment. */
  peak: number;
  /** hit · build · swell · steady (SoundShape in the API). */
  shape: string;
  /** Seconds into the file where each separate hit starts. */
  hits: number[];
  /** Seconds between hits when they keep a steady pace. */
  every: number | null;
  url: string;
};

/** The cue a line places (mirrors scene::SfxCue). */
export type SfxCue = { id: string; sound: string; src: string; at: number; gain: number; from?: number; len?: number };

/** Hits listed per sound before "…". */
const HITS_SHOWN = 6;
/** A sound longer than this without len= is probably a loop the agent forgot to cut. */
const LONG_CUE_S = 6;

const secs = (v: number) => `${Number(v.toFixed(2))}`;

/** What an editor reads in a waveform, in a few words. */
function shapeOf(s: LibrarySound) {
  const parts = [`${s.shape}, peak ${secs(s.peak)}s`];
  if (s.every) parts.push(`hits every ${secs(s.every)}s from ${secs(s.hits[0] ?? 0)}s`);
  else if (s.hits.length > 1) parts.push(`hits at ${s.hits.slice(0, HITS_SHOWN).map(secs).join(", ")}${s.hits.length > HITS_SHOWN ? "…" : ""}`);
  return parts.join(", ");
}

/** The library grouped by category: `name | seconds | shape, peak, hits | description`. */
export function formatSounds(rows: LibrarySound[], category?: string): string {
  const shown = category ? rows.filter((s) => s.category.toLowerCase() === category.toLowerCase()) : rows;
  if (!shown.length) {
    const cats = [...new Set(rows.map((s) => s.category))];
    return rows.length ? `No "${category}" sounds. Categories: ${cats.join(", ")}` : "The sound library is empty: leave the video without effects.";
  }
  const out: string[] = [];
  let last = "";
  for (const s of shown) {
    if (s.category !== last) out.push(`## ${(last = s.category)}`);
    out.push(`${s.name} | ${secs(s.duration)}s | ${shapeOf(s)} | ${s.description}`);
  }
  return out.join("\n");
}

/**
 * One add_sfx line: `id sound_name at [gain] [from=S] [len=S]`, or `hit=T` instead of `at` to land the
 * sound's loudest moment (inside from…from+len when given) on second T of the video.
 */
export function parseCue(line: string, library: Map<string, LibrarySound>, defaultGain: number): { cue: SfxCue; warning?: string } | { error: string } {
  const [id, name, ...rest] = line.trim().split(/\s+/);
  const sound = library.get(name ?? "");
  if (!id || !sound) return { error: `unknown sound '${name ?? ""}'` };
  const named = new Map<string, number>();
  const plain: number[] = [];
  for (const token of rest) {
    const m = /^(hit|from|len)=(-?[\d.]+)$/.exec(token);
    if (m) named.set(m[1]!, Number(m[2]));
    else if (Number.isFinite(Number(token))) plain.push(Number(token));
    else return { error: `unknown part '${token}'` };
  }
  const from = named.get("from") ?? 0;
  const len = named.get("len");
  if (from < 0 || from >= sound.duration) return { error: `from=${from} is outside ${name} (${secs(sound.duration)} s long)` };
  if (len !== undefined && len <= 0) return { error: "len must be > 0" };
  const hit = named.get("hit");
  let at: number;
  let gainAt = 0;
  if (hit !== undefined) {
    // The loudest moment inside the part that plays: the file's peak, or the first listed hit in range.
    const end = len === undefined ? sound.duration : from + len;
    const peak = sound.peak >= from && sound.peak < end ? sound.peak : (sound.hits.find((h) => h >= from && h < end) ?? from);
    at = hit - (peak - from);
  } else {
    at = plain[0] ?? NaN;
    gainAt = 1;
  }
  if (!Number.isFinite(at)) return { error: "needs at (seconds) or hit=T" };
  if (at < 0) return { error: `${name} peaks ${secs(sound.peak - from)} s in, so hit=${hit} would start it before the video: use a later hit or from=` };
  const gain = plain[gainAt] ?? defaultGain;
  const plays = (len ?? sound.duration - from);
  const warning = len === undefined && plays > LONG_CUE_S ? `${id}: ${name} plays ${secs(plays)} s; add len= if you wanted only part of it` : undefined;
  return {
    cue: { id, sound: sound.name, src: sound.url, at: Math.round(at * 1000) / 1000, gain, ...(from ? { from } : {}), ...(len !== undefined ? { len } : {}) },
    ...(warning ? { warning } : {}),
  };
}
