import { useEffect, useMemo, useRef, useState } from "react";
import { api, mediaUrl, SoundShape, type SoundRow } from "../api/client";
import { MotionilyLayout } from "../shell/MotionilyLayout";

/** What each shape means when you listen, for the tag next to a sound. */
const SHAPE_LABEL: Record<SoundShape, string> = {
  [SoundShape.Hit]: "Hit",
  [SoundShape.Build]: "Build-up",
  [SoundShape.Swell]: "Pass",
  [SoundShape.Steady]: "Continuous",
};

/** Motionily's sound effect library: the same for every account; Claude picks from it for each video. */
export function SoundsScreen() {
  const [sounds, setSounds] = useState<SoundRow[] | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    api.sounds().then(setSounds, (e: Error) => setError(e.message));
    return () => audio.current?.pause();
  }, []);

  const categories = useMemo(() => [...new Set((sounds ?? []).map((s) => s.category))], [sounds]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = (sounds ?? []).filter((s) => (!category || s.category === category) && (!q || `${s.name} ${s.description}`.toLowerCase().includes(q)));
    return categories.map((c) => ({ category: c, sounds: shown.filter((s) => s.category === c) })).filter((g) => g.sounds.length);
  }, [sounds, category, query, categories]);

  /** One sound at a time; clicking the one playing stops it. */
  const toggle = (s: SoundRow) => {
    audio.current?.pause();
    if (playing === s.name) return setPlaying(null);
    const a = new Audio(mediaUrl(s.url));
    a.onended = () => setPlaying((p) => (p === s.name ? null : p));
    audio.current = a;
    setPlaying(s.name);
    void a.play().catch(() => setPlaying(null));
  };

  return (
    <MotionilyLayout title="Sounds" description="Motionily's sound effect library. Claude picks from it to sync effects to the motion of every video.">
      <div className="flex flex-col gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sounds: whoosh, shutter, riser…"
          className="rounded-lg bg-neutral-900 px-4 py-2.5 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
        />
        {categories.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {[null, ...categories].map((c) => (
              <button
                key={c ?? "all"}
                type="button"
                onClick={() => setCategory(c)}
                className={`rounded-full px-3 py-1 text-xs ${category === c ? "bg-white text-neutral-900" : "bg-neutral-900 text-neutral-400 hover:text-white"}`}
              >
                {c ?? `All (${sounds?.length ?? 0})`}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {sounds === null && !error && <p className="text-sm text-neutral-500">Loading the library…</p>}
      {sounds?.length === 0 && <p className="py-10 text-center text-sm text-neutral-500">The library is empty.</p>}
      {sounds !== null && sounds.length > 0 && groups.length === 0 && <p className="py-10 text-center text-sm text-neutral-500">No sounds match “{query}”.</p>}

      {groups.map((g) => (
        <section key={g.category} className="flex flex-col gap-1">
          <h2 className="mb-1 text-sm font-semibold text-neutral-300">
            {g.category} <span className="font-normal text-neutral-600">{g.sounds.length}</span>
          </h2>
          {g.sounds.map((s) => (
            <SoundRowView key={s.name} sound={s} playing={playing === s.name} onToggle={() => toggle(s)} />
          ))}
        </section>
      ))}
    </MotionilyLayout>
  );
}

function SoundRowView({ sound, playing, onToggle }: { sound: SoundRow; playing: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
      <button
        type="button"
        onClick={onToggle}
        aria-label={playing ? "Stop" : "Listen"}
        className={`flex size-8 shrink-0 items-center justify-center rounded-full transition hover:scale-105 ${playing ? "bg-white" : "bg-white/10 hover:bg-white/20"}`}
      >
        <svg viewBox="0 0 10 10" className={`size-3 ${playing ? "fill-neutral-900" : "ml-0.5 fill-white"}`}>
          {playing ? <rect x="2" y="2" width="6" height="6" rx="0.5" /> : <path d="M1 0.5 L9 5 L1 9.5 Z" />}
        </svg>
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-neutral-100">{sound.description}</span>
        <span className="truncate font-mono text-[11px] text-neutral-600">{sound.name}</span>
      </div>
      <Shape sound={sound} />
      <span className="w-16 shrink-0 text-xs text-neutral-500">{SHAPE_LABEL[sound.shape]}</span>
      <span className="w-12 shrink-0 text-right font-mono text-[11px] text-neutral-500 tabular-nums">{formatLength(sound.duration)}</span>
    </div>
  );
}

/** The sound drawn from its measurements: its length, where it hits hardest and each separate hit. */
function Shape({ sound }: { sound: SoundRow }) {
  const x = (t: number) => `${Math.min(100, (t / Math.max(sound.duration, 0.01)) * 100)}%`;
  return (
    <div className="relative hidden h-5 w-40 shrink-0 sm:block" aria-hidden>
      <div className="absolute inset-x-0 top-1/2 h-px bg-white/10" />
      {sound.hits.map((h) => (
        <div key={h} className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-white/30" style={{ left: x(h) }} />
      ))}
      <div className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#4aa3f0]" style={{ left: x(sound.peak) }} />
    </div>
  );
}

function formatLength(s: number) {
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}
