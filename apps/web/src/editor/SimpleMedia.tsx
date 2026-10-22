import { useEffect, useRef, useState } from "react";
import { api, mediaUrl } from "../api/client";
import { MAX_REFERENCES } from "../components/References";
import type { EditorProps } from "./context";
import { captioningLabel } from "./AgentLine";
import { useEditActions } from "./edit/useEditActions";
import { CLIP_ACCEPT, SONG_ACCEPT, useClipUpload, useMusicUpload } from "./edit/MediaPanel";

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const ACCEPT = [IMAGE_ACCEPT, CLIP_ACCEPT, SONG_ACCEPT].join(",");
/** Frame shown as a clip's thumbnail (s). */
const THUMB_AT = 0.5;

const isImage = (f: File) => f.type.startsWith("image/");
const isVideo = (f: File) => f.type.startsWith("video/");
const isAudio = (f: File) => f.type.startsWith("audio/");
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");

/**
 * Simple mode's media: photos and logos (Claude looks at them and can use them), clips (transcribed,
 * for Claude to cut and place) and a song under the video. One "Add" button, or drop files anywhere
 * on the editor; then ask Claude where to use them.
 */
export function SimpleMedia({ ed }: { ed: EditorProps }) {
  const project = ed.project!;
  const footage = project.footage;
  const edits = useEditActions(footage);
  const clips = useClipUpload(ed, null);
  const music = useMusicUpload(ed, edits);
  const input = useRef<HTMLInputElement>(null);
  /** Local previews of images being uploaded. */
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The latest project, for uploads that finish after it changed. */
  const latest = useRef(project);
  latest.current = project;

  const addImages = async (files: File[]) => {
    const room = MAX_REFERENCES - latest.current.references.length;
    const images = files.slice(0, Math.max(0, room));
    if (!images.length) return setError(files.length ? `Up to ${MAX_REFERENCES} images per video` : null);
    const previews = images.map((f) => URL.createObjectURL(f));
    setPending((p) => [...p, ...previews]);
    setError(null);
    try {
      const urls: string[] = [];
      // One after another, then one save: two saves racing would drop an image.
      for (const f of images) {
        const { url, urls: many } = await api.uploadReference(f);
        urls.push(...(many ?? [url]));
      }
      ed.saveReferences([...latest.current.references, ...urls].slice(0, MAX_REFERENCES));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending((p) => p.filter((x) => !previews.includes(x)));
      previews.forEach((u) => URL.revokeObjectURL(u));
    }
  };

  const add = (files: File[]) => {
    const images = files.filter(isImage);
    const videos = files.filter(isVideo);
    const song = files.find(isAudio);
    if (images.length) void addImages(images);
    if (videos.length) void clips.upload(videos);
    if (song) void music.upload(song);
  };
  const addRef = useRef(add);
  addRef.current = add;

  // Files dropped anywhere on the editor land here; drops a box handles itself (the ask box's
  // per-request references) never come twice.
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      addRef.current([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const empty = !project.references.length && !pending.length && !footage.length && !project.music;
  const busy = clips.progress ? captioningLabel(clips.progress) : music.busy ? "Uploading the song…" : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 overflow-x-auto py-0.5">
        {project.references.map((url) => (
          <span key={url} className="group relative size-11 shrink-0 overflow-hidden rounded-lg bg-neutral-900 ring-1 ring-white/10">
            <img src={mediaUrl(url)} alt="" className="size-full object-cover" />
            <button
              type="button"
              onClick={() => ed.saveReferences(project.references.filter((x) => x !== url))}
              aria-label="Remove this image"
              className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-black/80 text-[9px] text-white opacity-0 group-hover:opacity-100"
            >
              ✕
            </button>
          </span>
        ))}
        {pending.map((src) => (
          <img key={src} src={src} alt="" className="size-11 shrink-0 animate-pulse rounded-lg object-cover opacity-60" />
        ))}
        {footage.map((c) => (
          <span key={c.id} title={`${c.name}${c.words ? "" : " · not transcribed yet"}`} className="relative h-11 w-16 shrink-0 overflow-hidden rounded-lg bg-neutral-900 ring-1 ring-white/10">
            <video src={`${mediaUrl(c.url)}#t=${THUMB_AT}`} preload="metadata" muted playsInline className="size-full object-cover" />
            <span className="absolute bottom-0.5 left-1 text-[9px] font-semibold text-white drop-shadow">{c.id}</span>
          </span>
        ))}
        {project.music && (
          <span title={project.music.name} className="flex h-11 max-w-40 shrink-0 items-center gap-2 rounded-lg bg-neutral-900 px-3 text-xs text-neutral-300 ring-1 ring-white/10">
            ♪ <span className="truncate">{project.music.name}</span>
          </span>
        )}
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-neutral-300 ring-1 ring-white/10 hover:text-white hover:ring-white/30"
        >
          ＋ Add media
        </button>
        {empty && <span className="shrink-0 pl-1 text-xs text-neutral-500">Photos, logos, clips or a song for Claude to use · or drop them anywhere</span>}
        {busy && <span className="shrink-0 pl-1 text-xs text-neutral-400">{busy}</span>}
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      {(error || clips.error || music.error) && <p className="text-xs text-red-400">{error ?? clips.error ?? music.error}</p>}
      {dragging && (
        <div className="pointer-events-none fixed inset-2 z-40 flex items-center justify-center rounded-3xl border-2 border-dashed border-white/60 bg-black/50">
          <p className="rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-semibold">Drop to add · photos, clips or a song</p>
        </div>
      )}
    </div>
  );
}
