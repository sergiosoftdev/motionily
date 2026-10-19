import { useEffect, useRef, useState } from "react";
import type { Brick, PalettePayload, ProjectListItem } from "@motionily/protocol";
import { api, AssetKind, mediaUrl, type BrandKit, type BrandPalette } from "../api/client";
import { BrandTab, href, navigate, RouteName } from "../router";
import { PageHeader } from "../shell/AppShell";
import { Thumb } from "../components/style/Thumb";

const KIND_LABEL: Record<AssetKind, string> = {
  [AssetKind.Logo]: "Logo",
  [AssetKind.Screenshot]: "Captura",
  [AssetKind.Photo]: "Foto",
  [AssetKind.Other]: "Otro",
};

const EMPTY_PALETTE: BrandPalette = { name: "Paleta", background: "#ffffff", surface: "#f4f4f5", primary: "#16a34a", accent: "#f59e0b", text: "#111827" };
const PALETTE_SLOTS = ["background", "surface", "primary", "accent", "text"] as const;
const SLOT_LABEL: Record<(typeof PALETTE_SLOTS)[number], string> = { background: "Fondo", surface: "Superficie", primary: "Principal", accent: "Acento", text: "Texto" };

export function BrandScreen({ id, tab }: { id: string; tab: BrandTab }) {
  const [kit, setKit] = useState<BrandKit | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.brand(id).then(setKit, (e: Error) => setError(e.message));
  }, [id]);

  if (error) return <p className="p-10 text-sm text-red-400">{error}</p>;
  if (!kit) return null;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-10">
      <PageHeader
        title={
          <input
            key={kit.name}
            defaultValue={kit.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== kit.name && void api.updateBrand(id, { name: e.target.value.trim() }).then(setKit)}
            className="w-full rounded-md bg-transparent focus:bg-neutral-900 focus:outline-none"
            aria-label="Nombre del proyecto"
          />
        }
        action={
          tab === BrandTab.Videos && (
            <a href={href({ name: RouteName.NewVideo, brandId: id })} className="shrink-0 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
              Nuevo vídeo
            </a>
          )
        }
      />
      <div className="flex gap-1">
        {[
          [BrandTab.Videos, "Vídeos"],
          [BrandTab.Kit, "Kit de marca"],
        ].map(([t, label]) => (
          <a
            key={t}
            href={href({ name: RouteName.Brand, id, tab: t as BrandTab })}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === t ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"}`}
          >
            {label}
          </a>
        ))}
      </div>
      {tab === BrandTab.Videos ? <Videos brandId={id} /> : <Kit kit={kit} onKit={setKit} />}
    </div>
  );
}

