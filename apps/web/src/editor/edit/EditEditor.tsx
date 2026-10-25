import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { FORMAT_SIZE, MediaKind, OpName, effectsWithGrade, type VideoFormat } from "@motionily/protocol";
import { readGrade } from "./colorGrade";
import { VIDEO_LAYER } from "../../engine/video";
import { mediaUrl } from "../../api/client";
import type { SfxCue } from "../../audio/sfxPlayer";
import { Logo } from "../../components/Logo";
import { engineHost } from "../../engine/host";
import { ExportButton } from "../../export/ExportButton";
import { ScheduleButton } from "../../posts/ScheduleButton";
import { href, RouteName } from "../../router";
import { useEditor } from "../../store";
import type { EditorProps } from "../context";
import { ModePiece, ModeSwitch } from "../mode";
import { ProjectTitle } from "../ProjectTitle";
import { useSceneView } from "../sceneView";
import { useTransportKeys } from "../transportKeys";
import { Viewer } from "../Viewer";
import { AttentionStrip } from "../AttentionStrip";
import { ClaudePanel } from "./ClaudePanel";
import { EditTimeline, EditTool, LaneTrack, pickCount, type EditSelection, type Picks } from "./EditTimeline";
import { Inspector } from "./Inspector";
import { mmss, useClipUpload, useMusicUpload } from "./MediaPanel";
import { MediaPool, PoolEdit, useMediaPool, type PoolDrop } from "./MediaPool";
import { ProjectInspector } from "./ProjectInspector";
import { SidePanel } from "./SidePanel";
import { AUDIO_LAYER, ClipKind, FOOTAGE_GROUP, appendClipOps, clipLayer, editTracks, freshId, mediaLayer, placeMediaOps, reframeClipOps } from "./tracks";
import { ActivitySource, logActivity } from "../../store";
import { useEditActions } from "./useEditActions";
import { useEditOps } from "./useEditOps";
import { useAgentName } from "../../agentName";

const PREVIEW_MAX_WIDTH = 900;

