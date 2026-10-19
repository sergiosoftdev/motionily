import { useEffect, useRef, useState, type ReactNode } from "react";
import { VideoFormat } from "@motionily/protocol";
import { FORMAT_OPTIONS } from "../components/FormatPicker";
import { Logo } from "../components/Logo";
import { api, type Concept } from "../api/client";
import { href, navigate, BrandTab, RouteName } from "../router";
import { requestPipeline, VideoPipeline } from "../pipeline";
import { ReferenceStrip, useReferences } from "../components/References";
import { ModePicker } from "../components/ModePicker";
import { AgentEffort, AgentModel, EFFORT_LABEL, loadPrefs, MODEL_LABEL, savePrefs, usageLine, type AgentPrefs } from "../components/GeneratePanel";

const Step = {
  Idea: "idea",
  Format: "format",
  Count: "count",
  Thinking: "thinking",
  Pick: "pick",
  Script: "script",
  Voice: "voice",
} as const;
type Step = (typeof Step)[keyof typeof Step];

/** Steps shown in the progress bar (thinking belongs to "pick"). */
const VISIBLE: { step: Step; label: string }[] = [
  { step: Step.Idea, label: "Idea" },
  { step: Step.Format, label: "Formato" },
  { step: Step.Count, label: "Propuestas" },
  { step: Step.Pick, label: "Enfoque" },
  { step: Step.Script, label: "Guion" },
  { step: Step.Voice, label: "Voz" },
];
const COUNTS = [1, 2, 3, 4, 5, 6];

/** Starting directions that read like real motion design briefs; the user picks one (or none). */
const STARTERS: { id: string; label: string; prompt: string }[] = [
  { id: "kinetic", label: "Tipografía cinética", prompt: "Tipografía cinética a pantalla completa: palabras enormes que entran por máscaras y se empujan unas a otras, cortes al ritmo de la voz, contraste fuerte con un único color de acento y una palabra clave que golpea con escala." },
  { id: "product", label: "Showcase de producto", prompt: "Showcase de la interfaz: capturas reales dentro de un marco de dispositivo que flota, zooms a cada función con un cursor animado, etiquetas y flechas que se dibujan, tarjetas de UI que salen del dispositivo con profundidad." },
  { id: "data", label: "Infografía animada", prompt: "Infografía animada: contadores que suben, barras y gráficos que se construyen, líneas que se dibujan entre datos, iconos hechos con formas y una rejilla suiza visible que ordena todo." },
  { id: "liquid", label: "Formas líquidas", prompt: "Formas orgánicas grandes que crecen, se funden y se usan como transiciones entre planos; paleta vibrante con un fondo que nunca está quieto y tipografía limpia encima." },
  { id: "collage", label: "Collage y recortes", prompt: "Estética collage: bloques de color con bordes duros, elementos que entran como recortes con rebote y ligera rotación, sombras planas desplazadas y ritmo juguetón." },
  { id: "keynote", label: "Minimal tipo keynote", prompt: "Minimalismo tipo keynote: mucho aire, una idea por plano, movimientos lentos y precisos con escalas sutiles, fundidos cuidados y un acento de color que guía la mirada." },
  { id: "brutal", label: "Brutalista", prompt: "Brutalista: rejilla visible, tipografía condensada y monoespaciada, colores primarios saturados, cortes secos, bloques que tapan y destapan el contenido como glitches." },
  { id: "steps", label: "Paso a paso", prompt: "Explicación paso a paso: números grandes, conectores y flechas que se dibujan entre pasos, cada paso entra mientras el anterior se reduce a un lado, cierre con todo el recorrido a la vista." },
];
const THINKING_LINES = [
  "Leyendo tu kit de marca…",
  "Buscando ganchos que paren el scroll…",
  "Probando metáforas visuales distintas…",
  "Escribiendo guiones con ritmo de voz…",
  "Repartiendo los planos en el tiempo…",
];
const THINKING_LINE_MS = 2600;

/**
 * New video, the clinily-spots way, as a guided full-screen flow: idea, format, how many concepts,
 * pick one, polish its ElevenLabs script, add the voice. The video is then built on that voice.
 */
