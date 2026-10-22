/**
 * The voice-over's placement on the timeline, cuts included (mirrors scene::AudioTrack): the file plays
 * from `trim_in` to `trim_out`, skipping every `cuts` range, and what follows a cut plays right on.
 */
export type AudioTrack = { start: number; trim_in: number; trim_out: number | null; cuts?: [number, number][] };

/** One audible piece: where it starts on the video and the file range it plays. */
export type AudioPiece = { at: number; from: number; to: number };

/** The audible pieces in play order; `fileLength` closes an open end. */
export function audioPieces(track: AudioTrack, fileLength = Infinity): AudioPiece[] {
  const end = Math.min(track.trim_out ?? fileLength, fileLength);
  const out: AudioPiece[] = [];
  let at = track.start;
  let from = track.trim_in;
  for (const [a, b] of track.cuts ?? []) {
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

/** File second heard at video second `t`, or null while the voice is silent there. */
export function audioFileAt(track: AudioTrack, t: number, fileLength = Infinity): number | null {
  for (const p of audioPieces(track, fileLength)) if (t >= p.at && t < p.at + (p.to - p.from)) return p.from + (t - p.at);
  return null;
}

/** Video second where the voice stops. */
export function audioEnd(track: AudioTrack, fileLength = Infinity): number {
  const last = audioPieces(track, fileLength).at(-1);
  return last ? last.at + (last.to - last.from) : track.start;
}
