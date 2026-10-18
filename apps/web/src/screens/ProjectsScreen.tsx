import { useEffect, useState } from "react";
import type { Brick, PalettePayload, ProjectListItem } from "@motionily/protocol";
import { api } from "../api/client";
import { href, RouteName } from "../router";
import { TopBar } from "./TopBar";
import { Thumb } from "../components/style/Thumb";

export function ProjectsScreen() {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [catalog, setCatalog] = useState<Map<string, Brick>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.projects().then(setProjects, (e: Error) => setError(e.message));
    api.bricks().then((b) => setCatalog(new Map(b.map((x) => [x.key, x]))));
  }, []);

  const remove = async (p: ProjectListItem) => {
    if (!confirm(`¿Borrar "${p.name}"? No se puede deshacer.`)) return;
    await api.deleteProject(p._id);
    setProjects((ps) => ps?.filter((x) => x._id !== p._id) ?? null);
  };

  return (
    <div className="min-h-dvh">
      <TopBar />
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-5 py-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Tus vídeos</h1>
            <p className="mt-1 text-sm text-neutral-400">Elige un estilo, cuéntale al agente de qué va y él lo monta.</p>
          </div>
          <a href={href({ name: RouteName.NewProject })} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
            Nuevo vídeo
          </a>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {projects?.length === 0 && (
          <a href={href({ name: RouteName.NewProject })} className="rounded-xl border border-dashed border-neutral-700 p-10 text-center text-sm text-neutral-400 hover:border-neutral-500 hover:text-neutral-200">
            Aún no tienes vídeos. Crea el primero.
          </a>
        )}
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {projects?.map((p) => (
            <div key={p._id} className="group relative">
              <a
                href={href({ name: RouteName.Editor, id: p._id })}
                className="flex flex-col gap-3 rounded-xl p-2 hover:bg-neutral-900"
              >
                {catalog.get(p.build.palette) ? (
                  <Thumb palette={catalog.get(p.build.palette)!.payload as PalettePayload} className="aspect-video w-full" />
                ) : (
                  <span className="block aspect-video w-full rounded-md bg-neutral-900" />
                )}
                <span className="px-1 font-semibold">{p.name}</span>
                <span className="-mt-2 px-1 text-xs text-neutral-400">
                  {catalog.get(p.build.motion_style)?.name ?? "…"} · {new Date(p.updatedAt).toLocaleDateString("es-ES")}
                </span>
              </a>
              <button
                type="button"
                onClick={() => void remove(p)}
                className="absolute top-4 right-4 rounded-md bg-black/60 px-2 py-1 text-xs text-neutral-500 opacity-0 group-hover:opacity-100 hover:text-red-400"
              >
                Borrar
              </button>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
