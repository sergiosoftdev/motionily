import { useCallback, useEffect, useState, type DragEvent } from "react";
import { MediaKind, type FootageClip, type MediaItem } from "@motionily/protocol";
import { CleanMode, api, mediaUrl } from "../../api/client";
import { engineHost } from "../../engine/host";
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "../../desktop";
import { useAgentName } from "../../agentName";
import { LANGUAGES } from "../../footage/languages";
import { ActivitySource, logActivity } from "../../store";
import type { EditorProps } from "../context";
import { ModePiece } from "../mode";
import type { SceneView } from "../sceneView";
import { DropZone, ICON, Icon, ProgressLine, SUNO_LOGO, THUMB_AT, mmss, type ClipUpload, type MusicUpload } from "./MediaPanel";
import { SunoDialog } from "./SunoDialog";

/** Everything the pool takes: clips (transcribed), sounds and pictures. */
export const POOL_ACCEPT = "video/mp4,video/quicktime,video/webm,audio/*,image/png,image/jpeg,image/webp,image/gif,.cube";
/** Drag payload from a pool tile to the timeline. */
export const POOL_DRAG = "application/x-motionily-media";

export const PoolFilter = { All: "all", Video: "video", Audio: "audio", Images: "images", Luts: "luts" } as const;
type PoolFilter = (typeof PoolFilter)[keyof typeof PoolFilter];
const FILTER_LABEL: Record<PoolFilter, string> = { all: "All", video: "Video", audio: "Audio", images: "Images", luts: "LUTs" };

/** What a tile stands for: one of the user's clips, or a sound / picture from the pool. */
export type PoolEntry = { source: "footage"; clip: FootageClip } | { source: "media"; item: MediaItem };
/** The NLE edits a picked tile makes on the timeline. */
export const PoolEdit = { Insert: "insert", Overwrite: "overwrite", Replace: "replace" } as const;
export type PoolEdit = (typeof PoolEdit)[keyof typeof PoolEdit];

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

/** Bin filter value showing every bin. */
const ALL_BINS = "\u0000all";
/** BinMenu choices that are not bin names. */
const NEW_BIN = "\u0000new";
const TOP_BIN = "\u0000top";

