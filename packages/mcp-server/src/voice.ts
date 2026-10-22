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
