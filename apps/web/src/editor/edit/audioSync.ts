/**
 * Waveform sync (Resolve's "auto sync audio based on waveform"): where a separately recorded sound (a lav,
 * a recorder) lines up with a camera clip's own sound. Both are reduced to loudness envelopes, cross-
 * correlated over every offset within reach, and the best one refined on the samples themselves.
 */

/** Envelope rate (windows per second) of the coarse search. */
const ENV_RATE = 200;
/** Sample rate of the fine search, and how far (s) around the coarse match it looks. */
const FINE_RATE = 8000;
const FINE_REACH = 0.02;

export type SyncMatch = {
  /** Seconds to add to a camera file time to get the same moment in the other file. */
  offset: number;
  /** Normalized correlation at the match (0..1; above ~0.5 is a clear match). */
  score: number;
  /** How far the best match stands out from the next best away from it (1 = no contest). */
  margin: number;
};

/** Mono samples of `x` (at `rate`) averaged down to `to` per second. */
export function resample(x: Float32Array, rate: number, to: number): Float32Array {
  const k = rate / to;
  const n = Math.floor(x.length / k);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * k);
    const b = Math.max(a + 1, Math.floor((i + 1) * k));
    let s = 0;
    for (let j = a; j < b; j++) s += x[j]!;
    out[i] = s / (b - a);
  }
  return out;
}

/** Loudness envelope: RMS over windows of `1 / to` s, log-compressed (so quiet speech still counts). */
export function envelope(x: Float32Array, rate: number, to = ENV_RATE): Float32Array {
  const w = Math.max(1, Math.round(rate / to));
  const n = Math.floor(x.length / w);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * w; j < (i + 1) * w; j++) s += x[j]! * x[j]!;
    out[i] = Math.log10(1e-6 + Math.sqrt(s / w));
  }
  return out;
}

/** Normalized cross-correlation of `b` against `a` at lag `d` (b[i + d] vs a[i]), over their overlap (at least `minOverlap`). */
function ncc(a: Float32Array, b: Float32Array, d: number, minOverlap = 8): number {
  const i0 = Math.max(0, -d);
  const i1 = Math.min(a.length, b.length - d);
  // A short overlap correlates well by chance.
  if (i1 - i0 < minOverlap) return -1;
  let sa = 0;
  let sb = 0;
  for (let i = i0; i < i1; i++) {
    sa += a[i]!;
    sb += b[i + d]!;
  }
  const n = i1 - i0;
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = i0; i < i1; i++) {
    const x = a[i]! - ma;
    const y = b[i + d]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : -1;
}

/**
 * The offset (s) that lines `other` up with `camera`: `camera` file second f is `other` file second f + offset.
 * Searched within ±`reach` seconds of `around` (where they sit now); both are mono at `rate`.
 */
export function syncOffset(camera: Float32Array, other: Float32Array, rate: number, reach = 30, around = 0): SyncMatch {
  const ea = envelope(camera, rate);
  const eb = envelope(other, rate);
  const maxLag = Math.round(reach * ENV_RATE);
  const scores: number[] = [];
  let best = 0;
  // Offsets are only trusted where the sounds share enough: half the shorter one, at least 2 s.
  const minOverlap = Math.max(2 * ENV_RATE, Math.floor(Math.min(ea.length, eb.length) / 2));
  const from = Math.round(around * ENV_RATE) - maxLag;
  for (let d = from; d <= from + 2 * maxLag; d++) {
    const s = ncc(ea, eb, d, minOverlap);
    scores.push(s);
    if (s > scores[best]!) best = scores.length - 1;
  }
  const coarse = from + best;
  // The best score away from the peak (beyond 0.25 s), to tell a clear match from a guess.
  const away = scores.reduce((m, s, i) => (Math.abs(i - best) > ENV_RATE / 4 ? Math.max(m, s) : m), -1);
  // Refine on the samples around the coarse match.
  const fa = resample(camera, rate, FINE_RATE);
  const fb = resample(other, rate, FINE_RATE);
  const center = Math.round((coarse / ENV_RATE) * FINE_RATE);
  const reachFine = Math.round(FINE_REACH * FINE_RATE);
  let fine = center;
  let fineScore = -2;
  for (let d = center - reachFine; d <= center + reachFine; d++) {
    const s = ncc(fa, fb, d);
    if (s > fineScore) [fine, fineScore] = [d, s];
  }
  const score = scores[best]!;
  return { offset: fine / FINE_RATE, score: Math.max(0, score), margin: away > 0 ? score / away : Infinity };
}

/** What a sync needs to know of the two clips on the timeline. */
export type SyncClip = { id: string; src: string; start: number; end: number; in: number; speed: number };

/** Mono channel of a decoded buffer (its first channel: both mics hear the same moment). */
const mono = (b: AudioBuffer) => b.getChannelData(0);

/**
 * Line the sound clip `audio` up with the video clip `video` by their waveforms: the sound moves to play
 * the matching moment under the picture (start, in, end follow the clip) and the clip's own sound is
 * muted. Returns the ops and the match. Both at normal speed.
 */
export async function syncAudioOps(video: SyncClip, audio: SyncClip, decode: (src: string, video: boolean) => Promise<AudioBuffer | null>): Promise<{ ops: { op: string; [k: string]: unknown }[]; match: SyncMatch }> {
  if (Math.abs(video.speed - 1) > 1e-3 || Math.abs(audio.speed - 1) > 1e-3) throw new Error("sync works on clips at normal speed (set speed 1 first)");
  const [cam, rec] = await Promise.all([decode(video.src, true), decode(audio.src, false)]);
  if (!cam) throw new Error(`${video.id} has no sound to sync by`);
  if (!rec) throw new Error(`${audio.id}'s file could not be read`);
  // Where they line up now: the sound's file second under the clip's first frame, minus the clip's.
  const around = audio.in + (video.start - audio.start) - video.in;
  const rate = cam.sampleRate === rec.sampleRate ? cam.sampleRate : 0;
  const camera = rate ? mono(cam) : resample(mono(cam), cam.sampleRate, FINE_RATE);
  const other = rate ? mono(rec) : resample(mono(rec), rec.sampleRate, FINE_RATE);
  const match = syncOffset(camera, other, rate || FINE_RATE, 30, around);
  // The sound plays file second (clip in + offset) at the clip's start; it cannot start before its file does.
  let start = video.start;
  let fileIn = video.in + match.offset;
  if (fileIn < 0) {
    start -= fileIn;
    fileIn = 0;
  }
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const ops = [
    { op: "set_timing", id: audio.id, start: round(start), end: round(video.end) },
    { op: "patch", id: audio.id, fields: { in: round(fileIn), out: null } },
    { op: "patch", id: video.id, fields: { volume: 0 } },
  ];
  return { ops, match };
}

/** The two layers of the scene as sync takes them (by id), or an error naming what is wrong. */
export function syncClipsOf(scene: { layers?: { id: string; type: string; src?: string; start?: number; end?: number | null; in?: number; speed?: number }[]; duration: number }, videoId: string, audioId: string): [SyncClip, SyncClip] {
  const pick = (id: string, type: string): SyncClip => {
    const l = scene.layers?.find((x) => x.id === id);
    if (!l || l.type !== type || !l.src) throw new Error(`${id} is not ${type === "video" ? "a video clip" : "a sound clip (an audio layer)"}`);
    return { id, src: l.src, start: l.start ?? 0, end: l.end ?? scene.duration, in: l.in ?? 0, speed: l.speed ?? 1 };
  };
  return [pick(videoId, "video"), pick(audioId, "audio")];
}
