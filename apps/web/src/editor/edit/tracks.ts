import { MediaKind, OpName, TrackKind, type FootageClip, type MediaItem, type Op, type Track, type TrackSwitch } from "@motionily/protocol";
import { isKeyWord, type CaptionWord } from "../../captions/transcribe";
import { AUDIO_LAYER, VIDEO_LAYER } from "../../engine/video";
export { AUDIO_LAYER };
import type { SceneLayerView, SceneView } from "../sceneView";
import { overlapMatches, readTransition, refitTransitionOps, roomAfter, roomBefore, round, shiftAfterOps, stripTransitionFields, stripTransitionOps, type ClipTransition } from "./transitions";
import { readVolume, shiftKeys, type VolumeKey } from "./volume";

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

/** What a timeline clip shows or plays: a video clip, a picture held on the video track, or a sound. */
export const ClipKind = { Video: "video", Image: "image", Audio: "audio", Compound: "compound" } as const;
export type ClipKind = (typeof ClipKind)[keyof typeof ClipKind];

/** The scene's layer type for pictures. */
const IMAGE_LAYER = "image";
/** A component instance: one holding clips is a compound clip on the video track. */
const INSTANCE_LAYER = "use";
/** Component names compound clips get (`compound_1`, …), and their instances' ids. */
export const COMPOUND_PREFIX = "compound";
/** Seconds a picture gets when it is dropped on the timeline. */
export const IMAGE_SECONDS = 3;

export type EditClip = {
  id: string;
  kind: ClipKind;
  /** Seconds of the file (null = unknown, or a picture: no end). */
  fileLength: number | null;
  /** The footage clip it comes from (c1…), when it is the user's own. */
  footage: FootageClip | null;
  name: string;
  src: string;
  start: number;
  end: number;
  in: number;
  out: number | null;
  speed: number;
  /** Loudest level of its sound (0 = muted throughout); `volumeKeys` when it changes over the clip. */
  volume: number;
  volumeKeys: VolumeKey[] | null;
  scale: number;
  lane: number;
  /** Main track: the transition it enters with (it overlaps the clip before by its length). */
  transition: ClipTransition | null;
  /** Main track: length of the transition into the next clip (0 = a plain cut). */
  outgoing: number;
};

/** Layers of motion graphics shown and moved as one piece: a group, or layers that overlap in time. */
export type GraphicsBlock = { key: string; label: string; group: string | null; ids: string[]; start: number; end: number; lane: number };

export type EditTracks = {
  /** The video track: clips and pictures, on the main lane (0) and overlay lanes. */
  clips: EditClip[];
  lanes: number;
  /** Sound clips, on their own lanes under the video. */
  audio: EditClip[];
  audioLanes: number;
  /** The track of each lane (index = lane): the scene's, or V1… / A1… until the scene has tracks. */
  videoTracks: Track[];
  audioTracks: Track[];
  blocks: GraphicsBlock[];
  blockLanes: number;
  backdrop: string[];
};

const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);
const endOf = (l: SceneLayerView, duration: number) => (l.end == null ? duration : l.end);

/** A picture the user put on the video track (from the media pool), as opposed to one in the graphics. */
const isPictureClip = (l: SceneLayerView) => l.type === IMAGE_LAYER && l.group === FOOTAGE_GROUP;

/** The clips inside a compound clip (an instance whose component holds clips or sounds), or null. */
export function compoundInside(l: SceneLayerView, scene: SceneView): SceneLayerView[] | null {
  if (l.type !== INSTANCE_LAYER) return null;
  const inner = scene.library?.components?.[String((l as { comp?: string }).comp ?? "")]?.layers ?? [];
  const media = inner.filter((x) => x.type === VIDEO_LAYER || x.type === AUDIO_LAYER || isPictureClip(x));
  return media.length ? media : null;
}

