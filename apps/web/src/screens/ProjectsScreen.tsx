import { useEffect, useState } from "react";
import type { Brick, ProjectListItem } from "@motionily/protocol";
import { BrickSlot } from "@motionily/protocol";
import { api } from "../api/client";
import { href, RouteName } from "../router";
import { TopBar } from "./TopBar";
import { Studs } from "../components/lego/Studs";
import { slotMeta } from "../components/lego/slots";

export function ProjectsScreen() {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [styles, setStyles] = useState<Map<string, Brick>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.projects().then(setProjects, (e: Error) => setError(e.message));
    api.bricks({ slot: BrickSlot.MotionStyle }).then((b) => setStyles(new Map(b.map((x) => [x.key, x]))));
  }, []);

  const remove = async (p: ProjectListItem) => {
    if (!confirm(`¿Borrar "${p.name}"? No se puede deshacer.`)) return;
    await api.deleteProject(p._id);
    setProjects((ps) => ps?.filter((x) => x._id !== p._id) ?? null);
  };

  const kitColor = slotMeta(BrickSlot.MotionStyle).color;

  return (
    <div className="min-h-dvh">
      <TopBar />
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-5 py-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Tus proyectos</h1>
            <p className="mt-1 text-sm text-neutral-400">Cada vídeo es un montaje de piezas.</p>
          </div>
          <a href={href({ name: RouteName.NewProject })} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
            Nuevo proyecto
          </a>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {projects?.length === 0 && (
          <a href={href({ name: RouteName.NewProject })} className="rounded-xl border border-dashed border-neutral-700 p-10 text-center text-sm text-neutral-400 hover:border-neutral-500 hover:text-neutral-200">
            Aún no tienes proyectos. Abre tu primera caja de piezas.
          </a>
        )}
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {projects?.map((p) => (
            <div key={p._id} className="group relative">
              <a
                href={href({ name: RouteName.Editor, id: p._id })}
                className="relative mt-[5px] flex flex-col gap-1 rounded-xl bg-neutral-900 px-4 pt-5 pb-4 hover:bg-neutral-800"
              >
                <Studs count={4} color={kitColor} />
                <span className="font-semibold">{p.name}</span>
                <span className="text-xs text-neutral-400">
                  {styles.get(p.build.motion_style)?.name ?? "…"} · {new Date(p.updatedAt).toLocaleDateString("es-ES")}
                </span>
              </a>
              <button
                type="button"
                onClick={() => void remove(p)}
                className="absolute top-4 right-3 text-xs text-neutral-500 opacity-0 group-hover:opacity-100 hover:text-red-400"
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
