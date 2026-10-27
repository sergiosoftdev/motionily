/**
 * Multicam, as in Premiere, Resolve or Final Cut: one clip on the timeline that can show any of several
 * camera angles of the same moment, lined up by their sound. A clip carries its angles (`multicam` field:
 * every angle's file offset from the first one); switching cuts it at the playhead and points the piece
 * after the cut at the other camera's file, at the same moment. The sound stays with the first angle (an
 * audio layer under the clip), so cuts never jump in the audio.
 *
 * Kept free of runtime imports so node's test runner loads it on its own.
 */

export type MulticamAngle = { src: string; offset: number; name?: string };
export type Multicam = { group: string; angle: number; angles: MulticamAngle[] };

/** A video layer with angles, as the switch needs it. */
export type MulticamClip = { id: string; start: number; end: number; in: number; speed: number; src: string; multicam: Multicam };

type Op = { op: string; [k: string]: unknown };

const round = (v: number) => Math.round(v * 1000) / 1000;

export const angleName = (m: Multicam, k: number) => m.angles[k]?.name || `Angle ${k + 1}`;

/** Angle `k`'s file second at timeline second `t` of the clip (the same moment the clip shows now). */
export function angleTime(c: MulticamClip, k: number, t: number): number {
  const m = c.multicam;
  return c.in + (t - c.start) * c.speed - (m.angles[m.angle]?.offset ?? 0) + (m.angles[k]?.offset ?? 0);
}

/** The layer's angles when it is a multicam video clip (anything else: null). */
export function multicamOf(l: { id: string; type: string; src?: unknown; start?: number; end?: number | null; in?: number; speed?: number; multicam?: unknown }, duration: number): MulticamClip | null {
  const m = l.multicam as Multicam | undefined;
  if (l.type !== "video" || !m || !Array.isArray(m.angles) || m.angles.length < 2) return null;
  return { id: l.id, start: l.start ?? 0, end: l.end ?? duration, in: l.in ?? 0, speed: l.speed ?? 1, src: String(l.src ?? ""), multicam: { ...m, angle: Math.min(Math.max(0, m.angle ?? 0), m.angles.length - 1) } };
}

/** The multicam clip under timeline second `t` (the topmost when several are), or null. */
export function multicamAt<L extends { id: string; type: string; start?: number; end?: number | null; multicam?: unknown }>(layers: L[], t: number, duration: number): MulticamClip | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const c = multicamOf(layers[i]!, duration);
    if (c && t >= c.start - 1e-4 && t < c.end - 1e-4) return c;
  }
  return null;
}

/**
 * Show angle `k` from timeline second `at` on: a cut at `at` (when it is inside the clip by more than half a
 * frame) and the piece after it switched; at the clip's start the whole clip switches. `length(src)` is a
 * file's length when known. Throws when that camera has no picture there.
 */
export function switchAngleOps(c: MulticamClip, k: number, at: number, fps: number, newId: string, length: (src: string) => number | null = () => null): Op[] {
  const m = c.multicam;
  const angle = m.angles[k];
  if (!angle) throw new Error(`${c.id} has ${m.angles.length} angles (asked for angle ${k + 1})`);
  if (k === m.angle) return [];
  const half = 0.5 / Math.max(1, fps);
  const cut = at > c.start + half && at < c.end - half;
  const from = cut ? at : c.start;
  const fileIn = angleTime(c, k, from);
  const len = (c.end - from) * c.speed;
  const file = length(angle.src);
  if (fileIn < -half || (file != null && fileIn + len > file + 2 * half)) {
    const have = file != null ? ` (its file covers ${round(-fileIn + from)}–${round(file - fileIn + from)} s here)` : "";
    throw new Error(`${angleName(m, k)} has no picture from ${round(from)} to ${round(c.end)} s${have}`);
  }
  const fields = { src: angle.src, in: round(Math.max(0, fileIn)), out: round(Math.max(0, fileIn) + len), multicam: { ...m, angle: k } };
  return cut ? [{ op: "split_layer", id: c.id, at: round(at), new_id: newId }, { op: "patch", id: newId, fields }] : [{ op: "patch", id: c.id, fields }];
}

/**
 * Make a video clip multicam: its own file is angle 1 (offset 0), `others` follow with their offsets
 * (from the waveform sync). Its sound moves to an audio layer under it so switching angles never cuts it.
 */
export function createMulticamOps(
  clip: { id: string; src: string; start: number; end: number; in: number; out: number | null; speed: number; volume: number; track?: string | null },
  others: MulticamAngle[],
  opts: { group: string; audioId: string; name?: string; size: [number, number] },
): Op[] {
  const [w, h] = opts.size;
  const angles: MulticamAngle[] = [{ src: clip.src, offset: 0, ...(opts.name ? { name: opts.name } : {}) }, ...others.map((a) => ({ ...a, offset: round(a.offset) }))];
  const out = clip.out ?? clip.in + (clip.end - clip.start) * clip.speed;
  return [
    { op: "patch", id: clip.id, fields: { multicam: { group: opts.group, angle: 0, angles }, volume: 0 } },
    { op: "add_layer", layer: { id: opts.audioId, type: "audio", start: clip.start, end: clip.end, x: w / 2, y: h / 2, w: 2, h: 2, src: clip.src, in: clip.in, out: round(out), speed: clip.speed, volume: clip.volume || 1 } },
  ];
}

/** A group id no layer uses yet ("mc1", "mc2"…). */
export function freshGroup(layers: { multicam?: unknown }[]): string {
  const used = new Set(layers.map((l) => (l.multicam as Multicam | undefined)?.group).filter(Boolean));
  let n = 1;
  while (used.has(`mc${n}`)) n++;
  return `mc${n}`;
}