export function editTracks(scene: SceneView, footage: FootageClip[], media: MediaItem[] = []): EditTracks {
  const duration = scene.duration;
  const byUrl = new Map(footage.map((c) => [c.url, c]));
  const mediaByUrl = new Map(media.map((m) => [m.url, m]));
  const clips: EditClip[] = [];
  const lanesEnd: number[] = [];
  const videos = scene.layers.filter((l) => l.type === VIDEO_LAYER || isPictureClip(l) || compoundInside(l, scene)).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  // Lanes follow the scene's tracks when it has them (V1 = main lane); layers without one pack in.
  const sceneVideo = (scene.tracks ?? []).filter((t) => t.kind === TrackKind.Video);
  const sceneAudio = (scene.tracks ?? []).filter((t) => t.kind === TrackKind.Audio);
  const laneOf = (l: SceneLayerView, list: Track[]) => {
    const i = typeof l.track === "string" ? list.findIndex((t) => t.id === l.track) : -1;
    return i >= 0 ? i : null;
  };
  /** Last clip placed on the main track. */
  let main: EditClip | null = null;
  for (const l of videos) {
    const start = l.start ?? 0;
    const end = endOf(l, duration);
    // A clip that overlaps the end of the main track's last clip by exactly its transition stays on the main track.
    const tr = main && start > main.start + EPS && start < main.end - EPS ? readTransition(l) : null;
    const into: ClipTransition | null = main && tr && overlapMatches(main.end - start, tr.duration) ? { ...tr, from: main.id } : null;
    const fixed = laneOf(l, sceneVideo);
    let lane = fixed ?? (into ? 0 : lanesEnd.findIndex((e, i) => e <= start + EPS && !sceneVideo[i]));
    if (fixed !== null) {
      while (lanesEnd.length <= fixed) lanesEnd.push(0);
      lanesEnd[fixed] = Math.max(lanesEnd[fixed]!, end);
    } else if (lane < 0) lane = lanesEnd.push(end) - 1;
    else lanesEnd[lane] = end;
    if (into && main) main.outgoing = into.duration;
    const src = String(l.src ?? "");
    const fc = byUrl.get(src) ?? null;
    const volume = readVolume(l.volume);
    const picture = l.type === IMAGE_LAYER;
    const inner = compoundInside(l, scene);
    const clip: EditClip = {
      id: l.id,
      kind: inner ? ClipKind.Compound : picture ? ClipKind.Image : ClipKind.Video,
      fileLength: picture || inner ? null : (fc?.duration ?? null),
      footage: fc,
      name: inner ? `Compound · ${inner.length} clips` : fc ? `${fc.id} · ${fc.name}` : (mediaByUrl.get(src)?.name ?? src.split("/").pop() ?? l.id),
      src,
      start,
      end,
      in: num(l.in, 0),
      out: typeof l.out === "number" ? l.out : null,
      speed: num(l.speed, 1),
      volume: volume.level,
      volumeKeys: volume.keys,
      scale: num(l.scale, 1),
      lane,
      transition: into,
      outgoing: 0,
    };
    clips.push(clip);
    if (lane === 0) main = clip;
  }

  // Sound clips: lanes of their own, packed like overlays (no transitions between them).
  const audio: EditClip[] = [];
  const audioEnd: number[] = [];
  for (const l of scene.layers.filter((x) => x.type === AUDIO_LAYER).sort((a, b) => (a.start ?? 0) - (b.start ?? 0))) {
    const start = l.start ?? 0;
    const end = endOf(l, duration);
    const fixed = laneOf(l, sceneAudio);
    let lane = fixed ?? audioEnd.findIndex((e, i) => e <= start + EPS && !sceneAudio[i]);
    if (fixed !== null) {
      while (audioEnd.length <= fixed) audioEnd.push(0);
      audioEnd[fixed] = Math.max(audioEnd[fixed]!, end);
    } else if (lane < 0) lane = audioEnd.push(end) - 1;
    else audioEnd[lane] = end;
    const src = String(l.src ?? "");
    const item = mediaByUrl.get(src);
    const volume = readVolume(l.volume);
    audio.push({
      id: l.id,
      kind: ClipKind.Audio,
      fileLength: item?.duration ?? null,
      footage: null,
      name: item?.name ?? src.split("/").pop() ?? l.id,
      src,
      start,
      end,
      in: num(l.in, 0),
      out: typeof l.out === "number" ? l.out : null,
      speed: num(l.speed, 1),
      volume: volume.level,
      volumeKeys: volume.keys,
      scale: 1,
      lane,
      transition: null,
      outgoing: 0,
    });
  }

  const backdrop: string[] = [];
  const blocks: GraphicsBlock[] = [];
  const groups = new Map<string, GraphicsBlock>();
  const loose: SceneLayerView[] = [];
  for (const l of scene.layers) {
    if (l.type === VIDEO_LAYER || l.type === AUDIO_LAYER || isPictureClip(l) || compoundInside(l, scene)) continue;
    // A clip's color windows live in its Color tab, not among the graphics.
    if ((l as { attach?: string }).attach) continue;
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
  const lanes = Math.max(1, lanesEnd.length, sceneVideo.length);
  const audioLanes = Math.max(1, audioEnd.length, sceneAudio.length);
  const named = (list: Track[], n: number, kind: TrackKind, prefix: string) => Array.from({ length: n }, (_, i) => list[i] ?? { id: `${prefix}${i + 1}`, kind });
  return {
    clips,
    lanes,
    audio,
    audioLanes,
    videoTracks: named(sceneVideo, lanes, TrackKind.Video, "V"),
    audioTracks: named(sceneAudio, audioLanes, TrackKind.Audio, "A"),
    blocks,
    blockLanes: Math.max(1, rows.length),
    backdrop,
  };
}

/**
 * The scene's tracks as the timeline shows them, written down (with one more lane of each kind when
 * asked), and every clip pinned to its lane's track: done once, the first time a track is touched.
 */
function settleTracks(t: EditTracks, extra: { video?: number; audio?: number } = {}): { tracks: Track[]; ops: Op[] } {
  const more = (list: Track[], n: number, kind: TrackKind, prefix: string) => [...list, ...Array.from({ length: n }, (_, i) => ({ id: `${prefix}${list.length + i + 1}`, kind }))];
  const video = more(t.videoTracks, extra.video ?? 0, TrackKind.Video, "V");
  const audio = more(t.audioTracks, extra.audio ?? 0, TrackKind.Audio, "A");
  const pin = (c: EditClip, list: Track[]): Op[] => [{ op: OpName.Patch, id: c.id, fields: { track: list[c.lane]!.id } }];
  return { tracks: [...video, ...audio], ops: [...t.clips.flatMap((c) => pin(c, video)), ...t.audio.flatMap((c) => pin(c, audio))] };
}

/**
 * Enough tracks for an imported timeline (`video` V tracks, `audio` A tracks), written down with every clip
 * pinned to its lane, and the scene track an imported "V2" / "A1" goes on.
 */
export function importTracksOps(t: EditTracks, video: number, audio: number): { ops: Op[]; trackOf: (id: string) => string } {
  const { tracks, ops } = settleTracks(t, { video: Math.max(0, video - t.videoTracks.length), audio: Math.max(0, audio - t.audioTracks.length) });
  const list = (kind: TrackKind) => tracks.filter((x) => x.kind === kind);
  const trackOf = (id: string) => {
    const of = list(id.startsWith("A") ? TrackKind.Audio : TrackKind.Video);
    return of[Math.min(Math.max(0, (Number(id.slice(1)) || 1) - 1), of.length - 1)]!.id;
  };
  return { ops: [{ op: OpName.SetTracks, tracks }, ...ops], trackOf };
}

/** Flip one switch (hide, mute, solo, lock) of the track of `lane`. */
export function trackSwitchOps(t: EditTracks, kind: TrackKind, lane: number, sw: TrackSwitch): Op[] {
  const { tracks, ops } = settleTracks(t);
  const id = (kind === TrackKind.Video ? t.videoTracks : t.audioTracks)[lane]!.id;
  const next = tracks.map((x) => (x.id === id ? { ...x, [sw]: !x[sw] } : x));
  return [{ op: OpName.SetTracks, tracks: next }, ...ops];
}

/** Set fields of track `id` (the mixer's volume and pan), making the scene's tracks explicit first. */
export function trackFieldsOps(t: EditTracks, id: string, fields: Partial<Track>): Op[] {
  const { tracks, ops } = settleTracks(t);
  return [{ op: OpName.SetTracks, tracks: tracks.map((x) => (x.id === id ? { ...x, ...fields } : x)) }, ...ops];
}

/** Rename the track of `lane`. */
export function renameTrackOps(t: EditTracks, kind: TrackKind, lane: number, name: string): Op[] {
  const { tracks, ops } = settleTracks(t);
  const id = (kind === TrackKind.Video ? t.videoTracks : t.audioTracks)[lane]!.id;
  return [{ op: OpName.SetTracks, tracks: tracks.map((x) => (x.id === id ? { ...x, name: name.trim() || undefined } : x)) }, ...ops];
}

/** Put a clip on the track of `lane` (a lane past the last one makes a new track). */
export function moveToLaneOps(t: EditTracks, c: EditClip, lane: number): Op[] {
  const audio = c.kind === ClipKind.Audio;
  const count = audio ? t.audioLanes : t.lanes;
  const { tracks, ops } = settleTracks(t, audio ? { audio: lane >= count ? 1 : 0 } : { video: lane >= count ? 1 : 0 });
  const list = tracks.filter((x) => x.kind === (audio ? TrackKind.Audio : TrackKind.Video));
  const target = list[Math.min(lane, list.length - 1)]!;
  return [{ op: OpName.SetTracks, tracks }, ...ops, { op: OpName.Patch, id: c.id, fields: { track: target.id } }];
}

/** The clip's track is locked (no moving, trimming or deleting it in the editor). */
export function clipLocked(t: EditTracks, c: EditClip): boolean {
  return !!(c.kind === ClipKind.Audio ? t.audioTracks : t.videoTracks)[c.lane]?.locked;
}

/** File second at the end of a clip (out, or where its length on screen runs out). */
const fileEnd = (c: EditClip) => c.in + (c.end - c.start) * c.speed;

/** The main-track clip a transition leads into from `c` (the next clip overlaps `c` by it). */
const nextOf = (c: EditClip, tracks: EditTracks) => tracks.clips.find((x) => x.transition?.from === c.id) ?? null;
const clipById = (id: string, tracks: EditTracks) => tracks.clips.find((x) => x.id === id) ?? tracks.audio.find((x) => x.id === id) ?? null;

/** Seconds of the scene where the clip is what shows: its transitions give half their length to each side. */
export const shownSpan = (c: EditClip): [number, number] => [c.start + (c.transition?.duration ?? 0) / 2, c.end - c.outgoing / 2];

/** Move a clip in time. On the main track, its transitions go: they belong to the cuts it leaves. */
export function moveClipOps(c: EditClip, start: number, scene: SceneView, tracks: EditTracks): Op[] {
  const s = Math.max(0, start);
  const next = nextOf(c, tracks);
  return [
    { op: OpName.SetTiming, id: c.id, start: s, end: s + (c.end - c.start) },
    ...(c.transition ? stripTransitionOps(scene, c.id) : []),
    ...(next ? stripTransitionOps(scene, next.id) : []),
  ];
}

/** Drag the clip's left or right edge to scene second `t`: the file window moves with it, the picture stays put. */
export function trimClipOps(c: EditClip, edge: "in" | "out", t: number): Op[] {
  return trimmed(c, edge, t).ops;
}

/** A trim's ops and where the clip ends up. */
function trimmed(c: EditClip, edge: "in" | "out", t: number): { ops: Op[]; start: number; end: number } {
  // A picture has no file time: its edges only change how long it holds.
  if (c.kind === ClipKind.Image) {
    const start = edge === "in" ? Math.min(Math.max(t, 0), c.end - MIN_CLIP) : c.start;
    const end = edge === "out" ? Math.max(t, c.start + MIN_CLIP) : c.end;
    return { ops: [{ op: OpName.SetTiming, id: c.id, start, end }], start, end };
  }
  if (edge === "in") {
    // Never before the file's first frame, never past the other edge.
    const start = Math.min(Math.max(t, c.start - c.in / c.speed, 0), c.end - MIN_CLIP);
    const fields: Record<string, unknown> = { in: round(c.in + (start - c.start) * c.speed) };
    // Volume keys stay on the same sound while the start moves.
    if (c.volumeKeys) fields.volume = shiftKeys(c.volumeKeys, start - c.start);
    const ops: Op[] = [
      { op: OpName.SetTiming, id: c.id, start, end: c.end },
      { op: OpName.Patch, id: c.id, fields },
    ];
    return { ops, start, end: c.end };
  }
  const fileLength = c.fileLength ?? c.footage?.duration ?? Infinity;
  const end = Math.max(Math.min(t, c.start + (fileLength - c.in) / c.speed), c.start + MIN_CLIP);
  const ops: Op[] = [
    { op: OpName.SetTiming, id: c.id, start: c.start, end },
    { op: OpName.Patch, id: c.id, fields: { out: round(c.in + (end - c.start) * c.speed) } },
  ];
  return { ops, start: c.start, end };
}

/**
 * Trim with the main track's transitions kept whole: an edge that holds a transition stops where it
 * would grow past what fits, and the transition takes the new overlap (or goes when there is none).
 */
export function trimWithTransitionsOps(c: EditClip, edge: "in" | "out", t: number, scene: SceneView, tracks: EditTracks): Op[] {
  const prev = edge === "in" && c.transition ? clipById(c.transition.from, tracks) : null;
  if (prev) {
    const r = trimmed(c, edge, Math.max(t, prev.end - roomAfter(prev)));
    return [...r.ops, ...refitTransitionOps(scene, prev, { ...c, start: r.start }, prev.end - r.start)];
  }
  const next = edge === "out" ? nextOf(c, tracks) : null;
  if (next) {
    const r = trimmed(c, edge, Math.min(t, next.start + roomBefore(next)));
    return [...r.ops, ...refitTransitionOps(scene, { ...c, end: r.end }, next, r.end - next.start)];
  }
  return trimClipOps(c, edge, t);
}

/** Cut the clip in two at scene second `t`; the second half is a copy of the layer named `newId`. */
export function splitClipOps(c: EditClip, t: number, layer: Record<string, unknown>, newId: string, index: number): Op[] | null {
  // Never inside a transition: each half keeps its own.
  const [from, to] = shownSpan(c);
  if (t <= Math.max(c.start, from) + MIN_CLIP || t >= Math.min(c.end, to) - MIN_CLIP) return null;
  const cutAt = round(c.in + (t - c.start) * c.speed);
  if (c.kind === ClipKind.Image) {
    const still: Record<string, unknown> = { ...layer, ...(stripTransitionFields(layer as SceneLayerView) ?? {}), id: newId, start: t, end: c.end };
    for (const k of Object.keys(still)) if (still[k] === null) delete still[k];
    return [
      { op: OpName.SetTiming, id: c.id, start: c.start, end: t },
      { op: OpName.AddLayer, layer: still },
      { op: OpName.Reorder, id: newId, index: index + 1 },
    ];
  }
  // The second half starts at the cut: no way in, and its volume keys stay on the same sound.
  const copy: Record<string, unknown> = { ...layer, ...(stripTransitionFields(layer as SceneLayerView) ?? {}), id: newId, start: t, end: c.end, in: cutAt, out: c.out ?? round(fileEnd(c)) };
  if (c.volumeKeys) copy.volume = shiftKeys(c.volumeKeys, t - c.start);
  for (const k of Object.keys(copy)) if (copy[k] === null) delete copy[k];
  return [
    { op: OpName.SetTiming, id: c.id, start: c.start, end: t },
    { op: OpName.Patch, id: c.id, fields: { out: cutAt } },
    { op: OpName.AddLayer, layer: copy },
    { op: OpName.Reorder, id: newId, index: index + 1 },
  ];
}

/**
 * Delete a clip of the main track and close the gap, like CapCut's magnetic track: everything that
 * starts after it (clips, graphics, sound effects) moves back, and the video gets shorter. Its
 * transitions go with it, and the clips on both sides meet in a plain cut.
 */
export function rippleDeleteOps(c: EditClip, scene: SceneView): Op[] {
  const tracks = editTracks(scene, []);
  const me = clipById(c.id, tracks) ?? c;
  const next = nextOf(me, tracks);
  // Close the gap from where the clip before ends (or this one started) to where the next one starts.
  const from = me.start + (me.transition?.duration ?? 0);
  const until = next ? next.start : me.end;
  const gap = until - from;
  const ops: Op[] = [{ op: OpName.RemoveLayer, id: c.id }, ...(next ? stripTransitionOps(scene, next.id) : [])];
  for (const cue of scene.sfx ?? []) if (cue.at >= from && cue.at < until - EPS) ops.push({ op: OpName.RemoveSfx, id: cue.id });
  if (gap > EPS) ops.push(...shiftAfterOps(scene, until, -gap, new Set([c.id])));
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
 * second it plays. Re-run after any clip edit so captions (and @word timing) follow the cut. Where a
 * transition overlaps two clips, each keeps the words up to the middle of it.
 */
export function footageCaptions(clips: EditClip[]): CaptionWord[] {
  const words: CaptionWord[] = [];
  for (const c of clips) {
    const transcript = c.footage?.words;
    if (!transcript || c.volume <= 0) continue;
    const [from, to] = shownSpan(c);
    const first = c.in + (from - c.start) * c.speed;
    const last = Math.min(c.out ?? fileEnd(c), c.in + (to - c.start) * c.speed);
    for (const w of transcript) {
      // A word belongs to the clip when most of it plays inside the clip's window.
      const mid = (w.start + w.end) / 2;
      if (mid < first || mid > last) continue;
      const start = round(c.start + (Math.max(w.start, first) - c.in) / c.speed);
      const end = round(c.start + (Math.min(w.end, last) - c.in) / c.speed);
      words.push({ text: w.text, start, end: Math.max(end, start + 0.05), ...(isKeyWord(w.text) ? { emphasis: true } : {}) });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

/** The video ends where its last clip does (an edit of footage is as long as its cut). */
export const cutLength = (clips: EditClip[]) => round(Math.max(MIN_CLIP, ...clips.map((c) => c.end)));

/** A footage clip as a full-frame video layer at `at`, `length` seconds of it (its whole length by default). */
export function clipLayer(fc: FootageClip, at: number, size: [number, number], id: string, length = fc.duration ?? 1, track?: string): Record<string, unknown> {
  const [w, h] = size;
  return { id, type: VIDEO_LAYER, start: round(at), end: round(at + length), group: FOOTAGE_GROUP, x: w / 2, y: h / 2, w, h, src: fc.url, fit: "cover", in: 0, out: round(length), volume: 1, ...(track ? { track } : {}) };
}

/** A media pool sound or picture as a layer at `at` (a sound on the audio track, a picture full frame). */
export function mediaLayer(item: MediaItem, at: number, size: [number, number], id: string, length?: number, track?: string): Record<string, unknown> {
  const [w, h] = size;
  const t = track ? { track } : {};
  if (item.kind === MediaKind.Audio) {
    const len = length ?? item.duration ?? IMAGE_SECONDS;
    return { id, type: AUDIO_LAYER, start: round(at), end: round(at + len), x: w / 2, y: h / 2, w: 2, h: 2, src: item.url, in: 0, out: round(len), volume: 1, ...t };
  }
  return { id, type: IMAGE_LAYER, start: round(at), end: round(at + (length ?? IMAGE_SECONDS)), group: FOOTAGE_GROUP, x: w / 2, y: h / 2, w, h, src: item.url, fit: "cover", ...t };
}

/** Put a whole footage clip at the end of the main track (full frame, its own sound), under the graphics. */
export function appendClipOps(fc: FootageClip, at: number, size: [number, number], id: string, under: number): Op[] {
  return [
    { op: OpName.AddLayer, layer: clipLayer(fc, at, size, id) },
    { op: OpName.Reorder, id, index: under },
  ];
}

/** NLE edits from the media pool onto the first track of the right kind. */
export const PlaceMode = { Insert: "insert", Overwrite: "overwrite" } as const;
export type PlaceMode = (typeof PlaceMode)[keyof typeof PlaceMode];

/**
 * Put a media pool item on the timeline at `at`: a sound on the audio track (its whole length), a
 * picture on the video track for IMAGE_SECONDS, full frame. Overlaps go to another lane by themselves.
 */
export function placeMediaOps(item: MediaItem, at: number, size: [number, number], id: string, under: number): Op[] {
  const layer = mediaLayer(item, at, size, id);
  return item.kind === MediaKind.Audio ? [{ op: OpName.AddLayer, layer }] : [{ op: OpName.AddLayer, layer }, { op: OpName.Reorder, id, index: under }];
}

/** Ops that fit every full-frame clip and picture of the video track to a new frame size (a format change). */
export function reframeClipOps(scene: SceneView, size: [number, number]): Op[] {
  const [w, h] = size;
  const full = (l: SceneLayerView) => Math.abs(num(l.w, 0) - scene.width) < 2 && Math.abs(num(l.h, 0) - scene.height) < 2;
  return scene.layers
    .filter((l) => (l.type === VIDEO_LAYER || isPictureClip(l)) && full(l))
    .map((l) => ({ op: OpName.Patch, id: l.id, fields: { x: w / 2, y: h / 2, w, h } }));
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

/** Clips joined into one compound clip (precompose), on the first one's track; returns the ops and its id. */
export function compoundOps(ids: string[], scene: SceneView): { ops: Op[]; id: string } {
  const names = new Set(Object.keys(scene.library?.components ?? {}));
  const taken = new Set(scene.layers.map((l) => l.id));
  let n = 1;
  while (names.has(`${COMPOUND_PREFIX}_${n}`) || taken.has(`${COMPOUND_PREFIX}${n}`)) n++;
  const id = `${COMPOUND_PREFIX}${n}`;
  return { ops: [{ op: OpName.Precompose, ids, component: `${COMPOUND_PREFIX}_${n}`, id }], id };
}

/** A compound clip broken back into its clips, in place. */
export function decomposeOps(id: string): Op[] {
  return [{ op: OpName.Decompose, id }];
}
