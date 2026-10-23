import { join } from "node:path";
import { MEDIA_DIR } from "../media";
import { loudness } from "../music/energy";

/** Loudness is read in windows this long (s): fine enough to find where a word starts. */
const WINDOW = 0.02;
/** This far under the voice's loudest moment is silence; breaths and soft onsets stay sound. */
const SILENCE_DB = 35;
/** Quiet stretches shorter than this are gaps inside or between words, not pauses. */
const MIN_SILENCE = 0.12;

const cache = new Map<string, Promise<[number, number][]>>();

/**
 * Where a voice file is really silent, in file seconds. ElevenLabs' word timings start each word ~0.2 s after
 * it is heard (the breath and the first consonant come first), so pauses are cut by the sound, not the words.
 */
export function voiceSilences(file: string): Promise<[number, number][]> {
  let s = cache.get(file);
  if (!s) {
    s = loudness(join(MEDIA_DIR, file), WINDOW).then((db) => {
      const quiet = Math.max(...db) - SILENCE_DB;
      const out: [number, number][] = [];
      let from = -1;
      db.forEach((v, i) => {
        if (v < quiet && from < 0) from = i;
        const ends = from >= 0 && (v >= quiet || i === db.length - 1);
        if (!ends) return;
        const to = v >= quiet ? i : i + 1;
        if ((to - from) * WINDOW >= MIN_SILENCE) out.push([+(from * WINDOW).toFixed(3), +(to * WINDOW).toFixed(3)]);
        from = -1;
      });
      return out;
    });
    s.catch(() => cache.delete(file));
    cache.set(file, s);
  }
  return s;
}