/** The video's sounds and pictures, kept in sync with the API. */
export function useMediaPool(projectId: string | undefined, version?: string) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (projectId) api.projectMedia(projectId).then(setItems, () => setItems([]));
    // `version` (the project's updatedAt) changes when an agent imports or removes media.
  }, [projectId, version]);
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
  /** Clean a sound or a clip's sound into a new pool sound, or the voice-over in place (`source` "voice"). */
  const clean = useCallback(
    async (source: string, mode: CleanMode) => {
      if (!projectId) return;
      setBusy(true);
      setError(null);
      try {
        const r = await api.cleanMedia(projectId, { source, mode });
        setItems((xs) => [...xs, "voice" in r ? r.original : r]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );
  /** Read the pool again (after a change made elsewhere, like a bin move). */
  const reload = useCallback(async () => {
    if (projectId) setItems(await api.projectMedia(projectId));
  }, [projectId]);
  return { items, busy, error, upload, remove, clean, reload };
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
  picked,
  onPick,
  onPlace,
}: {
  ed: EditorProps;
  scene: SceneView | null;
  clips: ClipUpload;
  music: MusicUpload;
  pool: MediaPoolState;
  /** Put a tile on the timeline at the playhead. */
  onAdd: (drop: PoolDrop) => void;
  /** The tile picked for the NLE edits (Insert F9, Overwrite F10, Replace F11). */
  picked: PoolDrop | null;
  onPick: (drop: PoolDrop | null) => void;
  onPlace: (mode: PoolEdit) => void;
}) {
  const agent = useAgentName();
  const [filter, setFilter] = useState<PoolFilter>(PoolFilter.All);
  /** Search over names, and the bin shown (ALL_BINS = everything, null = the top level only). */
  const [query, setQuery] = useState("");
  const [bin, setBin] = useState<string | null | typeof ALL_BINS>(ALL_BINS);
  /** Move a tile to a bin (asks a name for a new one) and reload the pool and the clips. */
  const moveToBin = async (id: string, to: string | null) => {
    if (!project) return;
    await api.setBin(project.id, [id], to);
    ed.setProject(await api.project(project.id));
    await pool.reload();
  };
  const [suno, setSuno] = useState(false);
  const project = ed.project;
  const used = new Set((scene?.layers ?? []).map((l) => String(l.src ?? "")));
  const entries: PoolEntry[] = [...(project?.footage ?? []).map((clip): PoolEntry => ({ source: "footage", clip })), ...pool.items.map((item): PoolEntry => ({ source: "media", item }))];
  const binOf = (e: PoolEntry) => (e.source === "footage" ? e.clip.bin : e.item.bin) ?? null;
  const bins = [...new Set(entries.map(binOf).filter((b): b is string => !!b))].sort((a, b) => a.localeCompare(b));
  const needle = query.trim().toLowerCase();
  const shown = entries.filter((e) => {
    if (bin !== ALL_BINS && binOf(e) !== bin) return false;
    if (needle && !(e.source === "footage" ? e.clip.name : e.item.name).toLowerCase().includes(needle)) return false;
    if (filter === PoolFilter.All) return true;
    if (e.source === "footage") return filter === PoolFilter.Video;
    return filter === (e.item.kind === MediaKind.Audio ? PoolFilter.Audio : e.item.kind === MediaKind.Lut ? PoolFilter.Luts : PoolFilter.Images);
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
      <div className="grid grid-cols-5 gap-1 rounded-lg bg-neutral-950 p-1" role="tablist" aria-label="Media filter">
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
      {entries.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search media" className="rounded-md bg-neutral-950 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600" aria-label="Search media" />
          {bins.length > 0 && (
            <div className="flex flex-wrap gap-1 text-[11px]">
              {([[ALL_BINS, "All"], [null, "Top level"], ...bins.map((b) => [b, b])] as [string | null, string][]).map(([key, label]) => (
                <button key={String(key)} type="button" onClick={() => setBin(key)} className={`rounded-md px-1.5 py-0.5 ${bin === key ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-white"}`}>
                  {key && key !== ALL_BINS ? `▸ ${label}` : label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
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
                <Tile
                  key={e.source === "footage" ? `f:${e.clip.id}` : `m:${e.item.id}`}
                  entry={e}
                  used={used}
                  music={music}
                  onAdd={onAdd}
                  picked={!!picked && picked.source === e.source && picked.id === (e.source === "footage" ? e.clip.id : e.item.id)}
                  onPick={onPick}
                  onRemove={e.source === "media" ? () => void pool.remove(e.item.id) : undefined}
                  onClean={(mode) => void pool.clean(e.source === "footage" ? e.clip.url : e.item.url, mode)}
                  bins={bins}
                  onBin={(to) => void moveToBin(e.source === "footage" ? e.clip.id : e.item.id, to)}
                  onProxy={
                    e.source === "footage" && project
                      ? () =>
                          void api.makeProxy(project.id, e.clip.url).then(
                            async () => ed.setProject(await api.project(project.id)),
                            () => undefined,
                          )
                      : undefined
                  }
                />
              ))}
            </ul>
            {!shown.length && <p className="px-1 text-xs text-neutral-500">Nothing of this kind yet.</p>}
            {picked && (
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-neutral-950 p-1 text-[11px]">
                {([[PoolEdit.Insert, "Insert", "F9", "At the playhead (or the I mark); everything after moves later"], [PoolEdit.Overwrite, "Overwrite", "F10", "Covers what is on the track there"], [PoolEdit.Replace, "Replace", "F11", "Swaps the selected clip's media, same length"]] as const).map(([m, label, key, hint]) => (
                  <button key={m} type="button" title={hint} onClick={() => onPlace(m)} className="rounded-md py-1 text-neutral-300 hover:bg-neutral-800 hover:text-white">
                    {label} <span className="text-neutral-600">{key}</span>
                  </button>
                ))}
              </div>
            )}
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
        {desktop && project && <MissingMedia projectId={project.id} version={project.updatedAt} onRelinked={async () => ed.setProject(await api.project(project.id))} />}
        <ProxyToggle />
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
        {project?.audio && (
          <span className="px-1">
            <CleanMenu
              label="Clean the voice-over…"
              onClean={(mode) =>
                void pool.clean("voice", mode).then(async () => {
                  // The voice-over was replaced in place: reload it.
                  ed.setProject(await api.project(project.id));
                })
              }
            />
          </span>
        )}
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

function Tile({ entry, used, music, onAdd, onRemove, onClean, onProxy, bins, onBin, picked, onPick }: { entry: PoolEntry; used: Set<string>; music: MusicUpload; onAdd: (d: PoolDrop) => void; onRemove?: () => void; onClean: (mode: CleanMode) => void; onProxy?: () => void; bins: string[]; onBin: (bin: string | null) => void; picked: boolean; onPick: (d: PoolDrop | null) => void }) {
  const [making, setMaking] = useState(false);
  const drop: PoolDrop = entry.source === "footage" ? { source: "footage", id: entry.clip.id } : { source: "media", id: entry.item.id };
  const url = entry.source === "footage" ? entry.clip.url : entry.item.url;
  const name = entry.source === "footage" ? entry.clip.name : entry.item.name;
  const duration = entry.source === "footage" ? entry.clip.duration : entry.item.duration;
  const isAudio = entry.source === "media" && entry.item.kind === MediaKind.Audio;
  const isLut = entry.source === "media" && entry.item.kind === MediaKind.Lut;
  const inEdit = used.has(url);
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(POOL_DRAG, JSON.stringify(drop));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onDoubleClick={() => onAdd(drop)}
      onClick={() => onPick(picked ? null : drop)}
      title={isLut ? `${name} · double-click to grade the selected clip with it` : `${name} · drag to the timeline or double-click to add at the playhead`}
      className={`group relative flex cursor-grab flex-col gap-1 rounded-lg p-1 active:cursor-grabbing ${picked ? "bg-neutral-800 ring-1 ring-white/40" : "hover:bg-neutral-800/60"}`}
    >
      <span className="relative aspect-video overflow-hidden rounded-md bg-neutral-800">
        {entry.source === "footage" ? (
          <video src={`${mediaUrl(url)}#t=${THUMB_AT}`} preload="metadata" muted playsInline className="pointer-events-none size-full object-cover" />
        ) : isLut ? (
          <span className="flex size-full items-center justify-center bg-gradient-to-br from-orange-500/50 via-neutral-800 to-teal-500/50 text-[11px] font-semibold text-white">LUT</span>
        ) : isAudio ? (
          <span className="flex size-full items-center justify-center bg-gradient-to-br from-emerald-900/60 to-neutral-900 text-emerald-200">
            <Icon d={ICON.note} className="size-6" />
          </span>
        ) : (
          <img src={mediaUrl(url)} alt="" draggable={false} className="pointer-events-none size-full object-cover" />
        )}
        {duration != null && <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">{mmss(duration)}</span>}
        {inEdit && <span className="absolute top-1 left-1 size-2 rounded-full bg-emerald-400 ring-2 ring-black/60" title="In the edit" />}
        {entry.source === "footage" && entry.clip.proxy && (
          <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[9px] font-semibold text-sky-200" title="Plays a light 540p proxy while editing; exports use the original">
            PROXY
          </span>
        )}
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
      {(isAudio || entry.source === "footage") && <CleanMenu onClean={onClean} />}
      <BinMenu bins={bins} current={(entry.source === "footage" ? entry.clip.bin : entry.item.bin) ?? null} onBin={onBin} />
      {onProxy && entry.source === "footage" && !entry.clip.proxy && (
        <button
          type="button"
          disabled={making}
          onClick={(e) => {
            e.stopPropagation();
            setMaking(true);
            onProxy();
          }}
          className="self-start px-0.5 text-[10px] text-neutral-500 hover:text-white disabled:opacity-50"
          title="A light 540p copy to play while editing (exports use the original)"
        >
          {making ? "Making proxy…" : "Make proxy"}
        </button>
      )}
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

/** Clean a sound (a new copy joins the pool; the original stays). */
function CleanMenu({ onClean, label = "Clean sound…" }: { onClean: (mode: CleanMode) => void; label?: string }) {
  return (
    <select
      value=""
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => e.target.value && onClean(e.target.value as CleanMode)}
      className="self-start bg-transparent px-0.5 text-[10px] text-neutral-500 hover:text-white"
      title="Reduce noise or isolate the voice (ffmpeg; a cleaned copy, the original stays)"
    >
      <option value="">{label}</option>
      <option value={CleanMode.Denoise}>Reduce noise</option>
      <option value={CleanMode.Voice}>Isolate voice</option>
    </select>
  );
}

/** Play clips' proxies while editing (per viewer; exports always use the originals). */
function ProxyToggle() {
  const [on, setOn] = useState(() => engineHost.proxiesOn);
  return (
    <label className="flex items-center justify-between gap-2 px-1 text-[11px] text-neutral-500" title="Big clips get a light 540p copy to play while editing; exports always use the originals">
      Preview with proxies
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          engineHost.setUseProxies(e.target.checked);
          setOn(e.target.checked);
        }}
        className="accent-white"
      />
    </label>
  );
}

/**
 * Files the video uses that are gone from the media folder (moved, a project folder opened on another
 * machine): relink them from a folder, matched by name and size.
 */
function MissingMedia({ projectId, version, onRelinked }: { projectId: string; version: string; onRelinked: () => Promise<void> }) {
  const [missing, setMissing] = useState<{ name: string }[]>([]);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void api.missingMedia(projectId).then(setMissing, () => setMissing([]));
  }, [projectId, version]);
  if (!missing.length && !note) return null;
  const relink = async () => {
    const folder = await invoke<string | null>("pick_folder", { title: "Where are the missing files?" });
    if (!folder) return;
    try {
      const r = await api.relinkMedia(projectId, folder);
      setNote(r.relinked.length ? `Relinked ${r.relinked.length}${r.missing.length ? `; still missing: ${r.missing.join(", ")}` : ""}.` : `None of them is in ${folder}.`);
      setMissing(r.missing.map((name) => ({ name })));
      if (r.relinked.length) await onRelinked();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
      {missing.length > 0 && (
        <span className="flex items-center justify-between gap-2">
          <span className="truncate" title={missing.map((m) => m.name).join(", ")}>
            {missing.length} {missing.length === 1 ? "file is" : "files are"} missing
          </span>
          <button type="button" onClick={() => void relink()} className="shrink-0 font-semibold hover:text-white">
            Relink…
          </button>
        </span>
      )}
      {note && <span className="text-amber-100/80">{note}</span>}
    </div>
  );
}

/** "Move to bin…": an existing bin, a new one (named here), or back to the top. */
function BinMenu({ bins, current, onBin }: { bins: string[]; current: string | null; onBin: (bin: string | null) => void }) {
  const [naming, setNaming] = useState(false);
  if (naming)
    return (
      <input
        autoFocus
        placeholder="Bin name, then Enter"
        onClick={(e) => e.stopPropagation()}
        onBlur={() => setNaming(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setNaming(false);
          if (e.key !== "Enter") return;
          const name = e.currentTarget.value.trim();
          setNaming(false);
          if (name) onBin(name);
        }}
        className="w-full rounded bg-neutral-950 px-1 text-[10px] text-neutral-200"
      />
    );
  return (
    <select
      value=""
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const v = e.target.value;
        if (v === NEW_BIN) setNaming(true);
        else if (v === TOP_BIN) onBin(null);
        else if (v) onBin(v);
      }}
      className="self-start bg-transparent px-0.5 text-[10px] text-neutral-500 hover:text-white"
      title="Put it in a folder of the media pool"
    >
      <option value="">{current ? `▸ ${current}` : "Move to bin…"}</option>
      {bins.filter((b) => b !== current).map((b) => (
        <option key={b} value={b}>
          {b}
        </option>
      ))}
      <option value={NEW_BIN}>New bin…</option>
      {current && <option value={TOP_BIN}>Back to the top</option>}
    </select>
  );
}
