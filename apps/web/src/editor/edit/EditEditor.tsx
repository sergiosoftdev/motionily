import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
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
import { EditTimeline, pickCount, type EditSelection, type Picks } from "./EditTimeline";
import { Inspector } from "./Inspector";
import { MediaPanel, MediaTab, mmss, useClipUpload, useMusicUpload } from "./MediaPanel";
import { editTracks } from "./tracks";
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
  const edits = useEditActions(footage);
  const tracks = useMemo(() => (scene ? editTracks(scene, footage) : null), [scene, footage]);
  const [cue, setCue] = useState<SfxCue | null>(null);
  const [musicOn, setMusicOn] = useState(false);
  /** Several pieces picked with the marquee or Shift-click (the editor's selection holds one). */
  const [picks, setPicks] = useState<Picks | null>(null);
  const [tab, setTab] = useState<MediaTab>(MediaTab.Clips);
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
        clips: tracks.clips.filter((c) => picks.clip.includes(c.id)),
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
    const clip = tracks.clips.find((c) => c.id === selectedLayer);
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
  const latest = useRef({ selection, ops, edits });
  latest.current = { selection, ops, edits };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const { selection: sel, ops: o, edits: ed2 } = latest.current;
      const meta = e.metaKey || e.ctrlKey;
      let handled = true;
      if (meta && e.key.toLowerCase() === "z") (e.shiftKey ? ed2.redo() : ed2.undo());
      else if (!meta && e.key.toLowerCase() === "s") o.split(sel?.kind === "clip" ? sel.clip : null);
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

  // Files dropped anywhere: videos become clips, a song the music. Drops a panel handles itself
  // (the library's zones, references on the ask box) never reach here twice.
  const [dragging, setDragging] = useState(0);
  const onDrop = (e: DragEvent) => {
    setDragging(0);
    if (e.defaultPrevented || !hasFiles(e)) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const song = files.find((f) => f.type.startsWith("audio/"));
    if (files.some((f) => f.type.startsWith("video/"))) {
      setTab(MediaTab.Clips);
      void clips.upload(files);
    } else if (song) {
      setTab(MediaTab.Music);
      void music.upload(song);
    }
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
        {project && <ExportButton name={project.name} audioUrl={project.audio ? mediaUrl(project.audio.url) : null} />}
      </header>

      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex min-h-0 flex-1 gap-3">
            <MediaPanel
              ed={ed}
              scene={scene}
              tab={tab}
              onTab={setTab}
              clips={clips}
              music={music}
              onSelectMusic={() => {
                deselect();
                setMusicOn(true);
              }}
            />
            {/* Any frame shape fits here: the viewer scales it to the space it gets. */}
            <main className="flex min-w-0 flex-1 flex-col items-center gap-2 py-1">
              <Viewer canvas={ed.canvas} error={ed.error} maxWidth={PREVIEW_MAX_WIDTH} canvasClass="rounded-xl shadow-2xl shadow-black/50" />
              <Transport duration={scene?.duration ?? 0} />
              <AttentionStrip g={ed.g} className="w-full max-w-xl" />
            </main>
          </div>
          {/* As tall as its tracks, up to 40% of the screen: the preview keeps the rest. */}
          <div className={`relative flex max-h-[40%] min-h-44 shrink-0 flex-col rounded-2xl ring-1 ring-white/[0.06] ${ModePiece.Timeline}`}>
            <div className="flex items-center gap-1 px-3 py-1.5 text-xs">
              <ToolButton label="Split" hint="S" onClick={() => ops.split(selection?.kind === "clip" ? selection.clip : null)} />
              <ToolButton label="Delete" hint="⌫" disabled={!selection} onClick={() => selection && (ops.remove(selection), setCue(null), setMusicOn(false), setPicks(null))} />
              <ToolButton label="Undo" hint="⌘Z" disabled={!edits.canUndo} onClick={edits.undo} />
              <ToolButton label="Redo" hint="⇧⌘Z" disabled={!edits.canRedo} onClick={edits.redo} />
              <span className="ml-auto truncate pl-3 text-neutral-600">Drag to move, edges to trim · click a cut for a transition · ⌘ + wheel zooms</span>
            </div>
            {scene && tracks ? (
              <EditTimeline scene={scene} tracks={tracks} selection={selection} audioUrl={project?.audio ? mediaUrl(project.audio.url) : null} onSelectCue={setCue} onSelectMusic={setMusicOn} onPick={setPicks} edits={edits} />
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
        <ClaudePanel
          ed={ed}
          hasScene={hasScene}
          hasFootage={!!tracks?.clips.length}
          selection={selection && <Inspector selection={selection} ops={ops} edits={edits} songLength={project?.music?.duration ?? null} clipIds={tracks?.clips.map((c) => c.id) ?? []} onClose={deselect} />}
        />
      </div>

      {dragging > 0 && (
        <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-3xl border-2 border-dashed border-white/60 bg-black/50">
          <p className="rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-semibold">Drop to add · videos go to Clips, a song to Music</p>
        </div>
      )}
    </div>
  );
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