export function NewProjectScreen({ brandId }: { brandId: string }) {
  const [step, setStep] = useState<Step>(Step.Idea);
  const [idea, setIdea] = useState("");
  const [starter, setStarter] = useState<string | null>(null);
  /** What Claude receives: the user's idea plus the chosen starting direction. */
  const fullIdea = () => {
    const st = STARTERS.find((x) => x.id === starter);
    return st ? `${idea.trim()}\n\nDirección visual de partida: ${st.prompt}` : idea;
  };
  const refs = useReferences();
  const [format, setFormat] = useState<VideoFormat>(VideoFormat.Vertical);
  const [count, setCount] = useState(3);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [pitchCost, setPitchCost] = useState<string | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  const [steer, setSteer] = useState("");
  const [chosen, setChosen] = useState<Concept | null>(null);
  const [prefs, setPrefs] = useState<AgentPrefs>(loadPrefs);
  const updatePrefs = (p: Partial<AgentPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    savePrefs(next);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const back = href({ name: RouteName.Brand, id: brandId, tab: BrandTab.Videos });

  const pitch = async (again = false) => {
    setStep(Step.Thinking);
    setError(null);
    try {
      const { concepts: next, usage } = await api.concepts(brandId, { idea: fullIdea(), format, count, steer: again ? steer : undefined, avoid: again ? seen : undefined, references: refs.refs, model: prefs.model, effort: prefs.effort });
      setConcepts(next);
      setPitchCost(usage ? usageLine(usage) : null);
      setSeen((s) => [...s, ...next.map((c) => c.title)]);
      setSteer("");
      setStep(Step.Pick);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep(Step.Count);
    }
  };

  const finish = async (voice: File | null) => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject(chosen.title.slice(0, 80), chosen.prompt, format, brandId, chosen.voiceover, refs.refs);
      if (voice) await api.uploadAudio(p.id, voice);
      requestPipeline(p.id, voice ? VideoPipeline.TranscribeThenGenerate : VideoPipeline.Generate);
      navigate({ name: RouteName.Editor, id: p.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const current = step === Step.Thinking ? Step.Pick : step;
  const index = VISIBLE.findIndex((v) => v.step === current);

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-neutral-950 text-white">
      <Glow index={index} />
      <header className="relative z-10 flex items-center justify-between px-8 py-6">
        <Logo />
        <a href={back} className="text-sm text-neutral-500 hover:text-white">
          Salir
        </a>
      </header>
      <Progress index={index} onJump={(i) => i < index && step !== Step.Thinking && setStep(VISIBLE[i]!.step)} />

      <main className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col px-8 pt-[12vh] pb-16">
        {step === Step.Idea && (
          <Panel key={step} kicker="Paso 1" title="¿Qué quieres contar?" hint="En tus palabras: para quién es, qué problema resuelve, qué tono. Claude se encarga del resto.">
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && idea.trim() && setStep(Step.Format)}
              rows={5}
              autoFocus
              placeholder="Ej.: reel para fisios que pierden huecos por cancelaciones de última hora; con la lista de espera se rellenan solos. Cercano, con humor. (Pega o arrastra imágenes de referencia)"
              {...refs.handlers}
              className="w-full resize-none rounded-2xl bg-white/5 px-6 py-5 text-lg leading-relaxed ring-1 ring-white/10 transition placeholder:text-neutral-600 focus:bg-white/[0.07] focus:outline-none focus:ring-white/30"
            />
            <ReferenceStrip r={refs} />
            <div className="flex flex-col gap-3">
              <span className="text-sm text-neutral-400">¿Con qué estilo de motion? (opcional)</span>
              <div className="flex flex-wrap gap-2">
                {STARTERS.map((st, i) => (
                  <button
                    key={st.id}
                    type="button"
                    title={st.prompt}
                    onClick={() => setStarter((cur) => (cur === st.id ? null : st.id))}
                    style={{ animationDelay: `${0.04 * i}s` }}
                    className={`wiz-in rounded-full px-4 py-2 text-sm ring-1 transition hover:-translate-y-0.5 ${
                      starter === st.id ? "bg-white text-neutral-950 ring-white" : "bg-white/[0.03] text-neutral-300 ring-white/10 hover:bg-white/[0.08]"
                    }`}
                  >
                    {st.label}
                  </button>
                ))}
              </div>
              {starter && <p className="max-w-3xl text-sm text-neutral-500">{STARTERS.find((x) => x.id === starter)!.prompt}</p>}
            </div>
            <Next disabled={!idea.trim() || refs.uploading} onClick={() => setStep(Step.Format)} hint="⌘ + Enter" />
          </Panel>
        )}

        {step === Step.Format && (
          <Panel key={step} kicker="Paso 2" title="¿Dónde se va a ver?" hint="Cambia la composición entera, así que mejor decidirlo ahora.">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {FORMAT_OPTIONS.map((o, i) => (
                <button
                  key={o.format}
                  type="button"
                  onClick={() => {
                    setFormat(o.format);
                    setStep(Step.Count);
                  }}
                  style={{ animationDelay: `${0.08 * i}s` }}
                  className={`wiz-in group flex flex-col items-center gap-5 rounded-2xl px-4 py-8 ring-1 transition hover:-translate-y-1 hover:bg-white/[0.07] ${
                    format === o.format ? "bg-white/[0.08] ring-white/40" : "bg-white/[0.03] ring-white/10"
                  }`}
                >
                  <span className="flex h-20 items-center">
                    <span className={`block rounded-md border-2 border-white/70 transition group-hover:border-white ${frameBox(o.format)}`} />
                  </span>
                  <span className="text-xl font-semibold">{o.label}</span>
                  <span className="text-sm text-neutral-400">{o.hint}</span>
                </button>
              ))}
            </div>
          </Panel>
        )}

        {step === Step.Count && (
          <Panel key={step} kicker="Paso 3" title="¿Cuántas ideas quieres ver?" hint="Cada una será un enfoque distinto, con su guion para ElevenLabs. Más ideas tardan un poco más.">
            <div className="flex flex-wrap gap-3">
              {COUNTS.map((n, i) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setCount(n)}
                  style={{ animationDelay: `${0.05 * i}s` }}
                  className={`wiz-in size-20 rounded-2xl text-3xl font-semibold ring-1 transition hover:-translate-y-1 ${
                    n === count ? "bg-white text-neutral-950 ring-white" : "bg-white/[0.03] text-neutral-300 ring-white/10 hover:bg-white/[0.07]"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <AgentPicker prefs={prefs} onChange={updatePrefs} />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <Next label={`Proponer ${count === 1 ? "una idea" : `${count} ideas`}`} onClick={() => void pitch()} />
          </Panel>
        )}

        {step === Step.Thinking && <Thinking count={count} />}

        {step === Step.Pick && (
          <Panel key={`pick-${seen.length}`} kicker="Paso 4" title="Elige un enfoque" hint="Todas cuentan tu idea, cada una a su manera. Podrás retocar el guion en el siguiente paso.">
            <div className={`grid gap-5 ${concepts.length > 1 ? "md:grid-cols-2" : ""} ${concepts.length > 4 ? "xl:grid-cols-3" : ""}`}>
              {concepts.map((c, i) => (
                <button
                  key={`${c.title}-${i}`}
                  type="button"
                  onClick={() => {
                    setChosen(c);
                    setStep(Step.Script);
                  }}
                  style={{ animationDelay: `${0.12 * i}s` }}
                  className="wiz-in group flex flex-col gap-4 rounded-2xl bg-white/[0.03] p-6 text-left ring-1 ring-white/10 transition hover:-translate-y-1 hover:bg-white/[0.06] hover:ring-white/30"
                >
                  <span className="font-mono text-xs text-neutral-500">Idea {i + 1}</span>
                  <span className="text-2xl font-semibold leading-tight">{c.title}</span>
                  <span className="text-lg text-white/90">“{c.hook}”</span>
                  <span className="text-sm leading-relaxed text-neutral-400">{c.direction}</span>
                  <span className="mt-1 flex flex-col gap-1.5 border-t border-white/10 pt-4 text-xs text-neutral-500">
                    {c.beats.map((b, j) => (
                      <span key={j}>
                        <span className="font-mono text-neutral-400">{b.at}</span> · {b.what}
                      </span>
                    ))}
                  </span>
                  <span className="mt-auto pt-2 text-sm font-semibold text-white opacity-60 transition group-hover:opacity-100">Elegir esta →</span>
                </button>
              ))}
            </div>
            {pitchCost && <p className="text-xs text-neutral-600">Estas propuestas: {pitchCost}</p>}
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                value={steer}
                onChange={(e) => setSteer(e.target.value)}
                placeholder="¿Ninguna te convence? Dile qué cambiar: más humor, otro gancho, menos texto…"
                className="flex-1 rounded-xl bg-white/5 px-5 py-3 text-sm ring-1 ring-white/10 placeholder:text-neutral-600 focus:outline-none focus:ring-white/30"
              />
              <button type="button" onClick={() => void pitch(true)} className="rounded-xl bg-white/10 px-5 py-3 text-sm font-semibold transition hover:bg-white/20">
                Otras {count}
              </button>
            </div>
          </Panel>
        )}

        {step === Step.Script && chosen && (
          <Panel key={step} kicker="Paso 5" title="Tu guion" hint="El vídeo se monta sobre esta voz. Retócalo hasta que suene a ti; va en formato ElevenLabs v3.">
            <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
              <textarea
                value={chosen.voiceover}
                onChange={(e) => setChosen({ ...chosen, voiceover: e.target.value })}
                rows={14}
                className="w-full resize-y rounded-2xl bg-white/5 px-6 py-5 font-mono text-sm leading-relaxed ring-1 ring-white/10 focus:outline-none focus:ring-white/30"
              />
              <aside className="flex flex-col gap-3 text-sm text-neutral-400">
                <span className="text-base font-semibold text-white">{chosen.title}</span>
                <span>{chosen.direction}</span>
                <span className="text-xs text-neutral-500">
                  {wordCount(chosen.voiceover)} palabras · ~{Math.round(wordCount(chosen.voiceover) / WORDS_PER_SECOND)} s de voz
                </span>
                <CopyButton text={chosen.voiceover} />
              </aside>
            </div>
            <Next label="Ya tengo el guion" onClick={() => setStep(Step.Voice)} />
          </Panel>
        )}

        {step === Step.Voice && chosen && (
          <Panel key={step} kicker="Paso 6" title="Pon la voz" hint="Pega el guion en ElevenLabs, genera y descarga el mp3. Súbelo aquí y Claude atará cada plano a tus palabras.">
            <VoiceDrop busy={busy} onFile={(f) => void finish(f)} />
            <div className="flex max-w-xl flex-col gap-2">
              <span className="text-sm text-neutral-400">¿Cómo lo montamos?</span>
              <ModePicker prefs={prefs} onChange={updatePrefs} />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button type="button" disabled={busy} onClick={() => void finish(null)} className="self-start text-sm text-neutral-500 underline-offset-4 hover:text-white hover:underline disabled:opacity-50">
              Generar sin voz (usará el guion para los tiempos)
            </button>
          </Panel>
        )}
      </main>
    </div>
  );
}

const WORDS_PER_SECOND = 2.3;

function wordCount(script: string) {
  return script.replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter(Boolean).length;
}

function frameBox(f: VideoFormat) {
  switch (f) {
    case VideoFormat.Vertical:
      return "h-20 w-[45px]";
    case VideoFormat.Portrait:
      return "h-20 w-16";
    case VideoFormat.Square:
      return "size-16";
    case VideoFormat.Horizontal:
      return "h-[45px] w-20";
  }
}

function Panel({ kicker, title, hint, children }: { kicker: string; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-8">
      <div className="wiz-in flex flex-col gap-3">
        <span className="font-mono text-xs text-neutral-500">{kicker}</span>
        <h1 className="text-5xl font-semibold leading-[1.05] sm:text-6xl">{title}</h1>
        <p className="max-w-2xl text-lg text-neutral-400">{hint}</p>
      </div>
      <div className="wiz-in flex flex-col gap-6" style={{ animationDelay: "0.12s" }}>
        {children}
      </div>
    </section>
  );
}

function Next({ label = "Siguiente", onClick, disabled, hint }: { label?: string; onClick: () => void; disabled?: boolean; hint?: string }) {
  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="rounded-full bg-white px-7 py-3.5 text-base font-semibold text-neutral-950 transition hover:scale-[1.03] hover:bg-neutral-200 active:scale-[0.98] disabled:opacity-30 disabled:hover:scale-100"
      >
        {label} →
      </button>
      {hint && <span className="text-xs text-neutral-600">{hint}</span>}
    </div>
  );
}

function Progress({ index, onJump }: { index: number; onJump: (i: number) => void }) {
  return (
    <nav className="relative z-10 mx-auto flex w-full max-w-5xl gap-2 px-8">
      {VISIBLE.map((v, i) => (
        <button key={v.step} type="button" onClick={() => onJump(i)} className="group flex flex-1 flex-col gap-2 text-left" disabled={i >= index}>
          <span className="relative h-1 overflow-hidden rounded-full bg-white/10">
            {i <= index && <span className="absolute inset-0 origin-left rounded-full bg-white" style={{ animation: i === index ? "wiz-bar 0.6s ease-out both" : undefined }} />}
          </span>
          <span className={`text-xs transition ${i === index ? "text-white" : i < index ? "text-neutral-400 group-hover:text-white" : "text-neutral-600"}`}>{v.label}</span>
        </button>
      ))}
    </nav>
  );
}

/** Soft color field that drifts as the user advances. */
function Glow({ index }: { index: number }) {
  const hue = 150 + index * 28;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 transition-all duration-1000">
      <div
        className="wiz-orb absolute -top-40 left-1/2 size-[42rem] -translate-x-1/2 opacity-25 blur-3xl transition-[background] duration-1000"
        style={{ background: `radial-gradient(circle at 30% 30%, hsl(${hue} 80% 55%), transparent 60%), radial-gradient(circle at 70% 70%, hsl(${hue + 60} 80% 55%), transparent 60%)` }}
      />
    </div>
  );
}

function Thinking({ count }: { count: number }) {
  const [line, setLine] = useState(0);
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setLine((l) => (l + 1) % THINKING_LINES.length);
      setTyped(0);
    }, THINKING_LINE_MS);
    return () => clearInterval(t);
  }, []);
  // Typewriter for the current line.
  useEffect(() => {
    const full = THINKING_LINES[line]!.length;
    if (typed >= full) return;
    const t = setTimeout(() => setTyped((n) => n + 1), TYPE_MS);
    return () => clearTimeout(t);
  }, [typed, line]);
  return (
    <section className="flex flex-col gap-10">
      <div className="wiz-in flex flex-col gap-3">
        <span className="font-mono text-xs text-neutral-500">Paso 4</span>
        <h1 className="text-5xl font-semibold leading-[1.05] sm:text-6xl">Componiendo {count === 1 ? "una idea" : `${count} ideas`}</h1>
        <p className="font-mono text-base text-neutral-400">
          {THINKING_LINES[line]!.slice(0, typed)}
          <span className="comp-caret ml-0.5 inline-block h-4 w-2 translate-y-0.5 bg-neutral-300" />
        </p>
      </div>
      <div className={`grid gap-5 ${count > 1 ? "md:grid-cols-2" : ""} ${count > 4 ? "xl:grid-cols-3" : ""}`}>
        {Array.from({ length: count }, (_, i) => (
          <ComposingCard key={i} index={i} />
        ))}
      </div>
    </section>
  );
}

const TYPE_MS = 28;
/** Accent per card, so every idea feels like its own piece. */
const CARD_HUES = [152, 32, 265, 196, 340, 54];

/** A tiny timeline composing itself: tracks draw, keyframes pop, a playhead sweeps, the frame comes alive. */
function ComposingCard({ index }: { index: number }) {
  const hue = CARD_HUES[index % CARD_HUES.length]!;
  const accent = `hsl(${hue} 85% 62%)`;
  const offset = index * 0.37;
  const v = (d: number) => ({ "--d": `${(offset + d).toFixed(2)}s`, "--comp-dur": `${4.6 + (index % 3) * 0.4}s` }) as React.CSSProperties;
  const tracks = [
    { from: 0.05, to: 0.7, keys: [0.05, 0.38, 0.7] },
    { from: 0.18, to: 0.92, keys: [0.18, 0.55] },
    { from: 0.3, to: 0.62, keys: [0.3, 0.62] },
    { from: 0.46, to: 0.98, keys: [0.46, 0.8, 0.98] },
  ];
  return (
    <div className="wiz-in flex gap-5 overflow-hidden rounded-2xl bg-white/[0.04] p-5 ring-1 ring-white/10" style={{ animationDelay: `${0.1 * index}s` }}>
      {/* The frame being animated. */}
      <div className="relative aspect-[9/16] w-28 shrink-0 overflow-hidden rounded-lg bg-neutral-900 ring-1 ring-white/10">
        <div className="comp comp-block absolute top-[18%] left-[12%] h-[16%] w-[76%] rounded-md" style={{ ...v(0), background: accent }} />
        <div className="absolute top-[42%] left-[12%] h-[9%] w-[76%] overflow-hidden">
          <div className="comp comp-word h-full w-[70%] rounded-sm bg-white/80" style={v(0.08)} />
        </div>
        <div className="absolute top-[55%] left-[12%] h-[6%] w-[76%] overflow-hidden">
          <div className="comp comp-word h-full w-[45%] rounded-sm bg-white/40" style={v(0.18)} />
        </div>
        <div className="comp comp-dot absolute bottom-[12%] left-[38%] aspect-square w-[24%] rounded-full" style={{ ...v(0.1), background: `hsl(${hue + 40} 85% 65%)` }} />
      </div>
      {/* Its timeline. */}
      <div className="relative flex flex-1 flex-col justify-center gap-2.5">
        <div className="flex justify-between font-mono text-[9px] text-neutral-600">
          {["0s", "1s", "2s", "3s", "4s"].map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        {tracks.map((t, j) => (
          <div key={j} className="relative h-4">
            <div
              className="comp comp-track absolute inset-y-0 rounded-full"
              style={{ ...v(j * 0.12), left: `${t.from * 100}%`, width: `${(t.to - t.from) * 100}%`, background: j === 0 ? accent : `hsl(${hue} 30% ${38 - j * 4}%)` }}
            />
            {t.keys.map((k, n) => (
              <span
                key={n}
                className="comp comp-key absolute top-1/2 -mt-1 -ml-1 size-2 bg-white"
                style={{ ...v(j * 0.12 + n * 0.09), left: `${k * 100}%` }}
              />
            ))}
          </div>
        ))}
        <span className="comp comp-head absolute top-0 bottom-0 w-px" style={{ ...v(0), background: accent, boxShadow: `0 0 12px ${accent}` }} />
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
      className="mt-2 rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/20"
    >
      {copied ? "Copiado ✓" : "Copiar para ElevenLabs"}
    </button>
  );
}

function VoiceDrop({ busy, onFile }: { busy: boolean; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      onClick={() => !busy && input.current?.click()}
      className={`flex cursor-pointer flex-col items-center gap-3 rounded-3xl border-2 border-dashed px-8 py-16 text-center transition ${
        over ? "scale-[1.01] border-white bg-white/10" : "border-white/15 bg-white/[0.02] hover:border-white/40"
      }`}
    >
      <input ref={input} type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <span className="text-2xl font-semibold">{busy ? "Preparando tu vídeo…" : "Suelta aquí el mp3 de ElevenLabs"}</span>
      <span className="text-sm text-neutral-500">{busy ? "Subiendo la voz y abriendo el editor" : "o haz clic para elegirlo"}</span>
    </div>
  );
}

/** Which Claude model and effort the agent uses (shared with the editor's Generar). */
function AgentPicker({ prefs, onChange, label = "Claude que pensará las ideas" }: { prefs: AgentPrefs; onChange: (p: Partial<AgentPrefs>) => void; label?: string }) {
  const select = "rounded-xl bg-white/5 px-4 py-2.5 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-white/30";
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-400">
      <span>{label}</span>
      <select value={prefs.model} onChange={(e) => onChange({ model: e.target.value as AgentModel })} className={select} aria-label="Modelo">
        {Object.values(AgentModel).map((m) => (
          <option key={m} value={m}>
            {MODEL_LABEL[m]}
          </option>
        ))}
      </select>
      <select value={prefs.effort} onChange={(e) => onChange({ effort: e.target.value as AgentEffort })} className={select} aria-label="Esfuerzo">
        {Object.values(AgentEffort).map((x) => (
          <option key={x} value={x}>
            Esfuerzo: {EFFORT_LABEL[x]}
          </option>
        ))}
      </select>
    </div>
  );
}
