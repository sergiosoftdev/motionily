import { useState } from "react";
import { VideoFormat } from "@motionily/protocol";
import { FormatPicker } from "../components/FormatPicker";
import { api, type Concept } from "../api/client";
import { href, navigate, BrandTab, RouteName } from "../router";
import { requestAutoGenerate } from "../components/GeneratePanel";

const COUNTS = [1, 2, 3, 4, 5, 6];
const DEFAULT_COUNT = 3;

/**
 * New video, the clinily-spots way: describe the idea, Claude pitches N different concepts (each with
 * its ElevenLabs script), pick one, tweak it, and the video is built on that script.
 */
export function NewProjectScreen({ brandId }: { brandId: string }) {
  const [idea, setIdea] = useState("");
  const [format, setFormat] = useState<VideoFormat>(VideoFormat.Vertical);
  const [count, setCount] = useState(DEFAULT_COUNT);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [seen, setSeen] = useState<string[]>([]);
  const [steer, setSteer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => navigate({ name: RouteName.Brand, id: brandId, tab: BrandTab.Videos });

  const pitch = async (again = false) => {
    if (!idea.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { concepts: next } = await api.concepts(brandId, { idea, format, count, steer: again ? steer : undefined, avoid: again ? seen : undefined });
      setConcepts(next);
      setSeen((s) => [...s, ...next.map((c) => c.title)]);
      setSteer("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (c: Concept, generateNow: boolean) => {
    setBusy(true);
    try {
      const p = await api.createProject(c.title.slice(0, 80), c.prompt, format, brandId, c.voiceover);
      if (generateNow) requestAutoGenerate(p.id);
      navigate({ name: RouteName.Editor, id: p.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const edit = (i: number, patch: Partial<Concept>) => setConcepts((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-10" onClick={close}>
      <div className="flex w-full max-w-5xl flex-col gap-6 rounded-2xl bg-neutral-950 p-8 ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Nuevo vídeo</h1>
            <p className="mt-1 text-sm text-neutral-400">Describe la idea. Claude te propone varios enfoques, cada uno con su guion para ElevenLabs; el vídeo se monta sobre la voz.</p>
          </div>
          <a href={href({ name: RouteName.Brand, id: brandId, tab: BrandTab.Videos })} className="text-sm text-neutral-500 hover:text-white">
            Cerrar
          </a>
        </div>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void pitch();
          }}
        >
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            rows={4}
            autoFocus
            placeholder="Ej.: reel para Instagram sobre una fisio que pierde huecos por cancelaciones y con la lista de espera los rellena sola. Tono cercano, con humor."
            aria-label="Idea del vídeo"
            className="resize-y rounded-lg bg-neutral-900 px-4 py-3 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
          />
          <div className="flex flex-wrap items-end gap-6">
            <div className="w-80">
              <FormatPicker value={format} onChange={setFormat} />
            </div>
            <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
              Propuestas
              <div className="flex gap-1">
                {COUNTS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setCount(n)}
                    className={`size-9 rounded-md text-sm ${n === count ? "bg-white font-semibold text-neutral-900" : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </label>
            <button type="submit" disabled={busy || !idea.trim()} className="ml-auto rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50">
              {busy && !concepts.length ? "Pensando…" : concepts.length ? "Proponer de nuevo" : "Proponer"}
            </button>
          </div>
        </form>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {concepts.length > 0 && (
          <>
            <div className="grid gap-5 md:grid-cols-2">
              {concepts.map((c, i) => (
                <article key={`${c.title}-${i}`} className="flex flex-col gap-3 rounded-xl bg-neutral-900 p-5">
                  <input
                    value={c.title}
                    onChange={(e) => edit(i, { title: e.target.value })}
                    aria-label="Título"
                    className="bg-transparent text-lg font-semibold focus:outline-none"
                  />
                  <p className="text-sm">
                    <span className="text-neutral-500">Gancho · </span>
                    {c.hook}
                  </p>
                  <p className="text-sm text-neutral-300">{c.direction}</p>
                  <ol className="flex flex-col gap-1 text-xs text-neutral-400">
                    {c.beats.map((b, j) => (
                      <li key={j}>
                        <span className="font-mono text-neutral-500">{b.at}</span> {b.what}
                      </li>
                    ))}
                  </ol>
                  <label className="flex flex-col gap-1 text-xs text-neutral-500">
                    Guion para ElevenLabs
                    <textarea
                      value={c.voiceover}
                      onChange={(e) => edit(i, { voiceover: e.target.value })}
                      rows={8}
                      className="resize-y rounded-lg bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-white/40"
                    />
                  </label>
                  <details className="text-xs text-neutral-500">
                    <summary className="cursor-pointer hover:text-neutral-300">Prompt para el agente</summary>
                    <textarea
                      value={c.prompt}
                      onChange={(e) => edit(i, { prompt: e.target.value })}
                      rows={7}
                      className="mt-2 w-full resize-y rounded-lg bg-neutral-950 px-3 py-2 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-white/40"
                    />
                  </details>
                  <div className="mt-auto flex flex-wrap gap-2 pt-2">
                    <button type="button" disabled={busy} onClick={() => void choose(c, false)} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50">
                      Elegir y grabar la voz
                    </button>
                    <button type="button" disabled={busy} onClick={() => void choose(c, true)} className="rounded-lg px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50">
                      Generar ya, sin voz
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={steer}
                onChange={(e) => setSteer(e.target.value)}
                placeholder="¿Ninguna? Dile qué cambiar: más humor, menos texto, otro gancho…"
                className="flex-1 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
              />
              <button type="button" disabled={busy} onClick={() => void pitch(true)} className="rounded-lg bg-neutral-800 px-4 py-2.5 text-sm font-semibold hover:bg-neutral-700 disabled:opacity-50">
                {busy ? "Pensando…" : `Otras ${count}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
