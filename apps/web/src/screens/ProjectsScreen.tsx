import { useEffect, useState } from "react";
import { api, type BrandSummary } from "../api/client";
import { href, BrandTab, navigate, RouteName } from "../router";
import { PageHeader } from "../shell/AppShell";

/** The user's projects: one per brand/product, each with its kit and its videos. */
export function ProjectsScreen() {
  const [brands, setBrands] = useState<BrandSummary[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.brands().then(setBrands, (e: Error) => setError(e.message));
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    const b = await api.createBrand(name.trim());
    navigate({ name: RouteName.Brand, id: b.id, tab: BrandTab.Kit });
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-8 py-10">
      <PageHeader
        title="Proyectos"
        subtitle="Un proyecto por marca o producto: su kit (logos, capturas, paletas) y sus vídeos."
        action={
          !creating && (
            <button type="button" onClick={() => setCreating(true)} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
              Nuevo proyecto
            </button>
          )
        }
      />
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
            placeholder="Nombre de la marca o producto"
            className="flex-1 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
          />
          <button type="submit" className="rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
            Crear
          </button>
          <button type="button" onClick={() => setCreating(false)} className="rounded-lg px-3 text-sm text-neutral-400 hover:text-white">
            Cancelar
          </button>
        </form>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {brands?.map((b) => {
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
                {b.videos} {b.videos === 1 ? "vídeo" : "vídeos"}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
