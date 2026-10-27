import { BrandTab, href, RouteName } from "../router";
import type { Project } from "@motionily/protocol";
import { FavoriteStar } from "../components/FavoriteStar";
import { SaveSeries } from "../series/SaveSeries";

/** Back to the brand's videos, and the video's name (edit in place). */
export function ProjectTitle({ project, onRename, className = "" }: { project: Project | null; onRename: (name: string) => void; className?: string }) {
  return (
    <>
      {project?.brandId && (
        <a href={href({ name: RouteName.Brand, id: project.brandId, tab: BrandTab.Videos })} className="shrink-0 text-xs text-neutral-500 hover:text-white">
          ← Project
        </a>
      )}
      {project && (
        <input
          key={project.name}
          defaultValue={project.name}
          onBlur={(e) => e.target.value.trim() && e.target.value !== project.name && onRename(e.target.value.trim())}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className={`min-w-0 bg-transparent focus:outline-none ${className}`}
          aria-label="Video name"
        />
      )}
      {project && <FavoriteStar key={project.id} projectId={project.id} initial={project.favorite} />}
      {project && <SaveSeries key={`series-${project.id}`} project={project} />}
    </>
  );
}
