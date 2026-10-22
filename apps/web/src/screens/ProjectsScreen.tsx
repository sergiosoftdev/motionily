import { useEffect, useState } from "react";
import type { Brick, ProjectListItem } from "@motionily/protocol";
import { api, type BrandSummary } from "../api/client";
import { href, BrandTab, navigate, RouteName } from "../router";
import { MotionilyLayout } from "../shell/MotionilyLayout";
import { StartVideo } from "../components/StartVideo";
import { VideoCard } from "../components/VideoCard";

/** Videos shown under "Recent videos" (the rest live in their project). */
const RECENT_VIDEOS = 6;

/**
 * Home: start a video straight in an editor (or the guided flow), pick up a recent one, or open a
 * project (one per brand/product, each with its kit and its videos).
 */
export function ProjectsScreen() {
  const [brands, setBrands] = useState<BrandSummary[] | null>(null);
  const [recent, setRecent] = useState<ProjectListItem[]>([]);
  const [catalog, setCatalog] = useState<Map<string, Brick>>(new Map());
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.brands().then(setBrands, (e: Error) => setError(e.message));
    api.projects().then((v) => setRecent(v.slice(0, RECENT_VIDEOS)), () => undefined);
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
      {brands && brands.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">All projects</h2>
          <div className="-mx-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {brands.map((b) => {
              const p = b.palettes[0];
              return (
                <a key={b.id} href={href({ name: RouteName.Brand, id: b.id, tab: BrandTab.Videos })} className="flex flex-col gap-3 rounded-xl p-3 hover:bg-neutral-900">
                  <span className="flex h-24 items-end gap-1.5 rounded-lg p-3" style={{ background: p?.background ?? "#1a1a1a" }}>
                    {(p ? [p.primary, p.accent, p.text] : ["#3f3f46", "#52525b", "#71717a"]).map((c, i) => (
                      <span key={i} className="h-full w-4 rounded" style={{ background: c, height: `${100 - i * 25}%` }} />
                    ))}
                  </span>
                  <span className="px-1 font-semibold">{b.name}</span>
                  <span className="-mt-2 px-1 text-xs text-neutral-400">
                    {b.videos} {b.videos === 1 ? "video" : "videos"}
                  </span>
                </a>
              );
            })}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Recent videos</h2>
          <div className="-mx-2 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {recent.map((v) => (
              <VideoCard key={v._id} video={v} catalog={catalog} />
            ))}
          </div>
        </section>
      )}
    </MotionilyLayout>
  );
}
