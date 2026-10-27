import { useEffect, useState } from "react";
import { seriesBlueprint, type Project, type Series } from "@motionily/protocol";
import { api } from "../api/client";
import { engineHost } from "../engine/host";
import { BrandTab, href, RouteName } from "../router";

/** Lucide "layers" (ISC): a stack, the series' episodes. */
const LAYERS = "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83zM2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17";

/**
 * Save this video's structure as a series template (beats and timing, rhythm, captions, type,
 * palette, sound, voice pace), measured from the scene as it is now, to make more episodes of it.
 * On an episode it says which series it belongs to.
 */
export function SaveSeries({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Series | null>(null);
  const [of, setOf] = useState<Series | null>(null);

  useEffect(() => {
    if (project.seriesId) api.seriesOf(project.id).then((r) => setOf(r.series), () => setOf(null));
  }, [project.id, project.seriesId]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const blueprint = seriesBlueprint(JSON.parse(engineHost.sceneJson()) as Record<string, unknown>);
      if (!blueprint.beats.length) throw new Error("This video has no beats yet (layers grouped with g=). Build it first, or ask the agent to group it into beats.");
      setSaved(await api.saveSeries(project.id, { name: name.trim(), note: note.trim() || undefined, blueprint }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={of ? `Episode of the series "${of.name}"` : "Save as a series: make more videos with this structure"}
        className={`flex items-center gap-1 rounded-md p-1 text-xs ${of ? "text-sky-300" : "text-neutral-500 hover:text-white"}`}
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d={LAYERS} />
        </svg>
        {of && <span className="max-w-32 truncate">{of.name}</span>}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-2 flex w-80 flex-col gap-2 rounded-xl bg-neutral-900 p-3 shadow-2xl ring-1 ring-white/10">
          {of && (
            <p className="text-xs text-neutral-400">
              Episode of <span className="text-white">{of.name}</span>: the agent follows its structure ({of.blueprint.beats.length} beats, {of.blueprint.duration}s).
            </p>
          )}
          {saved ? (
            <>
              <p className="text-sm">
                Series <span className="font-semibold">{saved.name}</span> saved: {saved.blueprint.beats.length} beats, {saved.blueprint.duration}s.
              </p>
              {project.brandId && (
                <a href={href({ name: RouteName.Brand, id: project.brandId, tab: BrandTab.Videos })} className="text-xs font-semibold text-white underline">
                  Make an episode from the project page
                </a>
              )}
            </>
          ) : (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <p className="text-xs text-neutral-400">Save this video's structure (beats, timing, captions, type, palette, sound, voice pace) to make more episodes with other content.</p>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Series name" aria-label="Series name" className="rounded-lg bg-neutral-800 px-3 py-2 text-sm focus:outline-none" />
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="Why it worked, what every episode keeps (optional)"
                aria-label="What every episode keeps"
                className="resize-none rounded-lg bg-neutral-800 px-3 py-2 text-sm focus:outline-none"
              />
              <button type="submit" disabled={busy || !name.trim()} className="rounded-lg bg-white px-3 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-40">
                {busy ? "Saving…" : "Save series"}
              </button>
            </form>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
