import { useEffect, useState } from "react";
import { compactCount, type Series } from "@motionily/protocol";
import { api } from "../api/client";
import { requestPipeline, VideoPipeline } from "../pipeline";
import { href, navigate, RouteName } from "../router";

const FORMAT_LABEL: Record<string, string> = { vertical_9_16: "9:16", horizontal_16_9: "16:9", square_1_1: "1:1", portrait_4_5: "4:5" };

/** The project's series templates: each makes a new episode from a few words, with the agent building it on the series' structure. */
export function SeriesStrip({ brandId }: { brandId: string }) {
  const [series, setSeries] = useState<Series[] | null>(null);
  useEffect(() => {
    api.series(brandId).then(setSeries, () => setSeries([]));
  }, [brandId]);
  if (!series?.length) return null;
  const remove = async (s: Series) => {
    if (!confirm(`Delete the series "${s.name}"? Its episodes stay as ordinary videos.`)) return;
    await api.deleteSeries(s.id);
    setSeries((all) => all?.filter((x) => x.id !== s.id) ?? null);
  };
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">Series</h2>
        <p className="text-xs text-neutral-500">Videos saved as a template: a new episode keeps their beats, timing, captions, type, palette and sound, with new content.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {series.map((s) => (
          <SeriesCard key={s.id} series={s} brandId={brandId} onDelete={() => void remove(s)} />
        ))}
      </div>
    </section>
  );
}

function SeriesCard({ series: s, brandId, onDelete }: { series: Series; brandId: string; onDelete: () => void }) {
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const top = [...s.performance].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0];

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject(name.trim() || `${s.name} #${s.episodes + 2}`, brief.trim(), undefined, brandId, "", [], s.id);
      requestPipeline(p.id, VideoPipeline.Generate);
      navigate({ name: RouteName.Editor, id: p.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-neutral-900/60 p-4 ring-1 ring-white/5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{s.name}</h3>
          <p className="text-xs text-neutral-500">
            {s.blueprint.beats.length} beats · {s.blueprint.duration}s · {FORMAT_LABEL[s.format] ?? s.format} · {s.episodes} {s.episodes === 1 ? "episode" : "episodes"}
            {top?.views != null && ` · ${compactCount(top.views)} views on ${top.platform}`}
          </p>
        </div>
        <button type="button" onClick={onDelete} className="shrink-0 text-xs text-neutral-600 hover:text-red-400" aria-label={`Delete the series ${s.name}`}>
          Delete
        </button>
      </div>
      {s.note && <p className="line-clamp-2 text-xs text-neutral-400">{s.note}</p>}
      {s.sourceProjectId && (
        <a href={href({ name: RouteName.Editor, id: s.sourceProjectId })} className="self-start text-[11px] text-neutral-500 hover:text-white">
          From “{s.sourceName ?? "a video"}”
        </a>
      )}
      {making ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={`${s.name} #${s.episodes + 2}`} aria-label="Episode name" className="rounded-lg bg-neutral-800 px-3 py-2 text-sm focus:outline-none" />
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            maxLength={4000}
            rows={3}
            autoFocus
            placeholder="What is this episode about?"
            aria-label="What this episode is about"
            className="resize-none rounded-lg bg-neutral-800 px-3 py-2 text-sm focus:outline-none"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !brief.trim()} className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-40">
              {busy ? "Creating…" : "Create episode"}
            </button>
            <button type="button" onClick={() => setMaking(false)} className="text-xs text-neutral-500 hover:text-white">
              Cancel
            </button>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </form>
      ) : (
        <button type="button" onClick={() => setMaking(true)} className="self-start rounded-lg bg-neutral-800 px-3 py-2 text-xs font-semibold hover:bg-neutral-700">
          New episode
        </button>
      )}
    </div>
  );
}
