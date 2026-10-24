import { useRef, useState, type ReactNode } from "react";
import { OpName, type FootageClip, type Project } from "@motionily/protocol";
import { api, mediaUrl } from "../../api/client";
import { DEFAULT_DUCK, DEFAULT_MUSIC_GAIN } from "../../audio/music";
import { transcribeFootage, type CaptionProgress } from "../../captions/voiceCaptions";
import { engineHost } from "../../engine/host";
import { browserLanguage, LANGUAGES } from "../../footage/languages";
import { ActivitySource, logActivity } from "../../store";
import { captioningLabel } from "../AgentLine";
import type { EditorProps } from "../context";
import { ModePiece } from "../mode";
import type { SceneView } from "../sceneView";
import { SunoDialog } from "./SunoDialog";
import { appendClipOps, editTracks, freshId } from "./tracks";
import type { EditActions } from "./useEditActions";
import { useAgentName } from "../../agentName";

export const CLIP_ACCEPT = "video/mp4,video/quicktime,video/webm";
export const SONG_ACCEPT = "audio/*";
/** Suno's own icon, for the button that opens the Suno prompt. */
export const SUNO_LOGO = "/brand/suno.png";
/** Frame shown as a clip's thumbnail (s): past a fade-in, early enough to load fast. */
export const THUMB_AT = 0.5;

export const MediaTab = { Clips: "clips", Music: "music" } as const;
export type MediaTab = (typeof MediaTab)[keyof typeof MediaTab];

const TAB_LABEL: Record<MediaTab, string> = { [MediaTab.Clips]: "Clips", [MediaTab.Music]: "Music" };

export const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

export const ICON = {
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
  note: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  plus: "M12 5v14M5 12h14",
};