function Videos({ brandId }: { brandId: string }) {
  const [videos, setVideos] = useState<ProjectListItem[] | null>(null);
  const [catalog, setCatalog] = useState<Map<string, Brick>>(new Map());

  useEffect(() => {
    api.brandVideos(brandId).then(setVideos);
    api.bricks().then((b) => setCatalog(new Map(b.map((x) => [x.key, x]))));
  }, [brandId]);

  const remove = async (v: ProjectListItem) => {
    if (!confirm(`¿Borrar "${v.name}"? No se puede deshacer.`)) return;
    await api.deleteProject(v._id);
    setVideos((vs) => vs?.filter((x) => x._id !== v._id) ?? null);
  };

  if (videos?.length === 0) {
    return (
      <a href={href({ name: RouteName.NewVideo, brandId })} className="rounded-xl border border-dashed border-neutral-700 p-10 text-center text-sm text-neutral-400 hover:border-neutral-500 hover:text-neutral-200">
        Aún no hay vídeos en este proyecto. Crea el primero.
      </a>
    );
  }
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {videos?.map((v) => {
        const palette = catalog.get(v.build.palette)?.payload as PalettePayload | undefined;
        return (
          <div key={v._id} className="group relative">
            <a href={href({ name: RouteName.Editor, id: v._id })} className="flex flex-col gap-3 rounded-xl p-2 hover:bg-neutral-900">
              {palette ? <Thumb palette={palette} className="aspect-video w-full" /> : <span className="block aspect-video w-full rounded-md bg-neutral-900" />}
              <span className="px-1 font-semibold">{v.name}</span>
              <span className="-mt-2 px-1 text-xs text-neutral-400">
                {new Date(v.updatedAt).toLocaleDateString("es-ES")}
              </span>
            </a>
            <button
              type="button"
              onClick={() => void remove(v)}
              className="absolute top-4 right-4 rounded-md bg-black/60 px-2 py-1 text-xs text-neutral-300 opacity-0 group-hover:opacity-100 hover:text-red-400"
            >
              Borrar
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Brand kit: what the agent knows about the product when it designs. */
function Kit({ kit, onKit }: { kit: BrandKit; onKit: (k: BrandKit) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<AssetKind>(AssetKind.Screenshot);
  const [uploading, setUploading] = useState(false);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      let last = kit;
      for (const f of Array.from(files)) last = await api.uploadAsset(kit.id, f, kind);
      onKit(last);
    } finally {
      setUploading(false);
    }
  };

  const savePalettes = (palettes: BrandPalette[]) => void api.updateBrand(kit.id, { palettes }).then(onKit);

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Sobre el producto</h2>
        <p className="text-xs text-neutral-500">Qué hace, para quién, tono de marca, qué destacar. El agente lo lee antes de cada vídeo.</p>
        <textarea
          key={kit.id}
          defaultValue={kit.notes}
          onBlur={(e) => e.target.value !== kit.notes && void api.updateBrand(kit.id, { notes: e.target.value }).then(onKit)}
          rows={5}
          placeholder="Ej.: Clinily es un software para fisios: agenda, fichas, cobros… Tono cercano y profesional."
          className="resize-y rounded-lg bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-sm font-semibold">Paletas de la marca</h2>
            <p className="text-xs text-neutral-500">Aparecen primero en "Colores" de cada vídeo del proyecto.</p>
          </div>
          <button type="button" onClick={() => savePalettes([...kit.palettes, EMPTY_PALETTE])} className="text-xs text-neutral-400 hover:text-white">
            Añadir paleta
          </button>
        </div>
        {kit.palettes.map((p, i) => (
          <div key={i} className="flex flex-wrap items-center gap-3">
            <input
              defaultValue={p.name}
              onBlur={(e) => savePalettes(kit.palettes.map((x, j) => (j === i ? { ...x, name: e.target.value || x.name } : x)))}
              className="w-36 rounded-md bg-neutral-900 px-2 py-1.5 text-sm focus:outline-none"
              aria-label="Nombre de la paleta"
            />
            {PALETTE_SLOTS.map((slot) => (
              <label key={slot} className="flex items-center gap-1.5 text-xs text-neutral-400">
                <input
                  type="color"
                  defaultValue={p[slot]}
                  onBlur={(e) => savePalettes(kit.palettes.map((x, j) => (j === i ? { ...x, [slot]: e.target.value } : x)))}
                  className="size-7 cursor-pointer rounded border-0 bg-transparent"
                />
                {SLOT_LABEL[slot]}
              </label>
            ))}
            <button type="button" onClick={() => savePalettes(kit.palettes.filter((_, j) => j !== i))} className="text-xs text-neutral-500 hover:text-red-400">
              Quitar
            </button>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Logos, capturas y fotos</h2>
            <p className="text-xs text-neutral-500">Describe cada imagen (qué es, cómo funciona) y el agente podrá explicarla y usarla en los vídeos.</p>
          </div>
          <div className="flex items-center gap-2">
            <select value={kind} onChange={(e) => setKind(e.target.value as AssetKind)} className="rounded-md bg-neutral-900 px-2 py-1.5 text-xs focus:outline-none" aria-label="Tipo">
              {Object.values(AssetKind).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
            <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()} className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-semibold hover:bg-neutral-700 disabled:opacity-50">
              {uploading ? "Subiendo…" : "Subir imágenes"}
            </button>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kit.assets.map((a) => (
            <div key={a.id} className="flex flex-col gap-2">
              <img src={mediaUrl(a.url)} alt={a.name} className="aspect-video w-full rounded-lg bg-neutral-900 object-contain" />
              <div className="flex items-center gap-2">
                <input
                  defaultValue={a.name}
                  onBlur={(e) => e.target.value !== a.name && void api.updateAsset(kit.id, a.id, { name: e.target.value }).then(onKit)}
                  className="min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm font-medium focus:bg-neutral-900 focus:outline-none"
                  aria-label="Nombre"
                />
                <span className="text-[11px] text-neutral-500">{KIND_LABEL[a.kind]}</span>
                <button type="button" onClick={() => void api.deleteAsset(kit.id, a.id).then(onKit)} className="text-[11px] text-neutral-500 hover:text-red-400">
                  Quitar
                </button>
              </div>
              <textarea
                defaultValue={a.description}
                onBlur={(e) => e.target.value !== a.description && void api.updateAsset(kit.id, a.id, { description: e.target.value }).then(onKit)}
                rows={3}
                placeholder="Qué muestra y cómo funciona…"
                className="resize-y rounded-lg bg-neutral-900 px-3 py-2 text-xs placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
              />
            </div>
          ))}
        </div>
      </section>

      <button
        type="button"
        onClick={async () => {
          if (!confirm(`¿Borrar el proyecto "${kit.name}"? Debe estar vacío de vídeos.`)) return;
          await api.deleteBrand(kit.id).then(() => navigate({ name: RouteName.Projects }), (e: Error) => alert(e.message));
        }}
        className="self-start text-xs text-neutral-500 hover:text-red-400"
      >
        Borrar proyecto
      </button>
    </div>
  );
}
