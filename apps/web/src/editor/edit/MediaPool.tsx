import { useCallback, useEffect, useState, type DragEvent } from "react";
import { MediaKind, type FootageClip, type MediaItem } from "@motionily/protocol";
import { api, mediaUrl } from "../../api/client";
import { useAgentName } from "../../agentName";
import { LANGUAGES } from "../../footage/languages";
import { ActivitySource, logActivity } from "../../store";
import type { EditorProps } from "../context";
import { ModePiece } from "../mode";
import type { SceneView } from "../sceneView";
import { DropZone, ICON, Icon, ProgressLine, SUNO_LOGO, THUMB_AT, mmss, type ClipUpload, type MusicUpload } from "./MediaPanel";
import { SunoDialog } from "./SunoDialog";

/** Everything the pool takes: clips (transcribed), sounds and pictures. */
export const POOL_ACCEPT = "video/mp4,video/quicktime,video/webm,audio/*,image/png,image/jpeg,image/webp,image/gif";
/** Drag payload from a pool tile to the timeline. */
export const POOL_DRAG = "application/x-motionily-media";

export const PoolFilter = { All: "all", Video: "video", Audio: "audio", Images: "images" } as const;
type PoolFilter = (typeof PoolFilter)[keyof typeof PoolFilter];
const FILTER_LABEL: Record<PoolFilter, string> = { all: "All", video: "Video", audio: "Audio", images: "Images" };

/** What a tile stands for: one of the user's clips, or a sound / picture from the pool. */
export type PoolEntry = { source: "footage"; clip: FootageClip } | { source: "media"; item: MediaItem };
/** What travels when a tile is dragged to the timeline. */
export type PoolDrop = { source: "footage" | "media"; id: string };

export const isPoolDrag = (e: DragEvent) => e.dataTransfer.types.includes(POOL_DRAG);
export function readPoolDrop(e: DragEvent): PoolDrop | null {
  try {
    return JSON.parse(e.dataTransfer.getData(POOL_DRAG)) as PoolDrop;
  } catch {
    return null;
  }
}

