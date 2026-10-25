import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { OpName, TrackKind, TrackSwitch, type Op, type Track } from "@motionily/protocol";
import { mediaUrl } from "../../api/client";
import type { SfxCue } from "../../audio/sfxPlayer";
import type { MusicTrack } from "../../audio/music";
import { engineHost } from "../../engine/host";
import { useEditor } from "../../store";
import type { SceneView } from "../sceneView";
import { Filmstrip, SoundWave, usePeaks, Waveform } from "./TimelineMedia";
import { ClipKind, MIN_CLIP, clipLocked, moveBlockOps, moveClipOps, moveToLaneOps, renameTrackOps, shownSpan, trackSwitchOps, trimWithTransitionsOps, type EditClip, type EditTracks, type GraphicsBlock } from "./tracks";
import { isPoolDrag, readPoolDrop, type PoolDrop } from "./MediaPool";
import { CUT_EPS } from "./transitions";
import { TransitionChip } from "./TransitionChip";
import type { EditActions } from "./useEditActions";
import { VolumeLine } from "./VolumeLine";
import type { VolumeKey } from "./volume";
import { audioPieces } from "../../audio/track";

const HEADER_W = 104;
/** Px the playhead keeps from the edge when the view pages along with playback. */
const PAGE_MARGIN = 24;
const RULER_H = 26;
const LANE_H = 44;
const SMALL_LANE_H = 28;
/** Video lanes are taller: frames on top, the clip's sound along the bottom. */
const VIDEO_LANE_H = 64;
const CLIP_H = VIDEO_LANE_H - 12;
const WAVE_H = 16;
/** Voice and music lanes, tall enough for a waveform and the music's volume line. */
const AUDIO_LANE_H = 40;
const AUDIO_H = AUDIO_LANE_H - 8;
const MIN_LABEL_GAP = 70;
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
/** Edges snap to the playhead and to other clips within this many pixels. */
const SNAP_PX = 7;
const HANDLE_PX = 7;
const DRAG_THRESHOLD = 3;
const MAX_ZOOM = 30;
/** Words further apart than this start a new caption chip, and a chip holds at most this many words. */
const PHRASE_GAP = 0.35;
const PHRASE_WORDS = 6;
/** Frame shape of footage whose size is unknown. */
const DEFAULT_ASPECT = 16 / 9;
const CLIP_WAVE = "rgba(186,230,253,0.9)";
const MUTED_WAVE = "rgba(186,230,253,0.35)";
const VOICE_WAVE = "rgba(209,250,229,0.85)";
const MUSIC_WAVE = "rgba(252,231,243,0.8)";
const SOUND_WAVE = "rgba(167,243,208,0.9)";
const MUTED_SOUND_WAVE = "rgba(167,243,208,0.35)";

/** The timeline's tools: Select moves and trims one clip; Trim is the NLE trim mode (ripple, roll, slip, slide). */
export const EditTool = { Select: "select", Trim: "trim" } as const;
export type EditTool = (typeof EditTool)[keyof typeof EditTool];

/** Which track a lane belongs to, for drops from the media pool. */
export const LaneTrack = { Video: "video", Audio: "audio" } as const;
export type LaneTrack = (typeof LaneTrack)[keyof typeof LaneTrack];

/** What the user has picked in the timeline. Clips and blocks follow the editor's selection (canvas or timeline). */
export type EditSelection =
  | { kind: "clip"; clip: EditClip }
  | { kind: "block"; block: GraphicsBlock }
  | { kind: "cue"; cue: SfxCue }
  | { kind: "music"; music: MusicTrack }
  | { kind: "many"; clips: EditClip[]; blocks: GraphicsBlock[]; cues: SfxCue[] }
  | null;

/** What a marquee or Shift-click can pick, as `data-pick="kind:id"` on each piece. */
export const PickKind = { Clip: "clip", Block: "block", Cue: "cue" } as const;
export type PickKind = (typeof PickKind)[keyof typeof PickKind];
/** Several pieces picked at once, by id (clip ids, block keys, cue ids), resolved against the live scene. */
export type Picks = Record<PickKind, string[]>;
export const NO_PICKS: Picks = { clip: [], block: [], cue: [] };
export const pickCount = (p: Picks) => p.clip.length + p.block.length + p.cue.length;

/** The single selection as picks, so Shift-click and a Shift-marquee add to it. */
function picksOf(selection: EditSelection): Picks {
  if (!selection) return NO_PICKS;
  switch (selection.kind) {
    case "clip":
      return { ...NO_PICKS, clip: [selection.clip.id] };
    case "block":
      return { ...NO_PICKS, block: [selection.block.key] };
    case "cue":
      return { ...NO_PICKS, cue: [selection.cue.id] };
    case "many":
      return { clip: selection.clips.map((c) => c.id), block: selection.blocks.map((b) => b.key), cue: selection.cues.map((c) => c.id) };
    default:
      return NO_PICKS;
  }
}
const union = (a: Picks, b: Picks): Picks => ({ clip: [...new Set([...a.clip, ...b.clip])], block: [...new Set([...a.block, ...b.block])], cue: [...new Set([...a.cue, ...b.cue])] });

