import { useEffect, useMemo, useRef, useState } from "react";
import { api, mediaUrl, type SoundRow } from "../api/client";
import { MotionilyLayout } from "../shell/MotionilyLayout";
import { renderSound, toWav, playBuffer, type SoundRecipe } from "../audio/synth";
import { CATEGORY_LABEL, STARTER_PACK, type SoundCategory } from "../audio/starterPack";

type Draft = { name: string; category: string; description: string; recipe: SoundRecipe; buffer: AudioBuffer };

/** The user's sound effects: synthesized once, reused in every video (the agent places them on the timeline). */
export function SoundsScreen() {
  const [sounds, setSounds] = useState<SoundRow[] | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [packProgress, setPackProgress] = useState<number | null>(null);
  const [describe, setDescribe] = useState("");
  const [designing, setDesigning] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.sounds().then(setSounds, (e: Error) => setError(e.message));
  }, []);

  const categories = useMemo(() => [...new Set((sounds ?? []).map((s) => s.category))], [sounds]);
  const shown = (sounds ?? []).filter((s) => !filter || s.category === filter);

  /** Render every starter recipe in the browser and save it. */
  const installPack = async () => {
    setPackProgress(0);
    try {
      let rows = sounds ?? [];
      for (const [i, s] of STARTER_PACK.entries()) {
        if (rows.some((r) => r.name === s.name)) continue;
        const buffer = await renderSound(s.recipe);
        rows = await api.saveSound({ ...s, duration: +buffer.duration.toFixed(2) }, toWav(buffer));
        setPackProgress((i + 1) / STARTER_PACK.length);
      }
      setSounds(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPackProgress(null);
    }
  };

  const design = async () => {
    if (!describe.trim()) return;
    setDesigning(true);
    setError(null);
    try {
      const d = await api.designSound(describe.trim());
      const buffer = await renderSound(d.recipe);
      setDraft({ ...d, buffer });
      playBuffer(buffer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDesigning(false);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    const rows = await api.saveSound({ ...draft, duration: +draft.buffer.duration.toFixed(2) }, toWav(draft.buffer));
    setSounds(rows);
    setDraft(null);
    setDescribe("");
  };

  return (
    <MotionilyLayout
      title="Sounds"
      description="Motion graphics sound effects synthesized in Motionily. They're saved to your library and Claude places them in your videos."
      actions={
        (sounds?.length ?? 0) < STARTER_PACK.length && (
          <button
            type="button"
            disabled={packProgress !== null}
            onClick={() => void installPack()}
            className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-60"
          >
            {packProgress !== null ? `Sintetizando… ${Math.round(packProgress * 100)}%` : `Crear pack inicial (${STARTER_PACK.length})`}
          </button>
        )
      }
    >

      <section className="flex flex-col gap-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void design();
          }}
        >
          <input
            value={describe}
            onChange={(e) => setDescribe(e.target.value)}
            placeholder="Describe a sound: “metallic whoosh ending in a click”, “deep bubble pop”…"
            className="flex-1 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
          />
          <button type="submit" disabled={designing || !describe.trim()} className="rounded-lg bg-neutral-800 px-4 py-2.5 text-sm font-semibold hover:bg-neutral-700 disabled:opacity-50">
            {designing ? "Designing…" : "Create with AI"}
          </button>
        </form>
        {draft && (
          <div className="flex items-center gap-3 rounded-xl bg-neutral-900 p-4 ring-1 ring-white/10">
            <PlayButton onPlay={() => playBuffer(draft.buffer)} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-mono text-sm">{draft.name}</span>
              <span className="text-xs text-neutral-500">{draft.description}</span>
            </div>
            <Wave buffer={draft.buffer} />
            <button type="button" onClick={() => void saveDraft()} className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-neutral-900 hover:bg-neutral-200">
              Save
            </button>
            <button type="button" onClick={() => setDraft(null)} className="text-xs text-neutral-500 hover:text-white">
              Descartar
            </button>
          </div>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </section>

      {categories.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {[null, ...categories].map((c) => (
            <button
              key={c ?? "all"}
              type="button"
              onClick={() => setFilter(c)}
              className={`rounded-full px-3 py-1 text-xs ${filter === c ? "bg-white text-neutral-900" : "bg-neutral-900 text-neutral-400 hover:text-white"}`}
            >
              {c ? (CATEGORY_LABEL[c as SoundCategory] ?? c) : "Todos"}
            </button>
          ))}
        </div>
      )}

      {sounds?.length === 0 && packProgress === null && (
        <p className="rounded-xl border border-dashed border-neutral-800 p-10 text-center text-sm text-neutral-500">No sounds yet. Create the starter pack or describe one.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((s) => (
          <SoundCard key={s.name} sound={s} onDelete={() => void api.deleteSound(s.name).then(() => setSounds((rows) => rows?.filter((r) => r.name !== s.name) ?? null))} />
        ))}
      </div>
    </MotionilyLayout>
  );
}

function SoundCard({ sound, onDelete }: { sound: SoundRow; onDelete: () => void }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const play = () => {
    audio.current ??= new Audio(mediaUrl(sound.url));
    audio.current.currentTime = 0;
    void audio.current.play();
  };
  return (
    <div className="group flex items-center gap-3 rounded-xl bg-neutral-900 p-3 ring-1 ring-white/5 hover:ring-white/15">
      <PlayButton onPlay={play} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-sm">{sound.name}</span>
        <span className="truncate text-xs text-neutral-500">{sound.description}</span>
      </div>
      <span className="shrink-0 font-mono text-[10px] text-neutral-600">{sound.duration.toFixed(2)}s</span>
      <button type="button" onClick={onDelete} className="text-[11px] text-neutral-600 opacity-0 group-hover:opacity-100 hover:text-red-400">
        Delete
      </button>
    </div>
  );
}

function PlayButton({ onPlay }: { onPlay: () => void }) {
  return (
    <button type="button" onClick={onPlay} aria-label="Escuchar" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 transition hover:scale-105 hover:bg-white/20">
      <svg viewBox="0 0 10 10" className="ml-0.5 size-3 fill-white">
        <path d="M1 0.5 L9 5 L1 9.5 Z" />
      </svg>
    </button>
  );
}

/** Tiny waveform of a rendered draft. */
function Wave({ buffer }: { buffer: AudioBuffer }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext("2d")!;
    const d = buffer.getChannelData(0);
    const step = Math.ceil(d.length / c.width);
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = "#34d399";
    for (let x = 0; x < c.width; x++) {
      let peak = 0;
      for (let i = x * step; i < Math.min(d.length, (x + 1) * step); i++) peak = Math.max(peak, Math.abs(d[i]!));
      const h = Math.max(1, peak * c.height);
      g.fillRect(x, (c.height - h) / 2, 1, h);
    }
  }, [buffer]);
  return <canvas ref={ref} width={160} height={32} className="h-8 w-40" />;
}
