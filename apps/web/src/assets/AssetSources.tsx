import { useEffect, useMemo, useState } from "react";
import { AssetFormat, AssetKind as LibraryKind, ProviderKey, type LibraryItem, type ProviderStatus } from "@motionily/protocol";
import { api, mediaUrl } from "../api/client";

/** What each source adds, shown next to its key field. */
const PROVIDERS: Record<ProviderKey, { name: string; about: string; where: string; placeholder: string }> = {
  [ProviderKey.Pexels]: { name: "Pexels", about: "Free stock photos and video clips.", where: "Pexels has paused new API keys; a key you already have still works.", placeholder: "Pexels API key" },
  [ProviderKey.Pixabay]: { name: "Pixabay", about: "Free photos and video clips.", where: "Your key is in your Pixabay account under API.", placeholder: "Pixabay API key" },
  [ProviderKey.Europeana]: {
    name: "Europeana",
    about: "Millions of openly licensed photos from Europe's museums and archives: history, places, people.",
    where: "Get a free key at pro.europeana.eu › Get your API key.",
    placeholder: "Europeana API key",
  },
  [ProviderKey.Brave]: {
    name: "Brave Search",
    about: "Web image search for what free libraries do not have. Licenses are unknown, so the agent only uses these for commentary, news or history.",
    where: "Create a key at api-dashboard.search.brave.com.",
    placeholder: "Brave Search API key",
  },
  [ProviderKey.OpenAI]: {
    name: "OpenAI",
    about: "Image generation, a last resort for things that do not exist anywhere. Each image is billed to your OpenAI account.",
    where: "Create a key at platform.openai.com › API keys.",
    placeholder: "OpenAI API key (sk-…)",
  },
};

/** Paste or remove the user's own key for each asset source. */
export function AssetSourcesForm() {
  const [rows, setRows] = useState<ProviderStatus[] | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<ProviderKey, string>>>({});
  const [busy, setBusy] = useState<ProviderKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ProviderKey, string>>>({});
  useEffect(() => {
    api.providerKeys().then(setRows, () => setRows([]));
  }, []);
  const run = async (provider: ProviderKey, fn: () => Promise<ProviderStatus[]>) => {
    setBusy(provider);
    setErrors((e) => ({ ...e, [provider]: undefined }));
    try {
      setRows(await fn());
      setDrafts((d) => ({ ...d, [provider]: "" }));
    } catch (e) {
      setErrors((x) => ({ ...x, [provider]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };
  if (!rows) return <p className="text-xs text-neutral-500">Loading…</p>;
  return (
    <div className="flex flex-col gap-5">
      {rows.map((r) => {
        const p = PROVIDERS[r.provider];
        const draft = drafts[r.provider] ?? "";
        return (
          <div key={r.provider} className="flex flex-col gap-2">
            <div>
              <p className="text-sm text-neutral-200">{p.name}</p>
              <p className="text-xs leading-relaxed text-neutral-500">
                {p.about} {p.where}
              </p>
            </div>
            {r.connected ? (
              <div className="flex items-center gap-3 text-sm text-neutral-300">
                <span className="size-2 rounded-full bg-emerald-400" /> Connected · key ending in <code className="text-white">{r.hint}</code>
                <button type="button" disabled={busy === r.provider} onClick={() => void run(r.provider, () => api.disconnectProviderKey(r.provider))} className="text-xs text-neutral-500 hover:text-white disabled:opacity-50">
                  Remove
                </button>
              </div>
            ) : (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.trim()) void run(r.provider, () => api.connectProviderKey(r.provider, draft));
                }}
              >
                <input
                  type="password"
                  value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [r.provider]: e.target.value }))}
                  placeholder={r.platform ? `${p.placeholder} (optional: Motionily's shared key is in use)` : p.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`${p.name} API key`}
                  className="min-w-0 flex-1 rounded-lg bg-neutral-900 px-3 py-2 font-mono text-sm placeholder:font-sans placeholder:text-neutral-600 focus:ring-1 focus:ring-white/30 focus:outline-none"
                />
                <button type="submit" disabled={busy === r.provider || !draft.trim()} className="shrink-0 rounded-lg bg-neutral-800 px-4 py-2 text-sm text-white hover:bg-neutral-700 disabled:opacity-40">
                  {busy === r.provider ? "Checking…" : "Connect"}
                </button>
              </form>
            )}
            {errors[r.provider] && <p className="text-xs text-red-400">{errors[r.provider]}</p>}
          </div>
        );
      })}
      <p className="text-xs leading-relaxed text-neutral-500">Keys are stored encrypted and only ever sent to their provider. Wikimedia Commons, Openverse, the Internet Archive, the Met and Iconify need no key.</p>
    </div>
  );
}

const KIND_LABEL: Record<LibraryKind, string> = {
  [LibraryKind.Photo]: "Photos",
  [LibraryKind.Logo]: "Logos",
  [LibraryKind.Footage]: "Footage",
  [LibraryKind.Texture]: "Textures",
};

/** Everything agents imported, cut out or generated, with its credit. */
export function LibraryGrid() {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [kind, setKind] = useState<LibraryKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.library().then(setItems, (e: Error) => setError(e.message));
  }, []);
  const shown = useMemo(() => (items ?? []).filter((i) => !kind || i.kind === kind), [items, kind]);
  const remove = async (item: LibraryItem) => {
    if (!window.confirm(`Remove "${item.title}" from your library? Videos that show it will lose it.`)) return;
    try {
      await api.removeLibraryItem(item.id);
      setItems((xs) => (xs ?? []).filter((x) => x.id !== item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!items) return <p className="text-xs text-neutral-500">Loading…</p>;
  if (!items.length) return <p className="text-xs text-neutral-500">Empty for now: logos, photos and clips the agent finds for your videos land here and are reused.</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3 text-xs">
        {[null, ...Object.values(LibraryKind)].map((k) => (
          <button key={k ?? "all"} type="button" onClick={() => setKind(k)} className={k === kind ? "text-white" : "text-neutral-500 hover:text-neutral-300"}>
            {k ? KIND_LABEL[k] : "All"}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {shown.map((i) => {
          const thumb = i.credit.poster ?? i.credit.preview ?? i.credit.src;
          return (
            <figure key={i.id} className="group flex flex-col gap-1">
              <img src={mediaUrl(thumb)} alt={i.title} loading="lazy" className={`aspect-[4/3] w-full rounded-lg bg-neutral-900 ${i.format === AssetFormat.Svg ? "object-contain p-2" : "object-cover"}`} />
              <figcaption className="flex items-start justify-between gap-2">
                <span className="line-clamp-2 text-xs text-neutral-400" title={`${i.credit.license} · ${i.credit.author}`}>
                  {i.title}
                </span>
                <button type="button" onClick={() => void remove(i)} className="shrink-0 text-xs text-neutral-600 opacity-0 group-hover:opacity-100 hover:text-white focus:opacity-100">
                  Remove
                </button>
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
