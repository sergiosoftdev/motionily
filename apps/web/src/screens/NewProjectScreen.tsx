import { useEffect, useMemo, useState } from "react";
import { BrickSlot, type Brick } from "@motionily/protocol";
import { api } from "../api/client";
import { navigate, RouteName } from "../router";
import { TopBar } from "./TopBar";
import { BrickCard } from "../components/lego/BrickCard";
import { SLOTS } from "../components/lego/slots";

type KitPayload = { defaults?: Partial<Record<BrickSlot, string | string[]>> };

export function NewProjectScreen() {
  const [catalog, setCatalog] = useState<Brick[]>([]);
  const [kitKey, setKitKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.bricks().then(setCatalog, (e: Error) => setError(e.message));
  }, []);

  const byKey = useMemo(() => new Map(catalog.map((b) => [b.key, b])), [catalog]);
  const kits = catalog.filter((b) => b.slot === BrickSlot.MotionStyle);
  const kit = kitKey ? byKey.get(kitKey) : undefined;
  const contents = kit
    ? SLOTS.filter((s) => s.slot !== BrickSlot.MotionStyle).flatMap((s) =>
        [(kit.payload as KitPayload).defaults?.[s.slot] ?? []]
          .flat()
          .map((k) => byKey.get(k))
          .filter((b): b is Brick => !!b),
      )
    : [];

  const create = async () => {
    if (!kit) return;
    setBusy(true);
    try {
      const p = await api.createProject(name.trim() || `Vídeo ${kit.name}`, kit.key);
      navigate({ name: RouteName.Editor, id: p.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh">
      <TopBar />
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-5 py-8">
        <div>
          <h1 className="text-2xl font-bold">Elige tu caja</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Cada caja trae un set de piezas que encajan. Luego cambias las que quieras.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kits.map((k) => (
            <BrickCard key={k.key} brick={k} selected={k.key === kitKey} onClick={() => setKitKey(k.key)} />
          ))}
        </div>

        {kit && (
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-medium">Qué trae la caja {kit.name}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {contents.map((b) => (
                <BrickCard key={b.key} brick={b} compact />
              ))}
            </div>
            <form
              className="flex flex-col gap-3 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`Vídeo ${kit.name}`}
                className="flex-1 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
              />
              <button type="submit" disabled={busy} className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50">
                Abrir la caja
              </button>
            </form>
          </section>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </main>
    </div>
  );
}
