import { useEffect, useRef, useState } from "react";
import type { Brick, PalettePayload, ProjectListItem } from "@motionily/protocol";
import { api, AssetKind, mediaUrl, type BrandKit, type BrandPalette } from "../api/client";
import { BrandTab, href, navigate, RouteName } from "../router";
import { MotionilyLayout } from "../shell/MotionilyLayout";
import { Thumb } from "../components/style/Thumb";

/** Images and the clip formats video layers decode (mp4, webm, mov). */
const ASSET_ACCEPT = "image/*,video/mp4,video/webm,video/quicktime";

const KIND_LABEL: Record<AssetKind, string> = {
  [AssetKind.Logo]: "Logo",
  [AssetKind.Screenshot]: "Screenshot",
  [AssetKind.Photo]: "Photo",
  [AssetKind.Video]: "Video",
  [AssetKind.Other]: "Otro",
};

const TAB_LABEL: Record<BrandTab, string> = { [BrandTab.Videos]: "Videos", [BrandTab.Kit]: "Brand kit" };

const EMPTY_PALETTE: BrandPalette = { name: "Palette", background: "#ffffff", surface: "#f4f4f5", primary: "#16a34a", accent: "#f59e0b", text: "#111827" };
const PALETTE_SLOTS = ["background", "surface", "primary", "accent", "text"] as const;
const SLOT_LABEL: Record<(typeof PALETTE_SLOTS)[number], string> = { background: "Background", surface: "Surface", primary: "Primary", accent: "Accent", text: "Text" };

export function BrandScreen({ id, tab }: { id: string; tab: BrandTab }) {
  const [kit, setKit] = useState<BrandKit | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.brand(id).then(setKit, (e: Error) => setError(e.message));
  }, [id]);

  return (
    <MotionilyLayout
      title={
        kit && (
          <input
            key={kit.name}
            defaultValue={kit.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== kit.name && void api.updateBrand(id, { name: e.target.value.trim() }).then(setKit)}
            className="w-full rounded-md bg-transparent focus:bg-neutral-900 focus:outline-none"
            aria-label="Project name"
          />
        )
      }
      actions={
        kit &&
        tab === BrandTab.Videos && (
          <a href={href({ name: RouteName.NewVideo, brandId: id })} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
            New video
          </a>
        )
      }
      tabs={kit ? Object.values(BrandTab).map((t) => ({ label: TAB_LABEL[t], href: href({ name: RouteName.Brand, id, tab: t }), active: tab === t })) : undefined}
    >
      {error && <p className="text-sm text-red-400">{error}</p>}
      {kit && (tab === BrandTab.Videos ? <Videos brandId={id} /> : <Kit kit={kit} onKit={setKit} />)}
    </MotionilyLayout>
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
    if (!confirm(`Delete "${v.name}"? This can't be undone.`)) return;
    await api.deleteProject(v._id);
    setVideos((vs) => vs?.filter((x) => x._id !== v._id) ?? null);
  };

  if (videos?.length === 0) {
    return (
      <a href={href({ name: RouteName.NewVideo, brandId })} className="rounded-xl border border-dashed border-neutral-700 p-10 text-center text-sm text-neutral-400 hover:border-neutral-500 hover:text-neutral-200">
        No videos in this project yet. Create the first one.
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
              <span className="flex items-center gap-2 px-1 font-semibold">
                {v.name}
                {v.generating && (
                  <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                    <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" /> Generando…
                  </span>
                )}
              </span>
              <span className="-mt-2 px-1 text-xs text-neutral-400">
                {new Date(v.updatedAt).toLocaleDateString("en-US")}
              </span>
            </a>
            <button
              type="button"
              onClick={() => void remove(v)}
              className="absolute top-4 right-4 rounded-md bg-black/60 px-2 py-1 text-xs text-neutral-300 opacity-0 group-hover:opacity-100 hover:text-red-400"
            >
              Delete
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
        <h2 className="text-sm font-semibold">About the product</h2>
        <p className="text-xs text-neutral-500">What it does, who it's for, brand tone, what to highlight. The agent reads it before every video.</p>
        <textarea
          key={kit.id}
          defaultValue={kit.notes}
          onBlur={(e) => e.target.value !== kit.notes && void api.updateBrand(kit.id, { notes: e.target.value }).then(onKit)}
          rows={5}
          placeholder="E.g. Clinily is software for physical therapists: scheduling, patient records, payments… Warm and professional tone."
          className="resize-y rounded-lg bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-sm font-semibold">Brand palettes</h2>
            <p className="text-xs text-neutral-500">They show up first under "Colors" in every video of the project.</p>
          </div>
          <button type="button" onClick={() => savePalettes([...kit.palettes, EMPTY_PALETTE])} className="text-xs text-neutral-400 hover:text-white">
            Add palette
          </button>
        </div>
        {kit.palettes.map((p, i) => (
          <div key={i} className="flex flex-wrap items-center gap-3">
            <input
              defaultValue={p.name}
              onBlur={(e) => savePalettes(kit.palettes.map((x, j) => (j === i ? { ...x, name: e.target.value || x.name } : x)))}
              className="w-36 rounded-md bg-neutral-900 px-2 py-1.5 text-sm focus:outline-none"
              aria-label="Palette name"
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
            <h2 className="text-sm font-semibold">Logos, screenshots, photos and clips</h2>
            <p className="text-xs text-neutral-500">Describe each image or clip (what it is, how it works) so the agent can explain it and use it in your videos.</p>
          </div>
          <div className="flex items-center gap-2">
            <select value={kind} onChange={(e) => setKind(e.target.value as AssetKind)} className="rounded-md bg-neutral-900 px-2 py-1.5 text-xs focus:outline-none" aria-label="Tipo">
              {/* Clips are recognised by their file, not picked. */}
              {Object.values(AssetKind).filter((k) => k !== AssetKind.Video).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <input ref={fileInput} type="file" accept={ASSET_ACCEPT} multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
            <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()} className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-semibold hover:bg-neutral-700 disabled:opacity-50">
              {uploading ? "Uploading…" : "Upload images or clips"}
            </button>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kit.assets.map((a) => (
            <div key={a.id} className="flex flex-col gap-2">
              {a.kind === AssetKind.Video ? (
                <video
                  src={mediaUrl(a.url)}
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
                  onMouseLeave={(e) => e.currentTarget.pause()}
                  className="aspect-video w-full rounded-lg bg-neutral-900 object-contain"
                />
              ) : (
                <img src={mediaUrl(a.url)} alt={a.name} className="aspect-video w-full rounded-lg bg-neutral-900 object-contain" />
              )}
              <div className="flex items-center gap-2">
                <input
                  defaultValue={a.name}
                  onBlur={(e) => e.target.value !== a.name && void api.updateAsset(kit.id, a.id, { name: e.target.value }).then(onKit)}
                  className="min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm font-medium focus:bg-neutral-900 focus:outline-none"
                  aria-label="Name"
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
                placeholder="What it shows and how it works…"
                className="resize-y rounded-lg bg-neutral-900 px-3 py-2 text-xs placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
              />
            </div>
          ))}
        </div>
      </section>

      <button
        type="button"
        onClick={async () => {
          if (!confirm(`Delete the project "${kit.name}"? It must have no videos.`)) return;
          await api.deleteBrand(kit.id).then(() => navigate({ name: RouteName.Projects }), (e: Error) => alert(e.message));
        }}
        className="self-start text-xs text-neutral-500 hover:text-red-400"
      >
        Delete project
      </button>
    </div>
  );
}
