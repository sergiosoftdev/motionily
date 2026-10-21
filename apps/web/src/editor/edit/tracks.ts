import { OpName, type FootageClip, type Op } from "@motionily/protocol";
import { isKeyWord, type CaptionWord } from "../../captions/transcribe";
import { VIDEO_LAYER } from "../../engine/video";
import type { SceneLayerView, SceneView } from "../sceneView";

/**
 * The Edit view's tracks, read from the scene: video clips (on lanes, like CapCut's main track and
 * overlays), blocks of motion graphics, captions and sound effects. Edits go back as ordinary ops, so
 * the agent, autosave and the other modes see exactly the same video.
 */

/** Shortest clip or block a trim leaves, in seconds. */
export const MIN_CLIP = 0.1;
/** Layers this close to covering the whole video are the backdrop (background, camera, grain), not a block. */
const FULL_LENGTH = 0.9;
const EPS = 0.001;

export type EditClip = {
  id: string;
  /** The footage clip it comes from (c1…), when it is the user's own. */
  footage: FootageClip | null;
  name: string;
  src: string;
  start: number;
  end: number;
  in: number;
  out: number | null;
  speed: number;
  volume: number;
  scale: number;
  lane: number;
};

/** Layers of motion graphics shown and moved as one piece: a group, or layers that overlap in time. */
export type GraphicsBlock = { key: string; label: string; group: string | null; ids: string[]; start: number; end: number; lane: number };

export type EditTracks = { clips: EditClip[]; lanes: number; blocks: GraphicsBlock[]; blockLanes: number; backdrop: string[] };

const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);
const endOf = (l: SceneLayerView, duration: number) => (l.end == null ? duration : l.end);

export function editTracks(scene: SceneView, footage: FootageClip[]): EditTracks {
  const duration = scene.duration;
  const byUrl = new Map(footage.map((c) => [c.url, c]));
  const clips: EditClip[] = [];
  const lanesEnd: number[] = [];
  const videos = scene.layers.filter((l) => l.type === VIDEO_LAYER).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  for (const l of videos) {
    const start = l.start ?? 0;
    const end = endOf(l, duration);
    let lane = lanesEnd.findIndex((e) => e <= start + EPS);
    if (lane < 0) lane = lanesEnd.push(end) - 1;
    else lanesEnd[lane] = end;
    const src = String(l.src ?? "");
    const fc = byUrl.get(src) ?? null;
    clips.push({
      id: l.id,
      footage: fc,
      name: fc ? `${fc.id} · ${fc.name}` : (src.split("/").pop() ?? l.id),
      src,
      start,
      end,
      in: num(l.in, 0),
      out: typeof l.out === "number" ? l.out : null,
      speed: num(l.speed, 1),
      volume: num(l.volume, 0),
      scale: num(l.scale, 1),
      lane,
    });
  }

  const backdrop: string[] = [];
  const blocks: GraphicsBlock[] = [];
  const groups = new Map<string, GraphicsBlock>();
  const loose: SceneLayerView[] = [];
  for (const l of scene.layers) {
    if (l.type === VIDEO_LAYER) continue;
    const start = l.start ?? 0;
    const end = endOf(l, duration);
    if (end - start >= duration * FULL_LENGTH) {
      backdrop.push(l.id);
      continue;
    }
    if (l.group) {
      const b = groups.get(l.group);
      if (b) {
        b.ids.push(l.id);
        b.start = Math.min(b.start, start);
        b.end = Math.max(b.end, end);
      } else {
        const nb = { key: `g:${l.group}`, label: l.group.replace(/[_-]+/g, " "), group: l.group, ids: [l.id], start, end, lane: 0 };
        groups.set(l.group, nb);
        blocks.push(nb);
      }
    } else loose.push(l);
  }
  // Ungrouped layers: the ones that overlap in time make one block (a beat's title, its bar, its icon…).
  loose.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  let cur: (GraphicsBlock & { text: string | null }) | null = null;
  for (const l of loose) {
    const start = l.start ?? 0;
    const end = endOf(l, duration);
    if (cur && start < cur.end - EPS) {
      cur.ids.push(l.id);
      cur.end = Math.max(cur.end, end);
      cur.text ??= l.text ?? null;
      continue;
    }
    cur = { key: `l:${l.id}`, label: "", group: null, ids: [l.id], start, end, lane: 0, text: l.text ?? null };
    blocks.push(cur);
  }
  for (const b of blocks as (GraphicsBlock & { text?: string | null })[]) {
    if (!b.group) b.label = (b.text ?? b.ids[0]!).replace(/\s+/g, " ").trim();
    delete b.text;
  }
  blocks.sort((a, b) => a.start - b.start);
  // Blocks that overlap in time go on separate rows, like overlay clips.
  const rows: number[] = [];
  for (const b of blocks) {
    let row = rows.findIndex((e) => e <= b.start + EPS);
    if (row < 0) row = rows.push(b.end) - 1;
    else rows[row] = b.end;
    b.lane = row;
  }
  return { clips, lanes: Math.max(1, lanesEnd.length), blocks, blockLanes: Math.max(1, rows.length), backdrop };
}

/** File second at the end of a clip (out, or where its length on screen runs out). */
const fileEnd = (c: EditClip) => c.in + (c.end - c.start) * c.speed;

export function moveClipOps(c: EditClip, start: number): Op[] {
  const s = Math.max(0, start);
  return [{ op: OpName.SetTiming, id: c.id, start: s, end: s + (c.end - c.start) }];
}