/** The video's sounds and pictures, kept in sync with the API. */
export function useMediaPool(projectId: string | undefined) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (projectId) api.projectMedia(projectId).then(setItems, () => setItems([]));
  }, [projectId]);
  const upload = useCallback(
    async (files: File[]) => {
      if (!projectId || !files.length) return [];
      setBusy(true);
      setError(null);
      const added: MediaItem[] = [];
      try {
        for (const f of files) {
          const item = await api.uploadMedia(projectId, f);
          added.push(item);
          setItems((xs) => [...xs, item]);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return added;
    },
    [projectId],
  );
  const remove = useCallback(
    async (id: string) => {
      if (!projectId) return;
      await api.removeMedia(projectId, id);
      setItems((xs) => xs.filter((m) => m.id !== id));
    },
    [projectId],
  );
  return { items, busy, error, upload, remove };
}
export type MediaPoolState = ReturnType<typeof useMediaPool>;

/**
 * Edit mode's media pool, as in any editor: every clip, sound and picture of the video in one grid.
 * Import or drop files; drag a tile onto the timeline (or double-click it to add it at the playhead).
 * Clips are transcribed on the way in, so they can be cut by what is said.
 */
export function MediaPool({
  ed,
  scene,
  clips,
  music,
  pool,
  onAdd,
}: {
  ed: EditorProps;
  scene: SceneView | null;
  clips: ClipUpload;
  music: MusicUpload;
  pool: MediaPoolState;
  /** Put a tile on the timeline at the playhead. */
  onAdd: (drop: PoolDrop) => void;
}) {
  const agent = useAgentName();
  const [filter, setFilter] = useState<PoolFilter>(PoolFilter.All);
  const [suno, setSuno] = useState(false);
  const project = ed.project;
  const used = new Set((scene?.layers ?? []).map((l) => String(l.src ?? "")));
  const entries: PoolEntry[] = [...(project?.footage ?? []).map((clip): PoolEntry => ({ source: "footage", clip })), ...pool.items.map((item): PoolEntry => ({ source: "media", item }))];
  const shown = entries.filter((e) => {
    if (filter === PoolFilter.All) return true;
    if (e.source === "footage") return filter === PoolFilter.Video;
    return filter === (e.item.kind === MediaKind.Audio ? PoolFilter.Audio : PoolFilter.Images);
  });

  const importFiles = async (files: File[]) => {
    const videos = files.filter((f) => f.type.startsWith("video/"));
    const rest = files.filter((f) => !f.type.startsWith("video/"));
    if (rest.length) {
      const added = await pool.upload(rest);
      if (added.length) logActivity(ActivitySource.User, `Imports ${added.map((m) => m.name).join(", ")}`);
    }
    if (videos.length) await clips.upload(videos);
  };

  return (
    <aside className={`flex w-80 shrink-0 flex-col gap-3 overflow-hidden rounded-2xl bg-neutral-900/50 p-3 ring-1 ring-white/[0.06] ${ModePiece.Left}`}>
      <div className="flex items-center justify-between px-1">
        <span className="text-sm font-semibold">Media</span>
        <span className="text-[11px] text-neutral-500">{entries.length ? `${entries.length} items` : ""}</span>
      </div>
      <div className="grid grid-cols-4 gap-1 rounded-lg bg-neutral-950 p-1" role="tablist" aria-label="Media filter">
        {Object.values(PoolFilter).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`rounded-md py-1 text-[11px] font-medium ${filter === f ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-white"}`}
          >
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {entries.length === 0 ? (
          <DropZone accept={POOL_ACCEPT} multiple busy={!!clips.progress || pool.busy} onFiles={(f) => void importFiles(f)} big>
            <Icon d={ICON.film} className="size-7 text-neutral-400" />
            <span className="text-sm font-semibold text-neutral-200">Import media</span>
            <span className="text-xs text-neutral-500">Videos, music and sounds, photos · drop or click</span>
          </DropZone>
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-2">
              {shown.map((e) => (
                <Tile key={e.source === "footage" ? `f:${e.clip.id}` : `m:${e.item.id}`} entry={e} used={used} music={music} onAdd={onAdd} onRemove={e.source === "media" ? () => void pool.remove(e.item.id) : undefined} />
              ))}
            </ul>
            {!shown.length && <p className="px-1 text-xs text-neutral-500">Nothing of this kind yet.</p>}
            <DropZone accept={POOL_ACCEPT} multiple busy={!!clips.progress || pool.busy} onFiles={(f) => void importFiles(f)}>
              <Icon d={ICON.plus} className="size-4" />
              <span className="text-xs font-medium">{pool.busy ? "Importing…" : "Import"}</span>
            </DropZone>
          </>
        )}
        {clips.progress && <ProgressLine progress={clips.progress} />}
        {(clips.error || pool.error || music.error) && <p className="px-1 text-xs text-red-400">{clips.error ?? pool.error ?? music.error}</p>}
      </div>
      <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-2">
        <label className="flex items-center justify-between gap-2 px-1 text-[11px] text-neutral-500">
          Clips spoken in
          <select value={clips.language} onChange={(e) => clips.setLanguage(e.target.value)} className="rounded-md bg-neutral-950 px-2 py-1 text-[11px] text-neutral-200">
            {LANGUAGES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!project} onClick={() => setSuno(true)} className="flex items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-neutral-800/60 disabled:opacity-50">
          <img src={SUNO_LOGO} alt="" className="size-6 shrink-0 rounded-full" />
          <span className="min-w-0">
            <span className="block text-[11px] font-semibold text-neutral-200">Make music with Suno</span>
            <span className="block text-[10px] text-neutral-500">{agent} writes the prompt from your video</span>
          </span>
        </button>
      </div>
      {suno && project && <SunoDialog project={project} onProject={ed.setProject} onSong={music.song} onClose={() => setSuno(false)} />}
    </aside>
  );
}

function Tile({ entry, used, music, onAdd, onRemove }: { entry: PoolEntry; used: Set<string>; music: MusicUpload; onAdd: (d: PoolDrop) => void; onRemove?: () => void }) {
  const drop: PoolDrop = entry.source === "footage" ? { source: "footage", id: entry.clip.id } : { source: "media", id: entry.item.id };
  const url = entry.source === "footage" ? entry.clip.url : entry.item.url;
  const name = entry.source === "footage" ? entry.clip.name : entry.item.name;
  const duration = entry.source === "footage" ? entry.clip.duration : entry.item.duration;
  const isAudio = entry.source === "media" && entry.item.kind === MediaKind.Audio;
  const inEdit = used.has(url);
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(POOL_DRAG, JSON.stringify(drop));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onDoubleClick={() => onAdd(drop)}
      title={`${name} · drag to the timeline or double-click to add at the playhead`}
      className="group relative flex cursor-grab flex-col gap-1 rounded-lg p-1 hover:bg-neutral-800/60 active:cursor-grabbing"
    >
      <span className="relative aspect-video overflow-hidden rounded-md bg-neutral-800">
        {entry.source === "footage" ? (
          <video src={`${mediaUrl(url)}#t=${THUMB_AT}`} preload="metadata" muted playsInline className="pointer-events-none size-full object-cover" />
        ) : isAudio ? (
          <span className="flex size-full items-center justify-center bg-gradient-to-br from-emerald-900/60 to-neutral-900 text-emerald-200">
            <Icon d={ICON.note} className="size-6" />
          </span>
        ) : (
          <img src={mediaUrl(url)} alt="" draggable={false} className="pointer-events-none size-full object-cover" />
        )}
        {duration != null && <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">{mmss(duration)}</span>}
        {inEdit && <span className="absolute top-1 left-1 size-2 rounded-full bg-emerald-400 ring-2 ring-black/60" title="In the edit" />}
        <span className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100">
          <button type="button" onClick={() => onAdd(drop)} title="Add at the playhead" aria-label={`Add ${name} at the playhead`} className="flex size-6 items-center justify-center rounded-full bg-white text-neutral-900">
            <Icon d={ICON.plus} className="size-3.5" />
          </button>
          {onRemove && (
            <button type="button" onClick={onRemove} title="Remove from the pool" aria-label={`Remove ${name}`} className="flex size-6 items-center justify-center rounded-full bg-black/70 text-neutral-200 hover:text-red-300">
              ×
            </button>
          )}
        </span>
      </span>
      <span className="truncate px-0.5 text-[11px] text-neutral-300">{name}</span>
      {isAudio && entry.source === "media" && (
        <button
          type="button"
          onClick={() => music.place({ url: entry.item.url, trimIn: 0, duration: entry.item.duration })}
          className="self-start px-0.5 text-[10px] text-neutral-500 hover:text-white"
        >
          Use as music (ducks under the voice)
        </button>
      )}
    </li>
  );
}
