import { useEffect, useMemo, useRef, useState } from "react";
import { OpName, type Project } from "@motionily/protocol";
import { api, mediaUrl } from "../../api/client";
import type { SfxCue } from "../../audio/sfxPlayer";
import { DEFAULT_DUCK, DEFAULT_MUSIC_GAIN, type MusicTrack } from "../../audio/music";
import { transcribeFootage, type CaptionProgress } from "../../captions/voiceCaptions";
import { AskBox, AskVariant } from "../../components/AskBox";
import { Logo } from "../../components/Logo";
import { engineHost } from "../../engine/host";
import { ExportButton } from "../../export/ExportButton";
import { ScheduleButton } from "../../posts/ScheduleButton";
import { href, RouteName } from "../../router";
import { ActivitySource, logActivity, useEditor } from "../../store";
import { AgentLine, captioningLabel } from "../AgentLine";
import type { EditorProps } from "../context";
import { ModeSwitch } from "../mode";
import { ProjectTitle } from "../ProjectTitle";
import { useSceneView, type SceneView } from "../sceneView";
import { useTransportKeys } from "../transportKeys";
import { Viewer } from "../Viewer";
import { EditTimeline, type EditSelection } from "./EditTimeline";
import { appendClipOps, editTracks, freshId, rippleDeleteOps, splitClipOps, type EditClip, type EditTracks, type GraphicsBlock } from "./tracks";
import { useEditActions, type EditActions } from "./useEditActions";

const PREVIEW_MAX_WIDTH = 900;
const UPLOAD_ACCEPT = "video/mp4,video/quicktime,video/webm";