type Drag = { kind: "move" | "in" | "out"; x0: number; y0: number; moved: boolean };

/** Music fields for its volume line: keys without eases (the envelope is linear), a flat level as one key, 100% as none. */
const envelopeOf = (v: VolumeKey[] | number) => (typeof v === "number" ? (v >= 1 ? [] : [{ t: 0, v }]) : v.map(({ t, v: level }) => ({ t, v: level })));

/**
 * CapCut-style multitrack timeline: graphics blocks on top, video lanes (the main track at the
 * bottom of them) with each clip's frames and sound, captions, voice, music and sound effects. Drag to
 * move, drag an edge to trim; a cut on the main track takes a transition; a selected clip or the music
 * shows its volume line for keyframes. The parent decides what Delete and S do.
 */
export function EditTimeline({
  scene,
  tracks,
  selection,
  audioUrl,
  onSelectCue,
  onSelectMusic,
  onPick,
  onDropMedia,
  tool = EditTool.Select,
  edits,
}: {
  scene: SceneView;
  tracks: EditTracks;
  selection: EditSelection;
  /** The voice-over file, for its waveform. */
  audioUrl: string | null;
  onSelectCue: (cue: SfxCue | null) => void;
  onSelectMusic: (on: boolean) => void;
  /** Several pieces at once (marquee, Shift-click, "select all effects"); null clears them. */
  onPick: (picks: Picks | null) => void;
  /** A media pool tile dropped on a lane at scene second `at`. */
  onDropMedia: (drop: PoolDrop, at: number, track: LaneTrack) => void;
  tool?: EditTool;
  edits: EditActions;
}) {
  const [dropLane, setDropLane] = useState<string | null>(null);
  const duration = Math.max(scene.duration, 0.1);
  const fps = scene.fps ?? 30;
  const [zoom, setZoom] = useState(1);
  const [viewW, setViewW] = useState(800);
  /** Track px on screen (left, right): blocks draw frames and waveforms only there. */
  const [view, setView] = useState({ l: 0, r: 1600 });
  const scroller = useRef<HTMLDivElement>(null);
  /** The marquee being dragged, in the track content's px. */
  const [band, setBand] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const picked = picksOf(selection);
  const voicePeaks = usePeaks(audioUrl);
  const musicPeaks = usePeaks(scene.music ? mediaUrl(scene.music.src) : null);

  const readView = () => {
    const el = scroller.current;
    if (el) setView({ l: el.scrollLeft, r: el.scrollLeft + el.clientWidth - HEADER_W });
  };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth - HEADER_W);
      readView();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const trackW = Math.max(200, viewW * zoom);
  const pps = trackW / duration;
  const px = (t: number) => t * pps;
  /** Block-local px range on screen of a block starting at track px `left`, `width` wide. */
  const visible = (left: number, width: number) => ({ visL: Math.max(0, view.l - left), visR: Math.min(width, view.r - left) });
  const step = TICK_STEPS.find((s) => s * pps >= MIN_LABEL_GAP) ?? TICK_STEPS.at(-1)!;
  const ticks = useMemo(() => Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step), [duration, step]);
  const phrases = useMemo(() => {
    const words = scene.captions?.words ?? [];
    const out: { start: number; end: number; text: string; words: number }[] = [];
    for (const w of words) {
      const last = out.at(-1);
      if (last && w.start - last.end < PHRASE_GAP && last.words < PHRASE_WORDS) {
        last.end = w.end;
        last.text += ` ${w.text}`;
        last.words += 1;
      } else out.push({ start: w.start, end: w.end, text: w.text, words: 1 });
    }
    return out;
  }, [scene.captions]);

  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - HEADER_W;
    return Math.max(0, Math.min(duration, x / pps));
  };
  const seekTo = (clientX: number) => engineHost.seek(timeAt(clientX));

  /** Scrub along the ruler (or an empty lane). */
  const scrub = (e: ReactPointerEvent) => {
    e.preventDefault();
    engineHost.pause();
    seekTo(e.clientX);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Snap a time to the playhead or a neighbour's edge when close enough. */
  const snap = (t: number, points: number[]) => {
    let best = t;
    let dist = SNAP_PX / pps;
    for (const p of points) {
      if (Math.abs(p - t) < dist) {
        dist = Math.abs(p - t);
        best = p;
      }
    }
    return best;
  };

  /** Drag helper: a click selects, a drag past the threshold edits live and commits on release. */
  /**
   * Drag helper: a click selects, a drag past the threshold edits live and commits on release.
   * `onRelease` runs after (a clip dropped on another track's lane moves there).
   */
  const drag = (
    e: ReactPointerEvent,
    kind: Drag["kind"],
    onSelect: () => void,
    onDrag: (dt: number, clientX: number) => Op[],
    what: () => string,
    recaption: boolean,
    onRelease?: (ev: PointerEvent) => void,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    const d: Drag = { kind, x0: e.clientX, y0: e.clientY, moved: false };
    let vertical = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientY - d.y0) >= DRAG_THRESHOLD * 4) vertical = true;
      if (!d.moved && Math.abs(ev.clientX - d.x0) < DRAG_THRESHOLD) return;
      if (!d.moved) edits.begin();
      d.moved = true;
      edits.preview(onDrag((ev.clientX - d.x0) / pps, ev.clientX));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (d.moved) edits.end(what(), recaption);
      if (vertical) onRelease?.(ev);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const clipPoints = (c: EditClip) => [0, playhead(), ...(c.kind === ClipKind.Audio ? tracks.audio : tracks.clips).filter((x) => x.id !== c.id && x.lane === c.lane).flatMap((x) => [x.start, x.end])];
  /** Shift-click: add the piece to the selection, or take it out. */
  const togglePick = (kind: PickKind, id: string) => {
    const has = picked[kind].includes(id);
    onPick({ ...picked, [kind]: has ? picked[kind].filter((x) => x !== id) : [...picked[kind], id] });
  };
  /**
   * Drag on an empty stretch of a lane: a selection box that picks every clip, graphics block and
   * effect it touches (Shift adds to what is selected). A click without a drag deselects and seeks.
   */
  const marquee = (e: ReactPointerEvent) => {
    e.preventDefault();
    const el = scroller.current!;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const base = e.shiftKey ? picked : NO_PICKS;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD) return;
      moved = true;
      const r = { l: Math.min(x0, ev.clientX), r: Math.max(x0, ev.clientX), t: Math.min(y0, ev.clientY), b: Math.max(y0, ev.clientY) };
      const box = el.getBoundingClientRect();
      setBand({ left: r.l - box.left + el.scrollLeft, top: r.t - box.top + el.scrollTop, width: r.r - r.l, height: r.b - r.t });
      const hit: Picks = { clip: [], block: [], cue: [] };
      el.querySelectorAll<HTMLElement>("[data-pick]").forEach((node) => {
        const b = node.getBoundingClientRect();
        if (b.right < r.l || b.left > r.r || b.bottom < r.t || b.top > r.b) return;
        const [kind, ...rest] = node.dataset.pick!.split(":");
        hit[kind as PickKind].push(rest.join(":"));
      });
      onPick(union(base, hit));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setBand(null);
      if (moved) return;
      useEditor.setState({ selectedLayerId: null, selectedGroup: null });
      onSelectCue(null);
      onSelectMusic(false);
      onPick(null);
      engineHost.pause();
      seekTo(ev.clientX);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const selectClip = (c: EditClip) => {
    onPick(null);
    onSelectCue(null);
    onSelectMusic(false);
    useEditor.setState({ selectedLayerId: c.id, selectedGroup: null });
  };
  const selectBlock = (b: GraphicsBlock) => {
    onPick(null);
    onSelectCue(null);
    onSelectMusic(false);
    useEditor.setState({ selectedLayerId: b.group ? null : b.ids[0]!, selectedGroup: b.group });
  };

  /** One clip: frames, its sound, its name, the volume line when selected (or keyed), trim handles. */
  /** Lane under the pointer, from its `data-lane` ("video-2", "audio-new"…). */
  const laneAt = (x: number, y: number): { kind: TrackKind; lane: number } | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-lane]");
    const m = el?.dataset.lane?.match(/^(video|audio)-(\d+|new)$/);
    if (!m) return null;
    const kind = m[1] === "audio" ? TrackKind.Audio : TrackKind.Video;
    return { kind, lane: m[2] === "new" ? (kind === TrackKind.Audio ? tracks.audioLanes : tracks.lanes) : Number(m[2]) };
  };
  const clipBlock = (c: EditClip) => {
    const on = picked.clip.includes(c.id);
    const locked = clipLocked(tracks, c);
    const sound = c.kind === ClipKind.Audio;
    const still = c.kind === ClipKind.Image;
    // A compound clip: its clips inside play on its clock; it moves and its end trims.
    const compound = c.kind === ClipKind.Compound;
    const height = sound ? AUDIO_H : CLIP_H;
    // Main-track clips show from the middle of each transition, like a cut there.
    const [from, to] = c.lane === 0 ? shownSpan(c) : [c.start, c.end];
    const left = px(from);
    const width = Math.max(4, px(to - from));
    const vis = visible(left, width);
    const fc = c.footage;
    const trimMode = tool === EditTool.Trim;
    const prevOnTrack = (kind: ClipKind) => (kind === ClipKind.Audio ? tracks.audio : tracks.clips).find((x) => x.lane === c.lane && x.id !== c.id && Math.abs(x.end - c.start) < 0.02);
    const edge = (kind: "in" | "out") => (e: ReactPointerEvent) => {
      if (compound && (kind === "in" || trimMode)) return;
      // Trim mode: an edge ripples (everything after follows); with Alt it rolls the cut with the neighbour.
      if (trimMode && e.altKey) {
        const left = kind === "in" ? prevOnTrack(c.kind) : c;
        if (!left) return;
        drag(e, kind, () => selectClip(c), (dt) => [{ op: OpName.RollEdit, id: left.id, to: snap((kind === "in" ? c.start : c.end) + dt, [playhead()]) }], () => `Rolls the cut of ${left.id}`, true);
        return;
      }
      if (trimMode) {
        drag(e, kind, () => selectClip(c), (dt) => [{ op: OpName.RippleTrim, id: c.id, edge: kind, to: kind === "in" ? c.start + dt : snap(c.end + dt, [playhead()]) }], () => `Ripple trims ${c.id}`, true);
        return;
      }
      drag(
        e,
        kind,
        () => selectClip(c),
        (dt) => trimWithTransitionsOps(c, kind, snap((kind === "in" ? c.start : c.end) + dt, clipPoints(c)), scene, tracks),
        () => `Trims ${c.id}`,
        true,
      );
    };
    return (
      <div
        key={c.id}
        data-clip={c.id}
        data-pick={`${PickKind.Clip}:${c.id}`}
        title={`${c.name} · ${c.start.toFixed(2)}–${c.end.toFixed(2)} s · file ${c.in.toFixed(2)}–${(c.out ?? c.in + (c.end - c.start) * c.speed).toFixed(2)} s`}
        onPointerDown={(e) =>
          e.shiftKey
            ? (e.stopPropagation(), togglePick(PickKind.Clip, c.id))
            : locked
              ? (e.stopPropagation(), selectClip(c))
              : trimMode && c.kind !== ClipKind.Image && !compound
                ? e.altKey
                  ? drag(e, "move", () => selectClip(c), (dt) => [{ op: OpName.SlideClip, id: c.id, start: c.start + dt }], () => `Slides ${c.id}`, true)
                  : drag(e, "move", () => selectClip(c), (dt) => [{ op: OpName.SlipClip, id: c.id, in: Math.max(0, c.in - dt * c.speed) }], () => `Slips ${c.id}`, true)
              : drag(
            e,
            "move",
            () => selectClip(c),
            (dt) => {
              const pts = clipPoints(c);
              let start = snap(c.start + dt, pts);
              if (start === c.start + dt) start = snap(c.end + dt, pts) - (c.end - c.start);
              return moveClipOps(c, start, scene, tracks);
            },
            () => `Moves ${c.id}`,
            true,
            (ev) => {
              // Dropped on another lane of its kind: the clip moves to that track.
              const to = laneAt(ev.clientX, ev.clientY);
              const kind = c.kind === ClipKind.Audio ? TrackKind.Audio : TrackKind.Video;
              if (to && to.kind === kind && to.lane !== c.lane) edits.apply(moveToLaneOps(tracks, c, to.lane), `Moves ${c.id} to another track`, true);
            },
          )
        }
        className={`group absolute cursor-grab overflow-hidden rounded-md text-[11px] whitespace-nowrap active:cursor-grabbing ${sound ? "top-1 bottom-1 text-emerald-50" : "top-1.5 bottom-1.5 text-sky-50"} ${
          on ? `${sound ? "bg-emerald-700" : "bg-sky-800"} ring-2 ring-white` : `${sound ? "bg-emerald-900/80" : still ? "bg-indigo-900" : "bg-sky-900"} hover:brightness-110`
        }`}
        style={{ left, width }}
      >
        {sound && vis.visR > vis.visL && (
          <SoundWave url={mediaUrl(c.src)} fileAt0={c.in + (from - c.start) * c.speed} rate={c.speed / pps} visL={vis.visL} visR={vis.visR} top={0} height={AUDIO_H} color={c.volume > 0 ? SOUND_WAVE : MUTED_SOUND_WAVE} />
        )}
        {still && <span className="pointer-events-none absolute inset-0 bg-repeat-x opacity-80" style={{ backgroundImage: `url(${mediaUrl(c.src)})`, backgroundSize: `auto ${CLIP_H}px` }} />}
        {compound && <span className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(255,255,255,0.06)_0_6px,transparent_6px_12px)]" />}
        {!sound && !still && !compound && vis.visR > vis.visL && (
          <>
            <Filmstrip
              src={c.src}
              poster={fc?.poster ?? null}
              fileDuration={fc?.duration ?? null}
              aspect={fc?.width && fc.height ? fc.width / fc.height : DEFAULT_ASPECT}
              clipStart={c.start}
              clipIn={c.in}
              speed={c.speed}
              from={from}
              pps={pps}
              visL={vis.visL}
              visR={vis.visR}
              height={CLIP_H}
            />
            <SoundWave url={mediaUrl(c.src)} fileAt0={c.in + (from - c.start) * c.speed} rate={c.speed / pps} visL={vis.visL} visR={vis.visR} top={CLIP_H - WAVE_H} height={WAVE_H} color={c.volume > 0 ? CLIP_WAVE : MUTED_WAVE} />
          </>
        )}
        <span className="pointer-events-none absolute top-1 left-1 max-w-[calc(100%-8px)] truncate rounded bg-black/55 px-1.5 text-[10px] leading-4">
          {c.name}
          {c.scale > 1 ? ` · ${Math.round((c.scale - 1) * 100)}% zoom` : ""}
          {!still && !compound && c.volume <= 0 ? " · muted" : ""}
          {c.speed !== 1 ? ` · ${c.speed}×` : ""}
        </span>
        {!still && !compound && (on || c.volumeKeys) && (
          <VolumeLine
            keys={c.volumeKeys}
            level={c.volume}
            keyZero={c.start}
            from={from}
            width={width}
            height={height}
            pps={pps}
            fps={fps}
            active={on}
            toOps={(volume) => [{ op: OpName.Patch, id: c.id, fields: { volume } }]}
            what={`Volume of ${c.id}`}
            recaption
            edits={edits}
          />
        )}
        {!locked && <span onPointerDown={edge("in")} className="absolute inset-y-0 left-0 cursor-ew-resize bg-white/0 group-hover:bg-white/25" style={{ width: HANDLE_PX }} />}
        {!locked && <span onPointerDown={edge("out")} className="absolute inset-y-0 right-0 cursor-ew-resize bg-white/0 group-hover:bg-white/25" style={{ width: HANDLE_PX }} />}
      </div>
    );
  };

  /** Each cut of the main track (touching clips, or a transition between them) gets its chip. */
  const cuts = () => {
    const main = tracks.clips.filter((c) => c.lane === 0);
    return main.slice(1).flatMap((b, i) => {
      const a = main[i]!;
      if (b.transition?.from !== a.id && Math.abs(b.start - a.end) > CUT_EPS) return [];
      return [<TransitionChip key={`cut-${b.id}`} a={a} b={b} scene={scene} pps={pps} edits={edits} />];
    });
  };

  /** Lanes that take media pool drops: video lanes (clips, pictures) and audio lanes (sounds). */
  const trackOf = (key: string): LaneTrack | null => (key.startsWith("video-") && key !== "video-new" ? LaneTrack.Video : key.startsWith("audio-") && key !== "audio-new" ? LaneTrack.Audio : null);
  /** `pickAll` turns the lane's label into "select everything on this lane". */
  const lanes: { key: string; label: string; height: number; body: ReactNode; pickAll?: () => void; track?: { kind: TrackKind; lane: number; info: Track } }[] = [];
  for (let row = tracks.blockLanes - 1; row >= 0; row--) {
    lanes.push({
      key: `graphics-${row}`,
      label: row === 0 ? "Graphics" : "",
      height: LANE_H,
      body: tracks.blocks.filter((b) => b.lane === row).map((b) => {
        const on = picked.block.includes(b.key);
        return (
          <div
            key={b.key}
            title={`${b.label} · ${b.start.toFixed(1)}–${b.end.toFixed(1)} s · ${b.ids.length} layers`}
            data-pick={`${PickKind.Block}:${b.key}`}
            onPointerDown={(e) =>
              e.shiftKey
                ? (e.stopPropagation(), togglePick(PickKind.Block, b.key))
                : drag(
                e,
                "move",
                () => selectBlock(b),
                (dt) => {
                  const start = snap(b.start + dt, [0, playhead(), ...tracks.clips.map((c) => c.start)]);
                  return moveBlockOps(b, start - b.start, scene);
                },
                () => `Moves ${b.label}`,
                false,
              )
            }
            className={`absolute top-1.5 bottom-1.5 cursor-grab overflow-hidden rounded-md px-2 text-[11px] leading-[30px] whitespace-nowrap text-violet-50 active:cursor-grabbing ${on ? "bg-violet-500 ring-2 ring-white" : "bg-violet-600/80 hover:bg-violet-500/90"}`}
            style={{ left: px(b.start), width: Math.max(4, px(b.end - b.start)) }}
          >
            {b.label}
          </div>
        );
      }),
    });
  }
  // Overlay lanes above, the main track (lane 0) at the bottom, as in CapCut.
  // An empty lane above the top track: drop a clip there for a new track.
  lanes.push({ key: "video-new", label: "", height: SMALL_LANE_H, body: <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[10px] text-neutral-700">Drop here for a new video track</span> });
  for (let lane = tracks.lanes - 1; lane >= 0; lane--) {
    lanes.push({
      key: `video-${lane}`,
      label: tracks.videoTracks[lane]!.name || tracks.videoTracks[lane]!.id,
      track: { kind: TrackKind.Video, lane, info: tracks.videoTracks[lane]! },
      height: VIDEO_LANE_H,
      body: (
        <>
          {tracks.clips.filter((c) => c.lane === lane).map(clipBlock)}
          {lane === 0 && cuts()}
        </>
      ),
    });
  }
  // Sound clips under the video, one lane per overlap (always one, to drop sounds on).
  for (let lane = 0; lane < tracks.audioLanes; lane++) {
    lanes.push({
      key: `audio-${lane}`,
      label: tracks.audioTracks[lane]!.name || tracks.audioTracks[lane]!.id,
      track: { kind: TrackKind.Audio, lane, info: tracks.audioTracks[lane]! },
      height: AUDIO_LANE_H,
      body: <>{tracks.audio.filter((c) => c.lane === lane).map(clipBlock)}</>,
    });
  }
  lanes.push({ key: "audio-new", label: "", height: SMALL_LANE_H, body: <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[10px] text-neutral-700">Drop here for a new audio track</span> });
  if (phrases.length)
    lanes.push({
      key: "captions",
      label: "Captions",
      height: SMALL_LANE_H,
      body: phrases.map((p, i) => (
        <div key={i} title={p.text} className="pointer-events-none absolute top-1 bottom-1 truncate rounded bg-neutral-700/70 px-1.5 text-[10px] leading-5 text-neutral-200" style={{ left: px(p.start), width: Math.max(2, px(p.end - p.start)) }}>
          {p.text}
        </div>
      )),
    });
  if (scene.audio) {
    // One block per audible piece: cuts show as gaps closed up, like clips on an edit.
    const pieces = audioPieces(scene.audio, voicePeaks?.duration ?? Infinity).filter((p) => p.at < duration);
    lanes.push({
      key: "voice",
      label: "Voice",
      height: AUDIO_LANE_H,
      body: (
        <>
          {pieces.map((p, i) => {
            const left = px(p.at);
            const width = Math.max(8, px(Math.min(duration, p.at + (p.to - p.from)) - p.at));
            const vis = visible(left, width);
            return (
              <div key={i} className="pointer-events-none absolute top-1 bottom-1 overflow-hidden rounded bg-emerald-800/70 text-[10px] leading-5 text-emerald-50" style={{ left, width }}>
                {voicePeaks && vis.visR > vis.visL && <Waveform peaks={voicePeaks} fileAt0={p.from} rate={1 / pps} visL={vis.visL} visR={vis.visR} top={0} height={AUDIO_H} color={VOICE_WAVE} />}
                {i === 0 && <span className="absolute top-0 left-1.5">Voice-over</span>}
              </div>
            );
          })}
        </>
      ),
    });
  }
  if (scene.music) {
    const m = scene.music;
    const on = selection?.kind === "music";
    const fileOut = m.trim_out ?? musicPeaks?.duration ?? null;
    const end = Math.min(duration, fileOut != null ? m.start + (fileOut - m.trim_in) : duration);
    const left = px(m.start);
    const width = Math.max(8, px(end - m.start));
    const vis = visible(left, width);
    const envelope = m.envelope?.length ? m.envelope : null;
    lanes.push({
      key: "music",
      label: "Music",
      height: AUDIO_LANE_H,
      body: (
        <div
          data-music
          title={`Music from ${m.start.toFixed(1)} s · level ${Math.round(m.gain * 100)}%`}
          onPointerDown={(e) =>
            drag(
              e,
              "move",
              () => {
                useEditor.setState({ selectedLayerId: null, selectedGroup: null });
                onPick(null);
                onSelectCue(null);
                onSelectMusic(true);
              },
              (dt) => [{ op: OpName.SetMusic, music: { ...m, start: Math.max(0, Math.round(snap(m.start + dt, [0, playhead()]) * 1000) / 1000) } }],
              () => "Moves the music",
              false,
            )
          }
          className={`absolute top-1 bottom-1 cursor-grab overflow-hidden rounded text-[10px] leading-5 ${on ? "bg-pink-600 ring-2 ring-white" : "bg-pink-800/70 hover:bg-pink-700/80"}`}
          style={{ left, width }}
        >
          {musicPeaks && vis.visR > vis.visL && <Waveform peaks={musicPeaks} fileAt0={m.trim_in} rate={1 / pps} visL={vis.visL} visR={vis.visR} top={0} height={AUDIO_H} color={MUSIC_WAVE} />}
          <span className="pointer-events-none absolute top-0 left-1.5 truncate text-pink-50">♪ {m.src.split("/").pop()}</span>
          {(on || envelope) && (
            <VolumeLine
              keys={envelope}
              level={1}
              keyZero={m.start}
              from={m.start}
              width={width}
              height={AUDIO_H}
              pps={pps}
              fps={fps}
              active={on}
              toOps={(v) => [{ op: OpName.SetMusic, music: { ...m, envelope: envelopeOf(v) } }]}
              what="Music volume"
              recaption={false}
              edits={edits}
            />
          )}
        </div>
      ),
    });
  }
  if (scene.sfx?.length)
    lanes.push({
      key: "sfx",
      label: "Effects",
      height: SMALL_LANE_H,
      pickAll: () => {
        useEditor.setState({ selectedLayerId: null, selectedGroup: null });
        onSelectCue(null);
        onSelectMusic(false);
        onPick({ ...NO_PICKS, cue: scene.sfx!.map((c) => c.id) });
      },
      body: scene.sfx.map((cue) => {
        const on = picked.cue.includes(cue.id);
        return (
          <div
            key={cue.id}
            title={`${cue.sound} · ${cue.at.toFixed(2)} s · level ${Math.round((cue.gain ?? 1) * 100)}%`}
            data-pick={`${PickKind.Cue}:${cue.id}`}
            onPointerDown={(e) =>
              e.shiftKey
                ? (e.stopPropagation(), togglePick(PickKind.Cue, cue.id))
                : drag(
                e,
                "move",
                () => {
                  useEditor.setState({ selectedLayerId: null, selectedGroup: null });
                  onPick(null);
                  onSelectMusic(false);
                  onSelectCue(cue);
                },
                (dt) => [{ op: OpName.PutSfx, cue: { ...cue, at: Math.max(0, Math.round(snap(cue.at + dt, [playhead()]) * 1000) / 1000) } }],
                () => `Moves the ${cue.sound} effect`,
                false,
              )
            }
            className={`absolute top-1 bottom-1 cursor-grab truncate rounded px-1 text-[10px] leading-5 ${on ? "bg-amber-400 text-neutral-900" : "bg-amber-600/70 text-amber-50 hover:bg-amber-500"}`}
            style={{ left: px(cue.at), width: Math.max(36, MIN_CLIP * pps) }}
          >
            {cue.sound}
          </div>
        );
      }),
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={() => requestAnimationFrame(readView)}
        onWheel={(e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          setZoom((z) => Math.min(MAX_ZOOM, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
        }}
        className="relative min-h-0 flex-1 overflow-auto"
      >
        <div className="relative" style={{ width: HEADER_W + trackW }}>
          {/* Ruler */}
          <div className="sticky top-0 z-20 flex bg-neutral-950" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-30 flex shrink-0 items-center gap-1 bg-neutral-950 px-2" style={{ width: HEADER_W }}>
              <button type="button" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} className="rounded px-1.5 text-neutral-400 hover:text-white" aria-label="Zoom out">
                −
              </button>
              <button type="button" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))} className="rounded px-1.5 text-neutral-400 hover:text-white" aria-label="Zoom in">
                +
              </button>
            </div>
            <div onPointerDown={scrub} className="relative flex-1 cursor-col-resize border-b border-neutral-800">
              {scene.work_area && (
                <span
                  title={`In ${scene.work_area[0].toFixed(2)} s · out ${scene.work_area[1].toFixed(2)} s (I / O, Alt+X clears)`}
                  className="pointer-events-none absolute inset-y-0 border-x-2 border-sky-400/80 bg-sky-400/15"
                  style={{ left: px(scene.work_area[0]), width: Math.max(2, px(scene.work_area[1] - scene.work_area[0])) }}
                />
              )}
              {(scene.markers ?? []).map((m, i) => (
                <MarkerFlag key={`${m.t}-${i}`} marker={m} index={i} left={px(m.t)} markers={scene.markers!} edits={edits} />
              ))}
              {ticks.map((t) => (
                <span key={t} className={`absolute top-1 text-[10px] text-neutral-500 tabular-nums ${t > 0 ? "-translate-x-1/2" : "pl-1"}`} style={{ left: px(t) }}>
                  {t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}` : `${t}s`}
                </span>
              ))}
            </div>
          </div>
          {/* Lanes */}
          {lanes.map((l) => (
            <div key={l.key} className="flex" style={{ height: l.height }}>
              <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1 bg-neutral-950 px-2 text-[11px] text-neutral-500" style={{ width: HEADER_W }}>
                {l.track ? (
                  <TrackHeader track={l.track} onOps={(ops, what) => edits.apply(ops, what, true)} tracks={tracks} />
                ) : l.pickAll ? (
                  <button type="button" onClick={l.pickAll} title={`Select every item on ${l.label}`} className="hover:text-white">
                    {l.label}
                  </button>
                ) : (
                  l.label
                )}
              </div>
              <div
                data-lane={l.key}
                onPointerDown={marquee}
                onDragOver={(e) => {
                  if (!isPoolDrag(e) || !trackOf(l.key)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  setDropLane(l.key);
                }}
                onDragLeave={() => setDropLane((k) => (k === l.key ? null : k))}
                onDrop={(e) => {
                  const track = trackOf(l.key);
                  const drop = readPoolDrop(e);
                  setDropLane(null);
                  if (!track || !drop) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onDropMedia(drop, timeAt(e.clientX), track);
                }}
                className={`relative flex-1 border-b border-neutral-900/80 ${dropLane === l.key ? "bg-white/[0.06]" : ""} ${l.track?.info.hidden || (l.track?.kind === TrackKind.Audio && l.track.info.muted) ? "opacity-40" : ""}`}
              >
                {l.body}
              </div>
            </div>
          ))}
          {band && <div className="pointer-events-none absolute z-30 rounded-sm border border-white/60 bg-white/10" style={band} />}
          {/* Playhead */}
          <Playhead pps={pps} scroller={scroller} />
        </div>
      </div>
    </div>
  );
}

const SWITCH_LABEL: Record<TrackSwitch, { on: string; off: string; glyph: string }> = {
  hidden: { on: "Show the track", off: "Hide the track", glyph: "◐" },
  muted: { on: "Unmute", off: "Mute", glyph: "M" },
  solo: { on: "Unsolo", off: "Solo: hear only solo tracks", glyph: "S" },
  locked: { on: "Unlock", off: "Lock (no moving, trimming or deleting)", glyph: "🔒" },
};

/** A track's name (double-click renames it) and its switches, like an NLE's track header. */
/** The playhead's second right now (snapping reads it when a drag moves, so the timeline never re-renders per frame). */
const playhead = () => useEditor.getState().time;

/**
 * The playhead line: the only part of the timeline that changes every frame while playing. When it runs
 * off the visible part of a zoomed timeline, the view turns the page with it.
 */
function Playhead({ pps, scroller }: { pps: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const x = time * pps;
  useEffect(() => {
    const el = scroller.current;
    if (!playing || !el) return;
    const width = el.clientWidth - HEADER_W;
    if (x < el.scrollLeft || x > el.scrollLeft + width - PAGE_MARGIN) el.scrollLeft = Math.max(0, x - PAGE_MARGIN);
  }, [x, playing, scroller]);
  return (
    <div className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-red-400" style={{ left: HEADER_W + x }}>
      <span className="absolute -top-0 -left-1.5 size-3 rotate-45 bg-red-400" />
    </div>
  );
}

function TrackHeader({ track, tracks, onOps }: { track: { kind: TrackKind; lane: number; info: Track }; tracks: EditTracks; onOps: (ops: Op[], what: string) => void }) {
  const [editing, setEditing] = useState(false);
  const switches: TrackSwitch[] = track.kind === TrackKind.Video ? [TrackSwitch.Hidden, TrackSwitch.Locked] : [TrackSwitch.Muted, TrackSwitch.Solo, TrackSwitch.Locked];
  const name = track.info.name || track.info.id;
  return (
    <span className="flex w-full min-w-0 items-center gap-1">
      {editing ? (
        <input
          autoFocus
          defaultValue={track.info.name ?? ""}
          placeholder={track.info.id}
          onBlur={(e) => {
            setEditing(false);
            if (e.target.value !== (track.info.name ?? "")) onOps(renameTrackOps(tracks, track.kind, track.lane, e.target.value), `Renames ${track.info.id}`);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="w-12 min-w-0 rounded bg-neutral-900 px-1 text-[11px] text-white focus:outline-none"
        />
      ) : (
        <span onDoubleClick={() => setEditing(true)} title={`${track.info.id} · double-click to rename`} className="min-w-0 flex-1 truncate text-neutral-400">
          {name}
        </span>
      )}
      {switches.map((sw) => {
        const on = !!track.info[sw];
        const label = SWITCH_LABEL[sw];
        return (
          <button
            key={sw}
            type="button"
            title={on ? label.on : label.off}
            aria-pressed={on}
            onClick={() => onOps(trackSwitchOps(tracks, track.kind, track.lane, sw), `${on ? label.on : label.off}: ${track.info.id}`)}
            className={`flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-semibold ${on ? (sw === TrackSwitch.Solo ? "bg-amber-400 text-neutral-900" : "bg-neutral-200 text-neutral-900") : "text-neutral-600 hover:text-white"}`}
          >
            {label.glyph}
          </button>
        );
      })}
    </span>
  );
}

type MarkerView = { t: number; label: string; color?: string };

/** A timeline marker on the ruler: click jumps there, double-click renames it, Alt+click removes it. */
function MarkerFlag({ marker, index, left, markers, edits }: { marker: MarkerView; index: number; left: number; markers: MarkerView[]; edits: EditActions }) {
  const [editing, setEditing] = useState(false);
  const set = (next: MarkerView[], what: string) => edits.apply([{ op: OpName.SetMarkers, markers: next }], what, false);
  return (
    <span className="absolute top-0 bottom-0 z-10" style={{ left }}>
      <button
        type="button"
        title={`${marker.label || "Marker"} · ${marker.t.toFixed(2)} s (double-click renames, Alt+click removes)`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (e.altKey) return set(markers.filter((_, i) => i !== index), `Removes the marker at ${marker.t.toFixed(2)} s`);
          engineHost.pause();
          engineHost.seek(marker.t);
        }}
        onDoubleClick={() => setEditing(true)}
        className="absolute top-0 -left-1.5 size-3 rotate-45 rounded-[2px]"
        style={{ background: marker.color ?? "#f5a623" }}
      />
      {editing ? (
        <input
          autoFocus
          defaultValue={marker.label}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => {
            setEditing(false);
            if (e.target.value !== marker.label) set(markers.map((m, i) => (i === index ? { ...m, label: e.target.value } : m)), `Renames a marker: ${e.target.value}`);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="absolute top-3 left-1 z-20 w-24 rounded bg-neutral-900 px-1 text-[10px] text-white ring-1 ring-white/20 focus:outline-none"
        />
      ) : (
        marker.label && <span className="pointer-events-none absolute top-3 left-1 max-w-24 truncate text-[9px] text-amber-200/80">{marker.label}</span>
      )}
    </span>
  );
}
