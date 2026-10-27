import { useEffect, useState } from "react";
import type { Brick, ProjectListItem } from "@motionily/protocol";
import { api, type BrandSummary } from "../api/client";
import { href, BrandTab, navigate, RouteName } from "../router";
import { MotionilyLayout } from "../shell/MotionilyLayout";
import { StartVideo } from "../components/StartVideo";
import { CoverImage, VideoCard } from "../components/VideoCard";
import { PostedInbox } from "../social/Published";

/** Videos shown under "Recent videos" (the rest live in their project). */
const RECENT_VIDEOS = 8;

/**
 * Home: start a video straight in an editor (or the guided flow), pick up a recent one, or open a
 * project (one per brand/product, each with its kit and its videos).
 */
export function ProjectsScreen() {
  const [brands, setBrands] = useState<BrandSummary[] | null>(null);
  const [videos, setVideos] = useState<ProjectListItem[]>([]);
  const [catalog, setCatalog] = useState<Map<string, Brick>>(new Map());
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.brands().then(setBrands, (e: Error) => setError(e.message));
    api.projects().then(setVideos, () => undefined);
    api.bricks().then((b) => setCatalog(new Map(b.map((x) => [x.key, x]))), () => undefined);
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    const b = await api.createBrand(name.trim());
    navigate({ name: RouteName.Brand, id: b.id, tab: BrandTab.Kit });
  };

  return (
    <MotionilyLayout
      title="Projects"
      description="One project per brand or product: its kit (logos, screenshots, palettes) and its videos."
      actions={
        !creating && (
          <button type="button" onClick={() => setCreating(true)} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
            New project
          </button>
        )
      }
    >
      {creating && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Brand or product name"
            className="flex-1 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
          />
          <button type="submit" className="rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
            Create
          </button>
          <button type="button" onClick={() => setCreating(false)} className="rounded-lg px-3 text-sm text-neutral-400 hover:text-white">
            Cancel
          </button>
        </form>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {brands && <StartVideo brands={brands} />}
      {videos.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Recent videos</h2>
          <div className="-mx-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {videos.slice(0, RECENT_VIDEOS).map((v) => (
              <VideoCard key={v._id} video={v} catalog={catalog} />
            ))}
          </div>
        </section>
      )}
      <PostedInbox videos={videos} />
      {brands && brands.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">All projects</h2>
          <div className="-mx-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {brands.map((b) => (
              <ProjectCard key={b.id} brand={b} />
            ))}
          </div>
        </section>
      )}
    </MotionilyLayout>
  );
}

/** A project: its latest videos' stills side by side (its palette until it has some), name, count and palette. */
function ProjectCard({ brand: b }: { brand: BrandSummary }) {
  const p = b.palettes[0];
  const colors = p ? [p.background, p.primary, p.accent, p.text] : [];
  const covers = b.covers ?? [];
  return (
    <a href={href({ name: RouteName.Brand, id: b.id, tab: BrandTab.Videos })} className="group flex flex-col gap-2.5 rounded-2xl p-2 transition-colors hover:bg-neutral-900">
      <span className="flex aspect-[4/3] w-full gap-1 overflow-hidden rounded-xl ring-1 ring-white/[0.06] transition group-hover:ring-white/15" style={{ background: p?.background ?? "#141414" }}>
        {covers.length ? (
          covers.map((c) => (
            <span key={c.url} className="h-full min-w-0 flex-1">
              <CoverImage cover={c.url} />
            </span>
          ))
        ) : (
          <span className="flex h-full w-full items-end gap-1.5 p-4">
            {(p ? [p.primary, p.accent, p.text] : ["#3f3f46", "#52525b", "#71717a"]).map((c, i) => (
              <span key={i} className="w-4 rounded" style={{ background: c, height: `${70 - i * 18}%` }} />
            ))}
          </span>
        )}
      </span>
      <span className="flex items-center gap-2 px-1">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{b.name}</span>
          <span className="text-xs text-neutral-500">
            {b.videos} {b.videos === 1 ? "video" : "videos"}
          </span>
        </span>
        {colors.length > 0 && (
          <span className="flex shrink-0 -space-x-1">
            {colors.map((c, i) => (
              <span key={i} className="size-3.5 rounded-full ring-2 ring-neutral-950" style={{ background: c }} />
            ))}
          </span>
        )}
      </span>
    </a>
  );
}
