/** Background music math, without the DOM: where speech is, how much the music ducks, which file second plays. */

/** Background music as the scene keeps it (crates/scene/src/music.rs). */
export type MusicTrack = { src: string; start: number; trim_in: number; trim_out?: number | null; gain: number; duck: number };
/** New music's level and ducking, the engine's defaults (crates/scene/src/music.rs). */
export const DEFAULT_MUSIC_GAIN = 0.25;
export const DEFAULT_DUCK = 0.35;
/** Seconds of the video where someone speaks. */
export type SpeechSpan = [number, number];

/** Words closer than this are one stretch of speech (the music does not bounce between them). */
const SPEECH_GAP = 0.4;
/** The music fades down this long before speech starts, and back up this long after it ends. */
export const DUCK_RAMP = 0.2;

/** Stretches of speech from the caption words, which is where the music ducks. */
export function speechSpans(words: { start: number; end: number }[]): SpeechSpan[] {
  const spans: SpeechSpan[] = [];
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    const last = spans.at(-1);
    if (last && w.start - last[1] < SPEECH_GAP) last[1] = Math.max(last[1], w.end);
    else spans.push([w.start, w.end]);
  }
  return spans;
}

/** How much of the music's level plays at scene second `t`: 1, down to `duck` during speech, with short ramps. */
export function duckAt(spans: SpeechSpan[], duck: number, t: number): number {
  let k = 1;
  for (const [s, e] of spans) {
    if (t < s - DUCK_RAMP) break;
    if (t > e + DUCK_RAMP) continue;
    const ramp = t < s ? (s - t) / DUCK_RAMP : t > e ? (t - e) / DUCK_RAMP : 0;
    k = Math.min(k, duck + (1 - duck) * ramp);
  }
  return k;
}

/** File second playing at scene second `t`, or null when the music is silent there. */
export function musicFileTime(m: MusicTrack, t: number, fileDuration: number): number | null {
  const f = m.trim_in + (t - m.start);
  const end = m.trim_out ?? fileDuration;
  return t >= m.start && f < end ? f : null;
}


/** Loudness windows (s) used to find speech in a voice file. */
const WINDOW_S = 0.05;
/** A window is speech when it is louder than this share of the file's loud level (95th percentile)… */
const SPEECH_SHARE = 0.2;
/** …and never quieter than this absolute RMS (silence and room noise). */
const SPEECH_FLOOR = 0.02;
/** Shorter blips are not speech. */
const MIN_SPEECH = 0.15;

/** Where a voice file has speech, in file seconds (for videos whose captions are hidden or empty). */
export function speechInFile(samples: Float32Array, rate: number): SpeechSpan[] {
  const n = Math.max(1, Math.round(WINDOW_S * rate));
  const rms: number[] = [];
  for (let i = 0; i < samples.length; i += n) {
    let sum = 0;
    const end = Math.min(samples.length, i + n);
    for (let j = i; j < end; j++) sum += samples[j]! * samples[j]!;
    rms.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  const loud = [...rms].sort((a, b) => a - b)[Math.floor(rms.length * 0.95)] ?? 0;
  const threshold = Math.max(SPEECH_FLOOR, loud * SPEECH_SHARE);
  const spans: SpeechSpan[] = [];
  rms.forEach((r, i) => {
    if (r < threshold) return;
    const t = i * WINDOW_S;
    const last = spans.at(-1);
    if (last && t - last[1] < SPEECH_GAP) last[1] = t + WINDOW_S;
    else spans.push([t, t + WINDOW_S]);
  });
  return spans.filter(([s, e]) => e - s >= MIN_SPEECH);
}

/** File-second spans of the voice placed on the video (its start and trim). */
export function voiceOnTimeline(spans: SpeechSpan[], track: { start: number; trim_in: number; trim_out?: number | null }): SpeechSpan[] {
  const out: SpeechSpan[] = [];
  const last = track.trim_out ?? Infinity;
  for (const [s, e] of spans) {
    const a = Math.max(s, track.trim_in);
    const b = Math.min(e, last);
    if (b > a) out.push([track.start + a - track.trim_in, track.start + b - track.trim_in]);
  }
  return out;
}
