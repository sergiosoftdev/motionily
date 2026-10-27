/**
 * The voice-over's words on the video timeline, and its dead air. Words come from the scene captions,
 * else from the voice's own alignment (ElevenLabs, file seconds) placed through the scene's audio track
 * (start, trims, cuts — mirrors scene::AudioTrack).
 */
import type { Word } from "./timing.js";

type Track = { start?: number; trim_in?: number; trim_out?: number | null; cuts?: [number, number][] };

/** Audible pieces: where each starts on the video and the file range it plays. */
function pieces(t: Track): { at: number; from: number; to: number }[] {
  const end = t.trim_out ?? Infinity;
  const out: { at: number; from: number; to: number }[] = [];
  let at = t.start ?? 0;
  let from = t.trim_in ?? 0;
  for (const [a, b] of t.cuts ?? []) {
    if (b <= from) continue;
    if (a >= end) break;
    if (a > from) {
      out.push({ at, from, to: a });
      at += a - from;
    }
    from = b;
  }
  if (end > from) out.push({ at, from, to: end });
  return out;
}

/** Video second a file second plays at, or null when it was cut. */
function toScene(t: Track, f: number): number | null {
  const p = pieces(t).find((x) => f >= x.from && f < x.to);
  return p ? p.at + (f - p.from) : null;
}

/** A caption word worth stressing (numbers, long words, acronyms): the editor's rule (web captions/transcribe.ts). */
export function isKeyWord(word: string): boolean {
  const bare = word.replace(/[^\p{L}\p{N}%€$]/gu, "");
  return /\d/.test(bare) || bare.length >= 9 || (bare.length >= 3 && bare === bare.toUpperCase() && /\p{L}/u.test(bare));
}

/** The spoken words in video seconds. */
export function voiceWords(scene: Record<string, unknown> | null, fileWords: Word[] | null | undefined): Word[] {
  const captions = ((scene?.captions as { words?: Word[] } | undefined)?.words ?? []).map((w) => ({ text: String(w.text), start: Number(w.start), end: Number(w.end) }));
  if (captions.length) return captions;
  const track = (scene?.audio as Track | null | undefined) ?? {};
  return (fileWords ?? []).flatMap((w) => {
    const s = toScene(track, w.start);
    const e = toScene(track, Math.max(w.start, w.end - 1e-3));
    return s === null || e === null ? [] : [{ text: w.text, start: s, end: e + 1e-3 }];
  });
}

/** A silence between two spoken words: `[from, to]` video seconds and the words around it. */
export type Pause = { from: number; to: number; before: string; after: string };

/** Silences longer than `longer` seconds, in order. */
export function deadAir(words: Word[], longer: number): Pause[] {
  const out: Pause[] = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1]!;
    const b = words[i]!;
    if (b.start - a.end > longer) out.push({ from: a.end, to: b.start, before: a.text, after: b.text });
  }
  return out;
}

/** Silences measured in the file this close on the video are one pause (they meet at an earlier cut). */
const JOIN_S = 0.02;

/**
 * The voice's real pauses on the video timeline: silences measured in its file (file seconds, from the API),
 * placed through the track, longer than `longer`, between the first and last spoken words, named by the words
 * around them. Word timings alone are ~0.2 s late at every word start, so they cannot place a cut.
 */
export function measuredPauses(scene: Record<string, unknown> | null, fileSilences: [number, number][], words: Word[], longer: number): Pause[] {
  const track = (scene?.audio as Track | null | undefined) ?? {};
  const spans: [number, number][] = [];
  for (const [a, b] of fileSilences) {
    for (const p of pieces(track)) {
      const lo = Math.max(a, p.from);
      const hi = Math.min(b, p.to);
      if (hi > lo) spans.push([p.at + lo - p.from, p.at + hi - p.from]);
    }
  }
  spans.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const sp of spans) {
    const last = merged.at(-1);
    if (last && sp[0] - last[1] <= JOIN_S) last[1] = Math.max(last[1], sp[1]);
    else merged.push([...sp]);
  }
  const first = words[0]?.start ?? 0;
  const end = words.at(-1)?.end ?? Infinity;
  return merged
    .filter(([from, to]) => to - from > longer && from > first && to < end)
    .map(([from, to]) => ({
      from,
      to,
      before: [...words].reverse().find((w) => w.start < from)?.text ?? "",
      after: words.find((w) => w.end > to)?.text ?? "",
    }));
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9áéíóúüñ']/gi, "");

/**
 * How far the captions sit from the voice: each caption word against the same word of the voice's own
 * alignment placed through the audio track. Null when there is nothing to compare.
 */
export function captionDrift(scene: Record<string, unknown> | null, fileWords: Word[] | null | undefined): { max: number; at: number; word: string } | null {
  const captions = ((scene?.captions as { words?: Word[] } | undefined)?.words ?? []).map((w) => ({ text: String(w.text), start: Number(w.start) }));
  if (!captions.length || !fileWords?.length) return null;
  const track = (scene?.audio as Track | null | undefined) ?? {};
  let j = 0;
  let worst: { max: number; at: number; word: string } = { max: 0, at: 0, word: "" };
  for (const c of captions) {
    // Walk the voice words in order; skip voice words the captions left out.
    let k = j;
    while (k < fileWords.length && norm(fileWords[k]!.text) !== norm(c.text) && k - j < 12) k++;
    if (k >= fileWords.length || norm(fileWords[k]!.text) !== norm(c.text)) continue;
    j = k + 1;
    const heard = toScene(track, fileWords[k]!.start);
    if (heard === null) continue;
    const off = Math.abs(heard - c.start);
    if (off > worst.max) worst = { max: off, at: c.start, word: c.text };
  }
  return worst;
}
