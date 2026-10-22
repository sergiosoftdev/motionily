import type { Brick, PalettePayload, ProjectListItem } from "@motionily/protocol";
import { href, RouteName } from "../router";
import { Thumb } from "./style/Thumb";

/** A video in a grid: its palette as a thumbnail, its name and date; opens the editor. */
export function VideoCard({ video, catalog, onDelete }: { video: ProjectListItem; catalog: Map<string, Brick>; onDelete?: () => void }) {
  const palette = catalog.get(video.build.palette)?.payload as PalettePayload | undefined;
  return (
    <div className="group relative">
      <a href={href({ name: RouteName.Editor, id: video._id })} className="flex flex-col gap-3 rounded-xl p-2 hover:bg-neutral-900">
        {palette ? <Thumb palette={palette} className="aspect-video w-full" /> : <span className="block aspect-video w-full rounded-md bg-neutral-900" />}
        <span className="flex items-center gap-2 px-1 font-semibold">
          <span className="truncate">{video.name}</span>
          {video.generating && (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" /> Generating…
            </span>
          )}
        </span>
        <span className="-mt-2 px-1 text-xs text-neutral-400">{new Date(video.updatedAt).toLocaleDateString("en-US")}</span>
      </a>
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