const typing = (el: EventTarget | null) => {
  const e = el as HTMLElement | null;
  return !!e && (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT" || e.isContentEditable);
};
const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

/**
 * Edit mode, CapCut-style with Claude at the center: the library (clips, music) on the left, the
 * preview in the middle, the multitrack timeline under both, and the Claude panel full height on
 * the right: the conversation, what is selected and its settings, and the box that asks for
 * anything ("an animated map here, 5 seconds"). Files dropped anywhere go to the library.
 */
export function EditEditor({ ed }: { ed: EditorProps }) {
  const agent = useAgentName();
  const { project } = ed;
  const scene = useSceneView();
  const fps = scene?.fps ?? 30;
  const footage = useMemo(() => project?.footage ?? [], [project?.footage]);
  const edits = useEditActions(footage, !!project?.audio);
  const pool = useMediaPool(project?.id, project?.updatedAt);
  const tracks = useMemo(() => (scene ? editTracks(scene, footage, pool.items) : null), [scene, footage, pool.items]);
  const [cue, setCue] = useState<SfxCue | null>(null);
  const [musicOn, setMusicOn] = useState(false);
  /** Several pieces picked with the marquee or Shift-click (the editor's selection holds one). */
  const [picks, setPicks] = useState<Picks | null>(null);
  /** Select (A) or Trim (T): ripple / roll / slip / slide. */
  const [tool, setTool] = useState<EditTool>(EditTool.Select);
  const clips = useClipUpload(ed, edits);
  const music = useMusicUpload(ed, edits);
  const selectedLayer = useEditor((s) => s.selectedLayerId);
  const selectedGroup = useEditor((s) => s.selectedGroup);
  useTransportKeys(fps, true);

  // The selection is the editor's (canvas clicks select here too); only sound effects are local.
  const selection: EditSelection = useMemo(() => {
    if (picks && tracks && pickCount(picks)) {
      const many = {
        kind: "many" as const,
        clips: [...tracks.clips, ...tracks.audio].filter((c) => picks.clip.includes(c.id)),
        blocks: tracks.blocks.filter((b) => picks.block.includes(b.key)),
        cues: (scene?.sfx ?? []).filter((c) => picks.cue.includes(c.id)),
      };
      // One piece left is an ordinary selection.
      if (many.clips.length + many.blocks.length + many.cues.length > 1) return many;
      if (many.clips[0]) return { kind: "clip", clip: many.clips[0] };
      if (many.blocks[0]) return { kind: "block", block: many.blocks[0] };
      if (many.cues[0]) return { kind: "cue", cue: many.cues[0] };
    }
    if (musicOn && scene?.music) return { kind: "music", music: scene.music };
    if (cue) return { kind: "cue", cue };
    if (!tracks) return null;
    if (selectedGroup) {
      const block = tracks.blocks.find((b) => b.group === selectedGroup);
      return block ? { kind: "block", block } : null;
    }
    if (!selectedLayer) return null;
    const clip = tracks.clips.find((c) => c.id === selectedLayer) ?? tracks.audio.find((c) => c.id === selectedLayer);
    if (clip) return { kind: "clip", clip };
    const block = tracks.blocks.find((b) => b.ids.includes(selectedLayer));
    return block ? { kind: "block", block } : null;
  }, [picks, scene?.sfx, musicOn, scene?.music, cue, tracks, selectedGroup, selectedLayer]);
  // Picking something on the canvas replaces a multiple selection.
  useEffect(() => {
    if (selectedLayer || selectedGroup) setPicks(null);
  }, [selectedLayer, selectedGroup]);

  const ops = useEditOps(scene, tracks, edits);
  const deselect = () => {
    useEditor.setState({ selectedLayerId: null, selectedGroup: null });
    setCue(null);
    setMusicOn(false);
    setPicks(null);
  };

  // S splits, Delete removes (closing the gap on the main track), ⌘Z / ⇧⌘Z undo and redo. Captured
  // first, so the canvas selection's own Delete never runs on top of it.
  const latest = useRef({ selection, ops, edits, place: (_m: PoolEdit) => undefined as void });
  latest.current = { selection, ops, edits, place: (m: PoolEdit) => placeFromPool(m) };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const { selection: sel, ops: o, edits: ed2 } = latest.current;
      const meta = e.metaKey || e.ctrlKey;
      let handled = true;
      const t = useEditor.getState().time;
      const wa = (JSON.parse(engineHost.sceneJson()) as { work_area?: [number, number] | null }).work_area ?? null;
      const dur = useEditor.getState().duration;
      if (meta && e.key.toLowerCase() === "z") (e.shiftKey ? ed2.redo() : ed2.undo());
      else if (!meta && !e.altKey && e.key.toLowerCase() === "i") ed2.apply([{ op: OpName.SetWorkArea, work_area: [t, Math.max(wa?.[1] ?? dur, t + 0.1)] }], `Mark in at ${t.toFixed(2)} s`, false);
      else if (!meta && !e.altKey && e.key.toLowerCase() === "o") ed2.apply([{ op: OpName.SetWorkArea, work_area: [Math.min(wa?.[0] ?? 0, Math.max(0, t - 0.1)), t] }], `Mark out at ${t.toFixed(2)} s`, false);
      else if (!meta && !e.altKey && e.key.toLowerCase() === "m") {
        const markers = (JSON.parse(engineHost.sceneJson()) as { markers?: { t: number; label: string; color?: string }[] }).markers ?? [];
        ed2.apply([{ op: OpName.SetMarkers, markers: [...markers, { t, label: `Marker ${markers.length + 1}` }] }], `Marker at ${t.toFixed(2)} s`, false);
      } else if (e.altKey && e.code === "KeyX") ed2.apply([{ op: OpName.SetWorkArea, work_area: null }], "Clears the in and out marks", false);
      else if (e.key === "F9") latest.current.place(PoolEdit.Insert);
      else if (e.key === "F10") latest.current.place(PoolEdit.Overwrite);
      else if (e.key === "F11") latest.current.place(PoolEdit.Replace);
      else if (!meta && e.key.toLowerCase() === "a") setTool(EditTool.Select);
      else if (!meta && e.key.toLowerCase() === "t") setTool(EditTool.Trim);
      // S, or ⌘B like Resolve's and Premiere's blade, cuts at the playhead.
      else if ((!meta && e.key.toLowerCase() === "s") || (meta && e.key.toLowerCase() === "b")) o.split(sel?.kind === "clip" ? sel.clip : null);
      else if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        o.remove(sel);
        setCue(null);
        setPicks(null);
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  /**
   * A media pool tile onto the timeline at `at`: a clip or picture on the video track, a sound on the
   * audio track; a clip dropped on an audio lane brings only its sound.
   */
  const addMedia = (drop: PoolDrop, at: number, track: LaneTrack | null) => {
    if (!scene) return;
    const taken = new Set(scene.layers.map((l) => l.id));
    const under = scene.layers.filter((l) => l.type === VIDEO_LAYER || l.group === FOOTAGE_GROUP).length;
    const size = engineHost.sceneSize();
    if (drop.source === "footage") {
      const fc = footage.find((c) => c.id === drop.id);
      if (!fc) return;
      if (track === LaneTrack.Audio) {
        const id = freshId("snd", taken);
        const length = fc.duration ?? 1;
        edits.apply([{ op: OpName.AddLayer, layer: { id, type: AUDIO_LAYER, start: at, end: at + length, x: size[0] / 2, y: size[1] / 2, w: 2, h: 2, src: fc.url, in: 0, out: length, volume: 1 } }], `Adds the sound of ${fc.name} at ${at.toFixed(2)} s`, false);
        return;
      }
      edits.apply(appendClipOps(fc, at, size, freshId("ft", taken), under), `Adds ${fc.name} at ${at.toFixed(2)} s`, true);
      return;
    }
    const item = pool.items.find((m) => m.id === drop.id);
    if (!item) return;
    if (item.kind === MediaKind.Lut) {
      // A LUT grades a clip instead of going on the timeline: the selected one.
      const c = selection?.kind === "clip" ? selection.clip : null;
      if (!c) return logActivity(ActivitySource.System, `Select a clip to grade it with ${item.name}`);
      const layer = engineHost.layer(c.id);
      const { grade } = readGrade(layer);
      edits.apply([{ op: OpName.Patch, id: c.id, fields: { effects: effectsWithGrade(layer?.effects as unknown[] | undefined, grade, { lut: { src: item.url, mix: 1 } }) } }], `LUT ${item.name} on ${c.id}`, false);
      return;
    }
    edits.apply(placeMediaOps(item, at, size, freshId(item.kind === MediaKind.Audio ? "snd" : "pic", taken), under), `Adds ${item.name} at ${at.toFixed(2)} s`, false);
  };
  const addAtPlayhead = (drop: PoolDrop) => addMedia(drop, useEditor.getState().time, null);

  /** The pool tile picked for Insert / Overwrite / Replace. */
  const [poolPick, setPoolPick] = useState<PoolDrop | null>(null);
  /**
   * NLE edits with the picked tile: at the I mark (or the playhead), as long as the I–O range (or its own
   * length), on the first track of its kind. Replace swaps the selected clip's media, keeping its length.
   */
  const placeFromPool = (mode: PoolEdit) => {
    if (!scene || !tracks || !poolPick) return;
    const fc = poolPick.source === "footage" ? footage.find((c) => c.id === poolPick.id) : undefined;
    const item = poolPick.source === "media" ? pool.items.find((m) => m.id === poolPick.id) : undefined;
    if (!fc && !item) return;
    if (item?.kind === MediaKind.Lut) return addMedia(poolPick, useEditor.getState().time, null);
    const sound = item?.kind === MediaKind.Audio;
    if (mode === PoolEdit.Replace) {
      const c = selection?.kind === "clip" ? selection.clip : null;
      const kind = fc ? ClipKind.Video : sound ? ClipKind.Audio : ClipKind.Image;
      if (!c || c.kind !== kind) return logActivity(ActivitySource.System, "Replace: select a clip of the same kind on the timeline first");
      const len = c.end - c.start;
      const fields = kind === ClipKind.Image ? { src: item!.url } : { src: fc?.url ?? item!.url, in: 0, out: Math.round(len * c.speed * 1000) / 1000 };
      edits.apply([{ op: OpName.Patch, id: c.id, fields }], `Replaces the media of ${c.id}`, true);
      return;
    }
    const wa = scene.work_area;
    const at = wa ? wa[0] : useEditor.getState().time;
    const length = wa ? wa[1] - wa[0] : undefined;
    const taken = new Set(scene.layers.map((l) => l.id));
    const size = engineHost.sceneSize();
    const hasTracks = !!scene.tracks?.length;
    const track = hasTracks ? (sound ? tracks.audioTracks[0]?.id : tracks.videoTracks[0]?.id) : undefined;
    const id = freshId(fc ? "ft" : sound ? "snd" : "pic", taken);
    const layer = fc ? clipLayer(fc, at, size, id, length ?? fc.duration ?? 1, track) : mediaLayer(item!, at, size, id, length, track);
    const under = scene.layers.filter((l) => l.type === VIDEO_LAYER || l.group === FOOTAGE_GROUP).length;
    const ops = [{ op: OpName.PlaceClip, mode, layer }, ...(sound ? [] : [{ op: OpName.Reorder, id, index: under }])];
    edits.apply(ops, `${mode === PoolEdit.Insert ? "Inserts" : "Overwrites with"} ${fc?.name ?? item!.name} at ${at.toFixed(2)} s`, true);
  };

  /** Format change from Project settings: full-frame clips follow the new frame here; graphics go to the agent. */
  const changeFormat = async (format: VideoFormat) => {
    if (!scene || !project || format === project.format) return;
    const before = scene;
    await ed.changeFormat(format, !!tracks?.blocks.length);
    const ops = reframeClipOps(before, FORMAT_SIZE[format]);
    if (ops.length) edits.apply(ops, `Reframes ${ops.length} clips for ${format}`, false);
    logActivity(ActivitySource.User, `Format: ${format}`);
  };

  // Files dropped anywhere go to the media pool (clips are transcribed and join the edit). Drops a
  // panel handles itself (the pool's zones, references on the ask box) never reach here twice.
  const [dragging, setDragging] = useState(0);
  const onDrop = (e: DragEvent) => {
    setDragging(0);
    if (e.defaultPrevented || !hasFiles(e)) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const videos = files.filter((f) => f.type.startsWith("video/"));
    const rest = files.filter((f) => !f.type.startsWith("video/"));
    if (rest.length) void pool.upload(rest);
    if (videos.length) void clips.upload(videos);
  };

  const hasScene = !!scene?.layers.length;
  const empty = !!tracks && !tracks.clips.length && !tracks.blocks.length && !scene?.music;

  return (
    <div
      className="relative flex h-dvh flex-col bg-neutral-950"
      onDragEnter={(e) => hasFiles(e) && setDragging((n) => n + 1)}
      onDragLeave={(e) => hasFiles(e) && setDragging((n) => Math.max(0, n - 1))}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDrop={onDrop}
    >
      <header className={`flex items-center gap-4 px-5 py-2.5 ${ModePiece.Header}`}>
        <a href={href({ name: RouteName.Projects })} className="shrink-0">
          <Logo />
        </a>
        <ProjectTitle project={project} onRename={ed.rename} className="flex-1 rounded-md px-2 py-1 text-sm font-medium hover:bg-neutral-900 focus:bg-neutral-900" />
        <ModeSwitch mode={ed.mode} onChange={ed.setMode} className="bg-neutral-900" />
        {project && <ScheduleButton ed={ed} />}
        {project && <ExportButton projectId={project.id} name={project.name} audioUrl={project.audio ? mediaUrl(project.audio.url) : null} />}
      </header>

      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex min-h-0 flex-1 gap-3">
            <MediaPool ed={ed} scene={scene} clips={clips} music={music} pool={pool} onAdd={addAtPlayhead} picked={poolPick} onPick={setPoolPick} onPlace={placeFromPool} />
            {/* Any frame shape fits here: the viewer scales it to the space it gets. */}
            <main className="flex min-w-0 flex-1 flex-col items-center gap-2 py-1">
              <Viewer canvas={ed.canvas} error={ed.error} maxWidth={PREVIEW_MAX_WIDTH} canvasClass="rounded-xl shadow-2xl shadow-black/50" />
              <Transport duration={scene?.duration ?? 0} />
              <AttentionStrip g={ed.g} className="w-full max-w-xl" />
            </main>
          </div>
          {/* As tall as its tracks, up to 46% of the screen: the preview keeps the rest. */}
          <div className={`relative flex max-h-[46%] min-h-52 shrink-0 flex-col rounded-2xl ring-1 ring-white/[0.06] ${ModePiece.Timeline}`}>
            <div className="flex items-center gap-1 px-3 py-1.5 text-xs">
              <span className="mr-1 flex rounded-md bg-neutral-950 p-0.5">
                {([[EditTool.Select, "Select", "A"], [EditTool.Trim, "Trim", "T"]] as const).map(([t, label, key]) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTool(t)}
                    title={t === EditTool.Trim ? "Trim: drag an edge to ripple, Alt+edge to roll, drag a clip to slip, Alt+drag to slide" : "Select: move and trim one clip"}
                    className={`rounded px-2 py-0.5 ${tool === t ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-white"}`}
                  >
                    {label} <span className="text-neutral-500">{key}</span>
                  </button>
                ))}
              </span>
              <ToolButton label="Split" hint="S · ⌘B" onClick={() => ops.split(selection?.kind === "clip" ? selection.clip : null)} />
              <ToolButton label="Delete" hint="⌫" disabled={!selection} onClick={() => selection && (ops.remove(selection), setCue(null), setMusicOn(false), setPicks(null))} />
              <ToolButton label="Undo" hint="⌘Z" disabled={!edits.canUndo} onClick={edits.undo} />
              <ToolButton label="Redo" hint="⇧⌘Z" disabled={!edits.canRedo} onClick={edits.redo} />
              <span className="ml-auto truncate pl-3 text-neutral-600">
                {tool === EditTool.Trim ? "Edge: ripple · Alt+edge: roll · drag: slip · Alt+drag: slide" : "Drag to move, edges to trim · click a cut for a transition · ⌘ + wheel zooms"}
              </span>
            </div>
            {scene && tracks ? (
              <EditTimeline
                scene={scene}
                tracks={tracks}
                selection={selection}
                audioUrl={project?.audio ? mediaUrl(project.audio.url) : null}
                onSelectCue={setCue}
                onSelectMusic={setMusicOn}
                onPick={setPicks}
                onDropMedia={addMedia}
                tool={tool}
                edits={edits}
              />
            ) : (
              <p className="px-4 text-sm text-neutral-500">Loading…</p>
            )}
            {empty && (
              <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-neutral-500">
                Drop clips anywhere to start, or ask {agent} on the right.
              </p>
            )}
          </div>
        </div>
        <SidePanel
          selectedKey={selectionKey(selection)}
          running={ed.g.running}
          inspector={
            selection ? (
              <Inspector selection={selection} ops={ops} edits={edits} songLength={project?.music?.duration ?? null} clipIds={tracks?.clips.map((c) => c.id) ?? []} luts={pool.items.filter((m) => m.kind === MediaKind.Lut)} onClose={deselect} />
            ) : (
              <ProjectInspector ed={ed} scene={scene} edits={edits} onFormat={(f) => void changeFormat(f)} />
            )
          }
          agentPanel={<ClaudePanel ed={ed} hasScene={hasScene} hasFootage={!!tracks?.clips.length} selection={null} bare />}
        />
      </div>

      {dragging > 0 && (
        <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-3xl border-2 border-dashed border-white/60 bg-black/50">
          <p className="rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-semibold">Drop to import · videos, sounds and pictures go to the media pool</p>
        </div>
      )}
    </div>
  );
}