const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const typing = (el: EventTarget | null) => {
  const e = el as HTMLElement | null;
  return !!e && (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT" || e.isContentEditable);
};

/**
 * Edit mode, CapCut-style: a multitrack timeline of the video's clips, graphics blocks, captions and
 * sound, the clips library on the left, the preview in the middle and, on the right, the box that asks
 * Claude for anything at the playhead ("an animated map here, 5 seconds") over the selected piece's settings.
 */
export function EditEditor({ ed }: { ed: EditorProps }) {
  const { project, g } = ed;
  const scene = useSceneView();
  const fps = scene?.fps ?? 30;
  const footage = useMemo(() => project?.footage ?? [], [project?.footage]);
  const edits = useEditActions(footage);
  const tracks = useMemo(() => (scene ? editTracks(scene, footage) : null), [scene, footage]);
  const [cue, setCue] = useState<SfxCue | null>(null);
  const [musicOn, setMusicOn] = useState(false);
  const selectedLayer = useEditor((s) => s.selectedLayerId);
  const selectedGroup = useEditor((s) => s.selectedGroup);
  const [sceneW, sceneH] = useEditor((s) => s.sceneSize);
  /** Taller than wide (9:16, 4:5): the preview takes a full-height column of its own. */
  const tall = sceneH > sceneW;
  useTransportKeys(fps, true);

  // The selection is the editor's (canvas clicks select here too); only sound effects are local.
  const selection: EditSelection = useMemo(() => {
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
  }, [musicOn, scene?.music, cue, tracks, selectedGroup, selectedLayer]);

  const ops = useEditOps(scene, tracks, edits);

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
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const preview = (
    <>
      <Viewer canvas={ed.canvas} error={ed.error} maxWidth={PREVIEW_MAX_WIDTH} canvasClass="rounded-xl shadow-2xl shadow-black/50" />
      <Transport duration={scene?.duration ?? 0} />
    </>
  );
  const askAndInspector = (
    <>
      <div className="flex flex-col gap-2">
        <AgentLine g={g} captioning={ed.captioning} />
        {project && <AskBox g={g} hasScene={!!project.scene} projectId={ed.id} variant={AskVariant.Simple} />}
      </div>
      <Inspector selection={selection} scene={scene} ops={ops} edits={edits} />
    </>
  );
  const timeline = (
    <>
      <div className="flex items-center gap-1 px-3 py-1.5 text-xs">
        <ToolButton label="Split" hint="S" onClick={() => ops.split(selection?.kind === "clip" ? selection.clip : null)} />
        <ToolButton label="Delete" hint="⌫" disabled={!selection} onClick={() => selection && (ops.remove(selection), setCue(null), setMusicOn(false))} />
        <ToolButton label="Undo" hint="⌘Z" disabled={!edits.canUndo} onClick={edits.undo} />
        <ToolButton label="Redo" hint="⇧⌘Z" disabled={!edits.canRedo} onClick={edits.redo} />
        <span className="ml-auto truncate pl-3 text-neutral-600">Drag clips and blocks to move them, their edges to trim · ⌘ + wheel zooms</span>
      </div>
      {scene && tracks ? (
        <EditTimeline scene={scene} tracks={tracks} selection={selection} onSelectCue={setCue} onSelectMusic={setMusicOn} edits={edits} />
      ) : (
        <p className="px-4 text-sm text-neutral-500">Loading…</p>
      )}
    </>
  );

  return (
    <div className="flex h-dvh flex-col bg-neutral-950">
      <header className="flex items-center gap-4 px-5 py-2.5">
        <a href={href({ name: RouteName.Projects })} className="shrink-0">
          <Logo />
        </a>
        <ProjectTitle project={project} onRename={ed.rename} className="flex-1 rounded-md px-2 py-1 text-sm font-medium hover:bg-neutral-900 focus:bg-neutral-900" />
        <ModeSwitch mode={ed.mode} onChange={ed.setMode} className="bg-neutral-900" />
        {project && <ScheduleButton ed={ed} />}
        {project && <ExportButton name={project.name} audioUrl={project.audio ? mediaUrl(project.audio.url) : null} />}
      </header>

      {tall ? (
        // Vertical video: the preview is a full-height column on the right; tools and timeline share the left.
        <div className="flex min-h-0 flex-1 gap-5 px-4 pb-3">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {/* Tools take what they need (up to half), the timeline the rest. */}
            <div className="flex max-h-[50%] min-h-0 shrink-0 gap-4">
              <MediaBin ed={ed} edits={edits} scene={scene} />
              <aside className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto py-2">{askAndInspector}</aside>
            </div>
            <div className="flex min-h-44 flex-1 flex-col rounded-xl border border-neutral-900">{timeline}</div>
          </div>
          <main className="flex shrink-0 flex-col items-center gap-2" style={{ width: `min(45vw, calc((100dvh - 7rem) * ${sceneW / sceneH}))` }}>
            {preview}
          </main>
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 gap-4 px-4 pb-2">
            <MediaBin ed={ed} edits={edits} scene={scene} />
            <main className="flex min-w-0 flex-1 flex-col items-center gap-2">{preview}</main>
            <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto py-2">{askAndInspector}</aside>
          </div>
          {/* As tall as its tracks, up to 40% of the screen: the preview keeps the rest. */}
          <div className="flex max-h-[40vh] min-h-44 shrink-0 flex-col border-t border-neutral-900">{timeline}</div>
        </>
      )}
    </div>
  );
}

/** Split, delete and their friends, shared by keys, toolbar and inspector. */
function useEditOps(scene: SceneView | null, tracks: EditTracks | null, edits: EditActions) {
  /** Split the given clip at the playhead, or the main-track clip under it. */
  const split = (clip: EditClip | null) => {
    if (!scene || !tracks) return;
    const t = useEditor.getState().time;
    const c = clip && t > clip.start && t < clip.end ? clip : tracks.clips.find((x) => x.lane === 0 && t > x.start && t < x.end);
    const layer = c && engineHost.layer(c.id);
    if (!c || !layer) return;
    const id = freshId(c.id, new Set(scene.layers.map((l) => l.id)));
    const o = splitClipOps(c, t, layer, id, scene.layers.findIndex((l) => l.id === c.id));
    if (o) edits.apply(o, `Splits ${c.id} at ${t.toFixed(2)} s`, true);
  };
  const remove = (sel: NonNullable<EditSelection>) => {
    if (!scene) return;
    if (sel.kind === "clip") {
      const c = sel.clip;
      // The main track closes its gap; an overlay just goes.
      const o = c.lane === 0 ? rippleDeleteOps(c, scene) : [{ op: OpName.RemoveLayer, id: c.id }];
      edits.apply(o, c.lane === 0 ? `Deletes ${c.id} and closes the gap` : `Deletes ${c.id}`, true);
    } else if (sel.kind === "block") {
      const b = sel.block;
      edits.apply(b.group ? [{ op: OpName.RemoveGroup, group: b.group }] : b.ids.map((id) => ({ op: OpName.RemoveLayer, id })), `Deletes ${b.label}`, false);
    } else if (sel.kind === "cue") edits.apply([{ op: OpName.RemoveSfx, id: sel.cue.id }], `Deletes the ${sel.cue.sound} effect`, false);
    else edits.apply([{ op: OpName.SetMusic, music: null }], "Removes the music", false);
    useEditor.setState({ selectedLayerId: null, selectedGroup: null });
  };
  return { split, remove };
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

/** The user's clips: add them to the end of the edit, or upload more (they get transcribed here). */
function MediaBin({ ed, edits, scene }: { ed: EditorProps; edits: EditActions; scene: SceneView | null }) {
  const project = ed.project;
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<CaptionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const append = (p: Project, clipIds: string[]) => {
    const s = JSON.parse(engineHost.sceneJson()) as SceneView;
    const clips = editTracks(s, p.footage).clips.filter((c) => c.lane === 0);
    let at = clips.length ? Math.max(...clips.map((c) => c.end)) : 0;
    const taken = new Set(s.layers.map((l) => l.id));
    let under = s.layers.filter((l) => l.type === "video").length;
    const o = clipIds.flatMap((cid) => {
      const fc = p.footage.find((c) => c.id === cid);
      if (!fc) return [];
      const id = freshId("ft", taken);
      taken.add(id);
      const out = appendClipOps(fc, at, engineHost.sceneSize(), id, under++);
      at += fc.duration ?? 1;
      return out;
    });
    if (o.length) edits.apply(o, `Adds ${clipIds.join(", ")} to the edit`, true);
  };

  const upload = async (files: FileList | null) => {
    if (!project || !files?.length) return;
    setError(null);
    const language = project.footage[0]?.language ?? "en";
    try {
      let p = project;
      const before = new Set(p.footage.map((c) => c.id));
      for (const [i, f] of [...files].entries()) {
        setProgress({ label: `Uploading ${i + 1} of ${files.length}…`, ratio: null });
        p = await api.uploadFootage(project.id, f, language);
        ed.setProject(p);
      }
      await transcribeFootage(p, setProgress, (np) => {
        p = np;
        ed.setProject(np);
      });
      append(p, p.footage.filter((c) => !before.has(c.id)).map((c) => c.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      logActivity(ActivitySource.System, `Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProgress(null);
    }
  };

  const used = new Set(scene?.layers.filter((l) => l.type === "video").map((l) => String(l.src)) ?? []);
  return (
    <aside className="flex w-56 shrink-0 flex-col gap-3 overflow-y-auto py-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Clips</span>
        <button type="button" disabled={!!progress} onClick={() => input.current?.click()} className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs font-semibold hover:bg-neutral-700 disabled:opacity-50">
          Upload
        </button>
        <input ref={input} type="file" accept={UPLOAD_ACCEPT} multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
      </div>
      {project?.footage.length ? (
        project.footage.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-900">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-neutral-200">
                <span className="text-neutral-500">{c.id}</span> {c.name}
              </p>
              <p className="text-[11px] text-neutral-500">
                {c.duration ? mmss(c.duration) : "?"} · {c.words ? `${c.words.length} words` : "not transcribed"}
                {used.has(c.url) ? " · in the edit" : ""}
              </p>
            </div>
            <button type="button" onClick={() => project && append(project, [c.id])} title="Add to the end of the edit" className="rounded-md px-2 text-lg leading-none text-neutral-400 hover:bg-neutral-800 hover:text-white">
              +
            </button>
          </div>
        ))
      ) : (
        <p className="text-xs text-neutral-500">Upload what you recorded: it is transcribed here, and you can cut it by hand or ask Claude to.</p>
      )}
      {progress && <p className="text-xs text-neutral-400">{captioningLabel(progress)}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <MusicBin ed={ed} edits={edits} scene={scene} />
    </aside>
  );
}

/** Background music: upload a song; it goes under the whole video, lower while the voice speaks. */
function MusicBin({ ed, edits, scene }: { ed: EditorProps; edits: EditActions; scene: SceneView | null }) {
  const project = ed.project;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const place = (src: string) => edits.apply([{ op: OpName.SetMusic, music: { src, start: 0, trim_in: 0, gain: DEFAULT_MUSIC_GAIN, duck: DEFAULT_DUCK } }], "Adds music", false);
  const upload = async (file: File | undefined) => {
    if (!project || !file) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.uploadMusic(project.id, file);
      ed.setProject(p);
      if (p.music) place(p.music.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Music</span>
        <button type="button" disabled={busy} onClick={() => input.current?.click()} className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs font-semibold hover:bg-neutral-700 disabled:opacity-50">
          {busy ? "Uploading…" : project?.music ? "Replace" : "Add"}
        </button>
        <input ref={input} type="file" accept="audio/*" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
      </div>
      {project?.music ? (
        <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-neutral-900">
          <span className="min-w-0 flex-1 truncate text-neutral-200">♪ {project.music.name}</span>
          {!scene?.music && (
            <button type="button" onClick={() => place(project.music!.url)} className="rounded-md px-2 text-neutral-400 hover:bg-neutral-800 hover:text-white">
              Use
            </button>
          )}
        </div>
      ) : (
        <p className="text-xs text-neutral-500">A song under the whole video. It gets quieter by itself whenever someone speaks.</p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

/** Settings of what is selected in the timeline. */
function Inspector({ selection, scene, ops, edits }: { selection: EditSelection; scene: SceneView | null; ops: ReturnType<typeof useEditOps>; edits: EditActions }) {
  return (
    <div className="flex flex-col gap-4 text-sm">
      {!selection ? (
        <div className="flex flex-col gap-2 text-xs text-neutral-500">
          <span className="text-sm font-semibold text-neutral-200">Edit</span>
          <p>Click a clip, a graphics block or an effect to change it. S splits at the playhead; Delete removes (the main track closes the gap).</p>
          <p>To add motion graphics anywhere, put the playhead there and ask Claude in the box above.</p>
          {scene && <p>{scene.layers.length} layers · {scene.duration.toFixed(1)} s</p>}
        </div>
      ) : selection.kind === "clip" ? (
        <ClipInspector clip={selection.clip} ops={ops} edits={edits} />
      ) : selection.kind === "block" ? (
        <BlockInspector block={selection.block} ops={ops} />
      ) : selection.kind === "cue" ? (
        <CueInspector cue={selection.cue} edits={edits} ops={ops} />
      ) : (
        <MusicInspector music={selection.music} edits={edits} ops={ops} />
      )}
    </div>
  );
}

function Slider({ label, value, min, max, step, format, onChange, onDone }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void; onDone: () => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-neutral-400">
      <span className="flex justify-between">
        {label} <span className="text-neutral-200 tabular-nums">{format(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={onDone} onKeyUp={onDone} className="accent-white" />
    </label>
  );
}

function ClipInspector({ clip, ops, edits }: { clip: EditClip; ops: ReturnType<typeof useEditOps>; edits: EditActions }) {
  const live = (o: Parameters<EditActions["preview"]>[0]) => edits.preview(o);
  const started = useRef(false);
  const change = (o: Parameters<EditActions["preview"]>[0]) => {
    if (!started.current) edits.begin();
    started.current = true;
    live(o);
  };
  const done = (what: string, recaption = false) => {
    if (!started.current) return;
    started.current = false;
    edits.end(what, recaption);
  };
  const fileOut = clip.out ?? clip.in + (clip.end - clip.start) * clip.speed;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="truncate text-sm font-semibold">{clip.name}</p>
        <p className="text-xs text-neutral-500 tabular-nums">
          {clip.start.toFixed(2)}–{clip.end.toFixed(2)} s on the video · file {clip.in.toFixed(2)}–{fileOut.toFixed(2)} s
        </p>
      </div>
      <Slider label="Volume" value={clip.volume} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => change([{ op: OpName.Patch, id: clip.id, fields: { volume: v } }])} onDone={() => done(`Volume of ${clip.id}`, true)} />
      <Slider label="Zoom" value={clip.scale} min={1} max={1.6} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => change([{ op: OpName.SetProp, id: clip.id, prop: "scale", value: v }])} onDone={() => done(`Zoom of ${clip.id}`)} />
      <label className="flex flex-col gap-1 text-xs text-neutral-400">
        Speed
        <select
          value={clip.speed}
          onChange={(e) => {
            const speed = Number(e.target.value);
            const end = Math.round((clip.start + (fileOut - clip.in) / speed) * 1000) / 1000;
            edits.apply([{ op: OpName.Patch, id: clip.id, fields: { speed } }, { op: OpName.SetTiming, id: clip.id, start: clip.start, end }], `Speed of ${clip.id}: ${speed}×`, true);
          }}
          className="rounded-md bg-neutral-800 px-2 py-1.5 text-sm text-white"
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <button type="button" onClick={() => ops.split(clip)} className="flex-1 rounded-md bg-neutral-800 px-2 py-1.5 text-xs font-semibold hover:bg-neutral-700">
          Split at playhead
        </button>
        <button type="button" onClick={() => ops.remove({ kind: "clip", clip })} className="rounded-md px-2 py-1.5 text-xs text-neutral-400 hover:text-red-400">
          Delete
        </button>
      </div>
    </div>
  );
}

function BlockInspector({ block, ops }: { block: GraphicsBlock; ops: ReturnType<typeof useEditOps> }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="truncate text-sm font-semibold">{block.label}</p>
        <p className="text-xs text-neutral-500 tabular-nums">
          Motion graphics · {block.start.toFixed(2)}–{block.end.toFixed(2)} s · {block.ids.length} layers
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          engineHost.pause();
          engineHost.seek(block.start + 0.05);
          useEditor.setState({ pinnedMoment: true });
        }}
        className="rounded-md bg-white px-3 py-2 text-xs font-semibold text-neutral-900 hover:bg-neutral-200"
      >
        Ask Claude to change it
      </button>
      <p className="text-xs text-neutral-500">The box above now points at this block and its moment. Drag the block to move it in time.</p>
      <button type="button" onClick={() => ops.remove({ kind: "block", block })} className="self-start text-xs text-neutral-400 hover:text-red-400">
        Delete block
      </button>
    </div>
  );
}

function CueInspector({ cue, edits, ops }: { cue: SfxCue; edits: EditActions; ops: ReturnType<typeof useEditOps> }) {
  const [gain, setGain] = useState(cue.gain ?? 1);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-semibold">{cue.sound}</p>
        <p className="text-xs text-neutral-500 tabular-nums">Sound effect at {cue.at.toFixed(2)} s</p>
      </div>
      <Slider label="Level" value={gain} min={0.05} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={setGain} onDone={() => edits.apply([{ op: OpName.PutSfx, cue: { ...cue, gain } }], `Level of the ${cue.sound} effect`, false)} />
      <button type="button" onClick={() => ops.remove({ kind: "cue", cue })} className="self-start text-xs text-neutral-400 hover:text-red-400">
        Delete effect
      </button>
    </div>
  );
}

/** Level of the music, how far it ducks while the voice speaks, and where in the song it starts. */
function MusicInspector({ music, edits, ops }: { music: MusicTrack; edits: EditActions; ops: ReturnType<typeof useEditOps> }) {
  const [draft, setDraft] = useState(music);
  useEffect(() => setDraft(music), [music]);
  const save = (what: string) => edits.apply([{ op: OpName.SetMusic, music: draft }], what, false);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="truncate text-sm font-semibold">♪ Music</p>
        <p className="text-xs text-neutral-500 tabular-nums">From {music.start.toFixed(1)} s on the video · song from {music.trim_in.toFixed(1)} s</p>
      </div>
      <Slider label="Level" value={draft.gain} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(gain) => setDraft({ ...draft, gain })} onDone={() => save("Music level")} />
      <Slider label="While the voice speaks" value={draft.duck} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}% of that`} onChange={(duck) => setDraft({ ...draft, duck })} onDone={() => save("Music ducking")} />
      <Slider label="Start the song at" value={draft.trim_in} min={0} max={180} step={0.5} format={(v) => `${v.toFixed(1)} s`} onChange={(trim_in) => setDraft({ ...draft, trim_in })} onDone={() => save("Music start in the song")} />
      <button type="button" onClick={() => ops.remove({ kind: "music", music })} className="self-start text-xs text-neutral-400 hover:text-red-400">
        Remove music
      </button>
    </div>
  );
}