/** Drag the clip's left or right edge to scene second `t`: the file window moves with it, the picture stays put. */
export function trimClipOps(c: EditClip, edge: "in" | "out", t: number): Op[] {
  if (edge === "in") {
    // Never before the file's first frame, never past the other edge.
    const start = Math.min(Math.max(t, c.start - c.in / c.speed, 0), c.end - MIN_CLIP);
    return [
      { op: OpName.SetTiming, id: c.id, start, end: c.end },
      { op: OpName.Patch, id: c.id, fields: { in: round(c.in + (start - c.start) * c.speed) } },
    ];
  }
  const fileLength = c.footage?.duration ?? Infinity;
  const end = Math.max(Math.min(t, c.start + (fileLength - c.in) / c.speed), c.start + MIN_CLIP);
  return [
    { op: OpName.SetTiming, id: c.id, start: c.start, end },
    { op: OpName.Patch, id: c.id, fields: { out: round(c.in + (end - c.start) * c.speed) } },
  ];
}

/** Cut the clip in two at scene second `t`; the second half is a copy of the layer named `newId`. */
export function splitClipOps(c: EditClip, t: number, layer: Record<string, unknown>, newId: string, index: number): Op[] | null {
  if (t <= c.start + MIN_CLIP || t >= c.end - MIN_CLIP) return null;
  const cutAt = round(c.in + (t - c.start) * c.speed);
  return [
    { op: OpName.SetTiming, id: c.id, start: c.start, end: t },
    { op: OpName.Patch, id: c.id, fields: { out: cutAt } },
    { op: OpName.AddLayer, layer: { ...layer, id: newId, start: t, end: c.end, in: cutAt, out: c.out ?? round(fileEnd(c)) } },
    { op: OpName.Reorder, id: newId, index: index + 1 },
  ];
}

/**
 * Delete a clip of the main track and close the gap, like CapCut's magnetic track: everything that
 * starts after it (clips, graphics, sound effects) moves back by its length, and the video gets shorter.
 */
export function rippleDeleteOps(c: EditClip, scene: SceneView): Op[] {
  const gap = c.end - c.start;
  const ops: Op[] = [{ op: OpName.RemoveLayer, id: c.id }];
  for (const l of scene.layers) {
    const start = l.start ?? 0;
    if (l.id === c.id || start < c.end - EPS) continue;
    ops.push({ op: OpName.SetTiming, id: l.id, start: round(start - gap), end: l.end == null ? null : round(l.end - gap) });
  }
  for (const cue of scene.sfx ?? []) {
    if (cue.at >= c.end - EPS) ops.push({ op: OpName.PutSfx, cue: { ...cue, at: round(cue.at - gap) } });
    else if (cue.at >= c.start) ops.push({ op: OpName.RemoveSfx, id: cue.id });
  }
  ops.push({ op: OpName.SetDuration, duration: round(Math.max(MIN_CLIP, scene.duration - gap)) });
  return ops;
}

/** Move a block of graphics by `dt` seconds (keyframes are relative to each layer, so the motion moves along). */
export function moveBlockOps(b: GraphicsBlock, dt: number, scene: SceneView): Op[] {
  const d = Math.max(dt, -b.start);
  return scene.layers
    .filter((l) => b.ids.includes(l.id))
    .map((l) => ({ op: OpName.SetTiming, id: l.id, start: round((l.start ?? 0) + d), end: l.end == null ? null : round(l.end + d) }));
}

/**
 * Captions of a video cut from the user's footage: every transcribed word the clips show, at the
 * second it plays. Re-run after any clip edit so captions (and @word timing) follow the cut.
 */
export function footageCaptions(clips: EditClip[]): CaptionWord[] {
  const words: CaptionWord[] = [];
  for (const c of clips) {
    const transcript = c.footage?.words;
    if (!transcript || c.volume <= 0) continue;
    const last = c.out ?? fileEnd(c);
    for (const w of transcript) {
      // A word belongs to the clip when most of it plays inside the clip's window.
      const mid = (w.start + w.end) / 2;
      if (mid < c.in || mid > last) continue;
      const start = round(c.start + (Math.max(w.start, c.in) - c.in) / c.speed);
      const end = round(c.start + (Math.min(w.end, last) - c.in) / c.speed);
      words.push({ text: w.text, start, end: Math.max(end, start + 0.05), ...(isKeyWord(w.text) ? { emphasis: true } : {}) });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

/** The video ends where its last clip does (an edit of footage is as long as its cut). */
export const cutLength = (clips: EditClip[]) => round(Math.max(MIN_CLIP, ...clips.map((c) => c.end)));

/** Put a whole footage clip at the end of the main track (full frame, its own sound), under the graphics. */
export function appendClipOps(fc: FootageClip, at: number, size: [number, number], id: string, under: number): Op[] {
  const length = fc.duration ?? 1;
  const [w, h] = size;
  return [
    {
      op: OpName.AddLayer,
      layer: { id, type: VIDEO_LAYER, start: round(at), end: round(at + length), group: FOOTAGE_GROUP, x: w / 2, y: h / 2, w, h, src: fc.url, fit: "cover", in: 0, out: round(length), volume: 1 },
    },
    { op: OpName.Reorder, id, index: under },
  ];
}

/** Layer group of the user's footage (the MCP's edit_footage writes the same). */
export const FOOTAGE_GROUP = "footage";

/** A layer id not used yet: `ft3` → `ft3b`, `ft3c`… */
export function freshId(base: string, taken: Set<string>) {
  for (let i = 0; i < 26; i++) {
    const id = `${base}${String.fromCharCode(98 + i)}`;
    if (!taken.has(id)) return id;
  }
  return `${base}_${Date.now().toString(36)}`;
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}
