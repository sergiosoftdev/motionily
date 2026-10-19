import { useEffect, useMemo, useState } from "react";
import { BrickSlot, VideoFormat, type Brick } from "@motionily/protocol";
import { FormatPicker } from "../components/FormatPicker";
import { api } from "../api/client";
import { navigate, RouteName } from "../router";
import { OptionTile } from "../components/style/OptionCard";
import { FitLevel } from "../components/style/options";

type StylePayload = { defaults?: Partial<Record<BrickSlot, string | string[]>> };
const INCLUDED: BrickSlot[] = [BrickSlot.Palette, BrickSlot.Typography, BrickSlot.RenderStyle, BrickSlot.Captions];

export function NewProjectScreen({ brandId }: { brandId: string }) {
  const [catalog, setCatalog] = useState<Brick[]>([]);
  const [styleKey, setStyleKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [format, setFormat] = useState<VideoFormat>(VideoFormat.Vertical);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.bricks().then(setCatalog, (e: Error) => setError(e.message));
  }, []);

  const byKey = useMemo(() => new Map(catalog.map((b) => [b.key, b])), [catalog]);
  const styles = catalog.filter((b) => b.slot === BrickSlot.MotionStyle);
  const style = styleKey ? byKey.get(styleKey) : undefined;
  const includes = style
    ? INCLUDED.map((s) => (style.payload as StylePayload).defaults?.[s])
        .flat()
        .map((k) => (typeof k === "string" ? byKey.get(k)?.name : undefined))
        .filter(Boolean)
    : [];

  const create = async () => {
    if (!style) return;
    setBusy(true);
    try {
      const p = await api.createProject(name.trim() || `Vídeo ${style.name}`, style.key, format, brandId);
      navigate({ name: RouteName.Editor, id: p.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div>
      <main className="mx-auto flex max-w-4xl flex-col gap-8 px-8 py-10">
        <div>
          <h1 className="text-2xl font-bold">Nuevo vídeo</h1>
          <p className="mt-1 text-sm text-neutral-400">Elige un estilo para empezar. Podrás cambiar cualquier detalle después.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {styles.map((s) => (
            <OptionTile key={s.key} brick={s} byKey={byKey} fit={FitLevel.Neutral} selected={s.key === styleKey} onClick={() => setStyleKey(s.key)} />
          ))}
        </div>
        {style && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div>
              <p className="text-sm">{style.description}</p>
              <p className="mt-1 text-xs text-neutral-500">Incluye {includes.join(" · ")}</p>
            </div>
            <div className="max-w-sm">
              <FormatPicker value={format} onChange={setFormat} />
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`Vídeo ${style.name}`}
                aria-label="Nombre del vídeo"
                className="flex-1 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
              />
              <button type="submit" disabled={busy} className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50">
                Crear vídeo
              </button>
            </div>
          </form>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </main>
    </div>
  );
}
