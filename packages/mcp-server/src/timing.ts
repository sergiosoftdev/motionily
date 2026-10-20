/**
 * Timing by reference: `@phrase:N` is the N-th phrase of the voice (from 1), `@word:TEXT` the first
 * time that word is spoken; either takes `+SECONDS` to offset. Phrases are the caption words split
 * at silences of 0.25 s or more, the same rule the engine uses for the voice timeline.
 */

export type Word = { text: string; start: number; end: number };
export type Phrase = { start: number; end: number; words: Word[] };

/** Silence that starts a new phrase (matches MIN_PAUSE_S in the engine). */
export const MIN_PAUSE_S = 0.25;

const REF = /^@(?:phrase:(\d+)|word:([^\s+@]+))(?:\+(\d+(?:\.\d+)?))?$/;

export const isRef = (v: unknown): v is string => typeof v === "string" && v.startsWith("@");

/** Throws a message that names the bad token when it is not a reference. */
export function checkRef(token: string, line: string): void {
  if (!REF.test(token)) throw new Error(`bad time reference '${token}' (use @phrase:N or @word:TEXT, optional +SECONDS): ${line}`);
}

export function phrasesOf(words: Word[]): Phrase[] {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const phrases: Phrase[] = [];
  for (const w of sorted) {
    const last = phrases[phrases.length - 1];
    if (last && w.start - last.end < MIN_PAUSE_S) {
      last.words.push(w);
      last.end = Math.max(last.end, w.end);
    } else phrases.push({ start: w.start, end: w.end, words: [w] });
  }
  return phrases;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Seconds for a reference, or an Error saying what the voice actually has. */
export function resolveRef(ref: string, words: Word[]): number {
  const m = REF.exec(ref);
  if (!m) throw new Error(`bad time reference '${ref}' (use @phrase:N or @word:TEXT)`);
  const offset = Number(m[3] ?? 0);
  if (m[1] !== undefined) {
    const phrases = phrasesOf(words);
    const n = Number(m[1]);
    if (!phrases.length) throw new Error(`${ref}: no voice in this video (upload a voice-over or write the times in seconds)`);
    if (n < 1 || n > phrases.length) throw new Error(`${ref}: the voice has ${phrases.length} phrases (numbered from 1)`);
    return phrases[n - 1]!.start + offset;
  }
  const want = norm(m[2]!);
  const hit = [...words].sort((a, b) => a.start - b.start).find((w) => norm(w.text) === want);
  if (!hit) {
    const heard = [...new Set(words.map((w) => norm(w.text)).filter(Boolean))].slice(0, 12).join(", ");
    throw new Error(`${ref}: the word '${m[2]}' is not in the voice${heard ? ` (heard: ${heard}…)` : " (no voice in this video)"}`);
  }
  return hit.start + offset;
}

/** Replace reference times on layers (start and end) with seconds. Mutates `layers`. */
export function resolveLayerTimes(layers: Record<string, unknown>[], words: Word[]): void {
  for (const l of layers) {
    for (const key of ["start", "end"] as const) {
      const v = l[key];
      if (isRef(v)) l[key] = resolveRef(v, words);
    }
  }
}
