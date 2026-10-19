import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { api, mediaUrl } from "../api/client";

/** Reference images per prompt (the API caps it too). */
export const MAX_REFERENCES = 8;
const ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * Reference images for a prompt: paste (⌘V), drop or pick files. They upload right away and
 * travel with the request as media paths, so Claude can look at what the user means.
 */
export function useReferences(initial: string[] = [], onChange?: (refs: string[]) => void) {
  const [refs, setRefs] = useState<string[]>(initial);
  /** Local previews (blob URLs) shown while their upload runs. */
  const [pending, setPending] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  // Report changes (not the initial value) to whoever persists them.
  const first = useRef(true);
  const report = useRef(onChange);
  report.current = onChange;
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    report.current?.(refs);
  }, [refs]);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: File[]) => {
    const images = files.filter((f) => ACCEPT.includes(f.type)).slice(0, MAX_REFERENCES - refs.length);
    if (!images.length) return;
    setError(null);
    setUploading((n) => n + images.length);
    await Promise.all(
      images.map((f) => {
        const local = URL.createObjectURL(f);
        setPending((p) => [...p, local]);
        return api
          .uploadReference(f)
          .then(({ url }) => setRefs((r) => (r.length < MAX_REFERENCES ? [...r, url] : r)))
          .catch((e: Error) => setError(e.message))
          .finally(() => {
            setUploading((n) => n - 1);
            setPending((p) => p.filter((x) => x !== local));
            URL.revokeObjectURL(local);
          });
      }),
    );
  };

  return {
    refs,
    pending,
    uploading: uploading > 0,
    error,
    add,
    remove: (url: string) => setRefs((r) => r.filter((x) => x !== url)),
    clear: () => setRefs([]),
    /** Spread on a textarea/input/zone: paste and drop images. */
    handlers: {
      onPaste: (e: ClipboardEvent) => {
        // Screenshots often arrive only as clipboard items, not in .files.
        const fromItems = Array.from(e.clipboardData.items)
          .filter((i) => i.kind === "file")
          .map((i) => i.getAsFile())
          .filter((f): f is File => !!f);
        const files = fromItems.length ? fromItems : Array.from(e.clipboardData.files);
        if (files.some((f) => ACCEPT.includes(f.type))) {
          e.preventDefault();
          void add(files);
        }
      },
      onDragOver: (e: DragEvent) => e.dataTransfer.types.includes("Files") && e.preventDefault(),
      onDrop: (e: DragEvent) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void add(Array.from(e.dataTransfer.files));
      },
    },
  };
}

export type References = ReturnType<typeof useReferences>;

/** Thumbnails of the attached references plus an "attach" button. */
export function ReferenceStrip({ r, compact = false }: { r: References; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const size = compact ? "size-8" : "size-16";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {r.refs.map((url) => (
        <span key={url} className={`group relative ${size} shrink-0 overflow-hidden rounded-md ring-1 ring-white/15`}>
          <button type="button" onClick={() => setZoom(mediaUrl(url))} aria-label="Ver referencia" className="size-full cursor-zoom-in">
            <img src={mediaUrl(url)} alt="Referencia" className="size-full object-cover" />
          </button>
          <button
            type="button"
            onClick={() => r.remove(url)}
            aria-label="Quitar referencia"
            className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-black/80 text-[9px] text-white opacity-0 transition group-hover:opacity-100"
          >
            ✕
          </button>
        </span>
      ))}
      {r.pending.map((src) => (
        <span key={src} className={`relative ${size} shrink-0 overflow-hidden rounded-md ring-1 ring-white/15`}>
          <img src={src} alt="Subiendo referencia" className="size-full animate-pulse object-cover opacity-60" />
        </span>
      ))}
      {r.refs.length < MAX_REFERENCES && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          title="Adjunta o pega (⌘V) imágenes de referencia"
          className={`flex shrink-0 items-center justify-center gap-1.5 rounded-md text-neutral-400 ring-1 ring-white/10 transition hover:text-white hover:ring-white/30 ${
            compact ? "size-8 text-sm" : "h-14 px-3 text-xs"
          }`}
        >
          {compact ? "＋" : "＋ Imagen de referencia"}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept={ACCEPT.join(",")}
        multiple
        className="hidden"
        onChange={(e) => {
          void r.add(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {r.error && <span className="text-xs text-red-400">{r.error}</span>}
      {zoom && (
        <div className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-10" onClick={() => setZoom(null)}>
          <img src={zoom} alt="Referencia" className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
}
