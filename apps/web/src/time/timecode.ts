/**
 * SMPTE timecode at the scene's frame rate: `HH:MM:SS:FF`, and drop-frame `HH:MM:SS;FF` at 29.97 and
 * 59.94 fps (frame numbers 0 and 1 — 0 to 3 at 59.94 — are skipped at the start of every minute except
 * every tenth, so the clock stays on wall time). Reading what people type works the way editors do:
 * a timecode, digits filled from the right (`512` = 5 s 12 f), seconds with a decimal point (`5.4`),
 * or `+N` / `-N` frames from where the playhead is.
 */

/** 29.97 / 59.94 (NTSC rates): counted in drop-frame timecode. */
export function isDropFrame(fps: number) {
  return Math.abs(fps - 30000 / 1001) < 0.01 || Math.abs(fps - 60000 / 1001) < 0.01;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The frame number `t` seconds falls on. */
export const frameAt = (t: number, fps: number) => Math.round(Math.max(0, t) * fps);

/** `HH:MM:SS:FF`, or `HH:MM:SS;FF` in drop-frame. */
export function timecode(t: number, fps: number): string {
  let frame = frameAt(t, fps);
  const base = Math.round(fps);
  const drop = isDropFrame(fps);
  if (drop) {
    // Frame count → drop-frame display: add back the numbers skipped so far.
    const skip = base === 60 ? 4 : 2;
    const perMin = base * 60 - skip;
    const per10 = base * 600 - skip * 9;
    const tens = Math.floor(frame / per10);
    const rest = frame % per10;
    frame += skip * 9 * tens + (rest > skip ? skip * Math.floor((rest - skip) / perMin) : 0);
  }
  const ff = frame % base;
  const s = Math.floor(frame / base);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}${drop ? ";" : ":"}${pad(ff)}`;
}

/** Seconds of a timecode's fields (drop-frame numbering when the rate is). */
function fromFields(h: number, m: number, s: number, f: number, fps: number): number {
  const base = Math.round(fps);
  let frame = (h * 3600 + m * 60 + s) * base + f;
  if (isDropFrame(fps)) {
    const skip = base === 60 ? 4 : 2;
    const minutes = h * 60 + m;
    frame -= skip * (minutes - Math.floor(minutes / 10));
  }
  return frame / fps;
}

/**
 * Seconds for what was typed, or null: `00:00:05:12` / `5;12` / `0:05:12` (a timecode, the last field
 * frames), `512` (digits filled from the right: 5 s 12 f), `5.4` (seconds), `+10` / `-10` (frames from
 * `current`).
 */
export function parseTimecode(input: string, fps: number, current = 0): number | null {
  const s = input.trim().replace(",", ".");
  if (!s) return null;
  const rel = /^([+-])\s*(\d+)$/.exec(s);
  if (rel) return Math.max(0, current + (rel[1] === "-" ? -1 : 1) * (Number(rel[2]) / fps));
  if (/^\d*\.\d+$|^\d+\.$/.test(s)) return Number(s);
  let fields: number[];
  if (/[:;]/.test(s)) {
    fields = s.split(/[:;]/).map((x) => (x === "" ? 0 : Number(x)));
    if (fields.some((n) => !Number.isInteger(n) || n < 0) || fields.length > 4) return null;
  } else if (/^\d{1,8}$/.test(s)) {
    // Right-aligned digits, two per field: "512" → 00:00:05:12.
    const d = s.padStart(8, "0");
    fields = [0, 2, 4, 6].map((i) => Number(d.slice(i, i + 2)));
  } else return null;
  const [h = 0, m = 0, sec = 0, f = 0] = [0, 0, 0, 0, ...fields].slice(-4);
  if (f >= Math.round(fps)) return null;
  return fromFields(h, m, sec, f, fps);
}