export function Icon({ d, className = "size-5" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/**
 * Upload clips (they get transcribed here) and put them at the end of the edit. Without `edits`
 * (Simple mode) they only join the library, for Claude to place.
 */
export function useClipUpload(ed: EditorProps, edits: EditActions | null) {
  const [progress, setProgress] = useState<CaptionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Spoken language of new clips: the first clip's once there is one (the transcription never guesses). */
  const [picked, setPicked] = useState(browserLanguage);
  const language = ed.project?.footage[0]?.language ?? picked;

  const append = (p: Project, clipIds: string[]) => {
    if (!edits) return;
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

  const upload = async (files: File[]) => {
    const project = ed.project;
    const videos = files.filter((f) => f.type.startsWith("video/"));
    if (!project || !videos.length || progress) return;
    setError(null);
    try {
      let p = project;
      const before = new Set(p.footage.map((c) => c.id));
      for (const [i, f] of videos.entries()) {
        setProgress({ label: videos.length > 1 ? `Uploading ${i + 1} of ${videos.length}…` : "Uploading…", ratio: null });
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

  return { progress, error, language, setLanguage: setPicked, append, upload };
}
export type ClipUpload = ReturnType<typeof useClipUpload>;

/** Upload a song (or take Suno's) and put it under the whole video, starting where it fits best. */
export function useMusicUpload(ed: EditorProps, edits: EditActions) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Under the whole video, starting where the song fits it best (its loud part on the key moment). */
  const place = (m: { url: string; trimIn: number; duration?: number | null }) => {
    // Never start past the end of the song (it would play nothing).
    const trimIn = m.duration ? Math.min(m.trimIn, Math.max(0, m.duration - 1)) : m.trimIn;
    edits.apply([{ op: OpName.SetMusic, music: { src: m.url, start: 0, trim_in: trimIn, gain: DEFAULT_MUSIC_GAIN, duck: DEFAULT_DUCK } }], "Adds music", false);
  };
  const song = async (file: File) => {
    if (!ed.project) return;
    const p = await api.uploadMusic(ed.project.id, file);
    ed.setProject(p);
    if (p.music) place(p.music);
  };
  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      await song(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, place, song, upload };
}
export type MusicUpload = ReturnType<typeof useMusicUpload>;

/**
 * Edit mode's library: the user's clips and the video's music, each a tab. Empty, a tab is one big
 * drop zone; files dropped anywhere on the editor land here too.
 */
export function MediaPanel({
  ed,
  scene,
  tab,
  onTab,
  clips,
  music,
  onSelectMusic,
}: {
  ed: EditorProps;
  scene: SceneView | null;
  tab: MediaTab;
  onTab: (t: MediaTab) => void;
  clips: ClipUpload;
  music: MusicUpload;
  /** Select the music on the timeline, so its levels show in the inspector. */
  onSelectMusic: () => void;
}) {
  return (
    <aside className={`flex w-72 shrink-0 flex-col gap-4 overflow-hidden rounded-2xl bg-neutral-900/50 p-3 ring-1 ring-white/[0.06] ${ModePiece.Left}`}>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-neutral-950 p-1" role="tablist" aria-label="Media">
        {Object.values(MediaTab).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => onTab(t)}
            className={`rounded-md py-1.5 text-xs font-medium ${tab === t ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-white"}`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {tab === MediaTab.Clips ? <ClipsTab ed={ed} scene={scene} clips={clips} /> : <MusicTab ed={ed} scene={scene} music={music} onSelectMusic={onSelectMusic} />}
      </div>
    </aside>
  );
}

function ClipsTab({ ed, scene, clips }: { ed: EditorProps; scene: SceneView | null; clips: ClipUpload }) {
  const agent = useAgentName();
  const footage = ed.project?.footage ?? [];
  const used = new Set(scene?.layers.filter((l) => l.type === "video").map((l) => String(l.src)) ?? []);
  return (
    <>
      {footage.length === 0 ? (
        <>
          <DropZone accept={CLIP_ACCEPT} multiple busy={!!clips.progress} onFiles={(f) => void clips.upload(f)} big>
            <Icon d={ICON.film} className="size-7 text-neutral-400" />
            <span className="text-sm font-semibold text-neutral-200">Drop your clips here</span>
            <span className="text-xs text-neutral-500">or click to browse · MP4, MOV, WebM</span>
          </DropZone>
          <label className="flex items-center justify-between gap-2 px-1 text-xs text-neutral-500">
            Spoken in
            <select value={clips.language} onChange={(e) => clips.setLanguage(e.target.value)} className="rounded-md bg-neutral-950 px-2 py-1 text-xs text-neutral-200">
              {LANGUAGES.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p className="px-1 text-xs text-neutral-500">Each clip is transcribed, so you or {agent} can cut it by what is said.</p>
        </>
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {footage.map((c) => (
              <ClipRow key={c.id} clip={c} inEdit={used.has(c.url)} onAdd={() => ed.project && clips.append(ed.project, [c.id])} />
            ))}
          </ul>
          <DropZone accept={CLIP_ACCEPT} multiple busy={!!clips.progress} onFiles={(f) => void clips.upload(f)}>
            <Icon d={ICON.plus} className="size-4" />
            <span className="text-xs font-medium">Add clips</span>
          </DropZone>
        </>
      )}
      {clips.progress && <ProgressLine progress={clips.progress} />}
      {clips.error && <p className="px-1 text-xs text-red-400">{clips.error}</p>}
    </>
  );
}

function ClipRow({ clip, inEdit, onAdd }: { clip: FootageClip; inEdit: boolean; onAdd: () => void }) {
  return (
    <li className="group flex items-center gap-3 rounded-xl p-1.5 hover:bg-neutral-800/60">
      <span className="relative aspect-video w-20 shrink-0 overflow-hidden rounded-lg bg-neutral-800">
        <video src={`${mediaUrl(clip.url)}#t=${THUMB_AT}`} preload="metadata" muted playsInline className="size-full object-cover" />
        {clip.duration !== null && <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">{mmss(clip.duration)}</span>}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-neutral-200">{clip.name}</span>
        <span className="block text-[11px] text-neutral-500">
          {inEdit ? <span className="text-emerald-400">In the edit</span> : clip.words ? "Ready" : "Not transcribed yet"}
        </span>
      </span>
      <button
        type="button"
        onClick={onAdd}
        title="Add to the end of the edit"
        aria-label={`Add ${clip.name} to the end of the edit`}
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-neutral-400 opacity-60 group-hover:bg-white group-hover:text-neutral-900 group-hover:opacity-100"
      >
        <Icon d={ICON.plus} className="size-4" />
      </button>
    </li>
  );
}

function MusicTab({ ed, scene, music, onSelectMusic }: { ed: EditorProps; scene: SceneView | null; music: MusicUpload; onSelectMusic: () => void }) {
  const agent = useAgentName();
  const project = ed.project;
  const [suno, setSuno] = useState(false);
  const song = project?.music;
  const placed = !!scene?.music;
  return (
    <>
      {song ? (
        <div className="flex flex-col gap-3 rounded-xl bg-neutral-800/50 p-3">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-neutral-950 text-neutral-300">
              <Icon d={ICON.note} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-neutral-100">{song.name}</span>
              <span className="block text-[11px] text-neutral-500">
                {song.duration ? mmss(song.duration) : ""}
                {placed ? <span className="text-emerald-400">{song.duration ? " · " : ""}Under the video</span> : null}
              </span>
            </span>
          </div>
          {song.summary && <p className="text-[11px] leading-relaxed text-neutral-500">{song.summary}</p>}
          {placed ? (
            <button type="button" onClick={onSelectMusic} className="rounded-lg bg-neutral-950 px-3 py-2 text-xs font-medium text-neutral-200 hover:bg-neutral-900">
              Adjust volume and start
            </button>
          ) : (
            <button type="button" onClick={() => music.place(song)} className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-neutral-900 hover:bg-neutral-200">
              Put it under the video
            </button>
          )}
        </div>
      ) : (
        <p className="px-1 text-xs text-neutral-500">A song under the whole video. It gets quieter whenever someone speaks.</p>
      )}
      <DropZone accept={SONG_ACCEPT} busy={music.busy} onFiles={(f) => void music.upload(f[0])} big={!song}>
        {song ? (
          <span className="text-xs font-medium">{music.busy ? "Uploading…" : "Replace the song"}</span>
        ) : (
          <>
            <Icon d={ICON.note} className="size-7 text-neutral-400" />
            <span className="text-sm font-semibold text-neutral-200">{music.busy ? "Uploading…" : "Drop a song here"}</span>
            <span className="text-xs text-neutral-500">or click to browse · MP3, WAV, M4A</span>
          </>
        )}
      </DropZone>
      <button
        type="button"
        disabled={!project}
        onClick={() => setSuno(true)}
        className="flex items-center gap-3 rounded-xl p-2 text-left hover:bg-neutral-800/60 disabled:opacity-50"
      >
        <img src={SUNO_LOGO} alt="" className="size-8 shrink-0 rounded-full" />
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-neutral-200">Make one with Suno</span>
          <span className="block text-[11px] text-neutral-500">{agent} writes the prompt from your video</span>
        </span>
      </button>
      {music.error && <p className="px-1 text-xs text-red-400">{music.error}</p>}
      {suno && project && <SunoDialog project={project} onProject={ed.setProject} onSong={music.song} onClose={() => setSuno(false)} />}
    </>
  );
}

/** Click to browse or drop files on it. `big` fills the tab when it is empty. */
export function DropZone({ accept, multiple, busy, onFiles, big, children }: { accept: string; multiple?: boolean; busy?: boolean; onFiles: (f: File[]) => void; big?: boolean; children: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onFiles([...e.dataTransfer.files]);
        }}
        className={`flex items-center justify-center gap-1.5 rounded-xl border border-dashed text-center transition disabled:opacity-50 ${big ? "flex-col px-4 py-10" : "py-2.5"} ${
          over ? "border-white bg-white/5 text-white" : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-white"
        }`}
      >
        {children}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          // The same file can be picked again (e.g. after a failed upload).
          e.target.value = "";
        }}
      />
    </>
  );
}

export function ProgressLine({ progress }: { progress: CaptionProgress }) {
  return (
    <div className="flex flex-col gap-1.5 px-1">
      <span className="text-xs text-neutral-400">{captioningLabel(progress)}</span>
      <span className="relative h-1 overflow-hidden rounded-full bg-neutral-800">
        {progress.ratio === null ? (
          <span className="absolute inset-y-0 w-1/3 animate-pulse rounded-full bg-neutral-400" />
        ) : (
          <span className="absolute inset-y-0 left-0 rounded-full bg-white transition-[width]" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
        )}
      </span>
    </div>
  );
}
