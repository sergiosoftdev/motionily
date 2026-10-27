import type { Brick, PalettePayload, ProjectListItem } from "@motionily/protocol";
import { mediaUrl } from "../api/client";
import { href, RouteName } from "../router";
import { Thumb } from "./style/Thumb";
import { FavoriteStar } from "./FavoriteStar";
import { FORMAT_OPTIONS } from "./FormatPicker";

const MINUTE = 60_000;

/** "just now", "12 min ago", "3 h ago", "yesterday", else the date. */
export function edited(iso: string): string {
  const ago = Date.now() - new Date(iso).getTime();
  if (ago < MINUTE) return "just now";
  if (ago < 60 * MINUTE) return `${Math.round(ago / MINUTE)} min ago`;
  if (ago < 24 * 60 * MINUTE) return `${Math.round(ago / (60 * MINUTE))} h ago`;
  if (ago < 48 * 60 * MINUTE) return "yesterday";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * A still of the video (the editor keeps one) shown whole on a blurred copy of itself, so vertical and
 * wide videos sit in the same grid; before the first still, its palette.
 */
export function CoverImage({ cover, palette, className = "" }: { cover?: string | null; palette?: PalettePayload; className?: string }) {
  if (!cover) return palette ? <Thumb palette={palette} className={`h-full w-full ${className}`} /> : <span className={`block h-full w-full bg-neutral-900 ${className}`} />;
  const src = mediaUrl(cover);
  return (
    <span className={`relative block h-full w-full overflow-hidden bg-neutral-950 ${className}`}>
      <img src={src} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-125 object-cover opacity-40 blur-2xl" />
      <img src={src} alt="" loading="lazy" className="relative h-full w-full object-contain" />
    </span>
  );
}

/** A video in a grid: its still, name, format and when it was last edited; opens the editor. */
export function VideoCard({ video, catalog, onDelete }: { video: ProjectListItem; catalog: Map<string, Brick>; onDelete?: () => void }) {
  const palette = catalog.get(video.build.palette)?.payload as PalettePayload | undefined;
  const format = FORMAT_OPTIONS.find((o) => o.format === video.format);
  return (
    <div className="group relative">
      <a href={href({ name: RouteName.Editor, id: video._id })} className="flex flex-col gap-2.5 rounded-2xl p-2 transition-colors hover:bg-neutral-900">
        <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-xl ring-1 ring-white/[0.06] transition group-hover:ring-white/15">
          <CoverImage cover={video.cover} palette={palette} />
          {format && <span className="absolute bottom-2 left-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-neutral-200 backdrop-blur">{format.label}</span>}
          {video.generating && (
            <span className="absolute right-2 bottom-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-medium text-emerald-300 backdrop-blur">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" /> Generating…
            </span>
          )}
        </span>
        <span className="flex flex-col gap-0.5 px-1">
          <span className="truncate text-sm font-semibold">{video.name}</span>
          <span className="text-xs text-neutral-500">Edited {edited(video.updatedAt)}</span>
        </span>
      </a>
      <FavoriteStar projectId={video._id} initial={!!video.favorite} revealOnHover className="absolute top-4 left-4 bg-black/60" />
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="absolute top-4 right-4 rounded-md bg-black/60 px-2 py-1 text-xs text-neutral-300 opacity-0 group-hover:opacity-100 hover:text-red-400"
        >
          Delete
        </button>
      )}
    </div>
  );
}