/** Identity of the selection, so the side panel can bring the Inspector forward when it changes. */
function selectionKey(sel: EditSelection): string | null {
  if (!sel) return null;
  if (sel.kind === "clip") return `clip:${sel.clip.id}`;
  if (sel.kind === "block") return `block:${sel.block.key}`;
  if (sel.kind === "cue") return `cue:${sel.cue.id}`;
  if (sel.kind === "music") return "music";
  return `many:${sel.clips.length + sel.blocks.length + sel.cues.length}`;
}

function ToolButton({ label, hint, disabled, onClick }: { label: string; hint: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="rounded-md px-2.5 py-1 text-neutral-300 hover:bg-neutral-800 hover:text-white disabled:opacity-40">
      {label} <span className="text-neutral-600">{hint}</span>
    </button>
  );
}

function Transport({ duration }: { duration: number }) {
  const playing = useEditor((s) => s.playing);
  const time = useEditor((s) => s.time);
  return (
    <div className="flex items-center gap-3 text-xs text-neutral-400 tabular-nums">
      <button
        type="button"
        onClick={() => (playing ? engineHost.pause() : engineHost.play())}
        aria-label={playing ? "Pause" : "Play"}
        className="flex size-8 items-center justify-center rounded-full bg-white text-neutral-900 hover:bg-neutral-200"
      >
        <svg viewBox="0 0 16 16" className="size-3.5 fill-current" aria-hidden>
          <path d={playing ? "M3.5 2h3.5v12H3.5zM9 2h3.5v12H9z" : "M4 2v12l10-6z"} />
        </svg>
      </button>
      {mmss(time)} / {mmss(duration)}
    </div>
  );
}
