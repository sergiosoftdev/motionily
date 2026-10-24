import { useEffect, useRef, useState, type ReactNode } from "react";
import { VideoFormat, type Voice, type VoiceModel } from "@motionily/protocol";
import { FORMAT_OPTIONS } from "../components/FormatPicker";
import { Logo } from "../components/Logo";
import { api, type Concept } from "../api/client";
import { href, navigate, BrandTab, RouteName } from "../router";
import { requestPipeline, VideoPipeline } from "../pipeline";
import { ReferenceStrip, useReferences } from "../components/References";
import { ModePicker } from "../components/ModePicker";
import { VoicePicker } from "../voice/ElevenLabs";
import { AgentEffort, AgentModel, loadPrefs, savePrefs, type AgentPrefs } from "../components/GeneratePanel";
import { AttentionCurve } from "../components/AttentionCurve";
import { useAgentName } from "../agentName";

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
  { step: Step.Format, label: "Format" },
  { step: Step.Count, label: "Ideas" },
  { step: Step.Pick, label: "Angle" },
  { step: Step.Script, label: "Script" },
  { step: Step.Voice, label: "Voice" },
];
const COUNTS = [1, 2, 3, 4, 5, 6];

const THINKING_LINES = [
  "Reading your brand kit…",
  "Looking for scroll-stopping hooks…",
  "Trying different visual metaphors…",
  "Writing scripts with a spoken rhythm…",
  "Laying the shots out in time…",
];
const THINKING_LINE_MS = 2600;

/**
 * New video, the clinily-spots way, as a guided full-screen flow: idea, format, how many concepts,
 * pick one, polish its ElevenLabs script, add the voice. The video is then built on that voice.
 */
export function NewProjectScreen({ brandId }: { brandId: string }) {
  const agent = useAgentName();
  const [step, setStep] = useState<Step>(Step.Idea);
  const [idea, setIdea] = useState("");
  const refs = useReferences();
  const [format, setFormat] = useState<VideoFormat>(VideoFormat.Vertical);
  const [count, setCount] = useState(3);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [pitchCost, setPitchCost] = useState<string | null>(null);
  /** Ideas still being written. */
  const [pending, setPending] = useState(0);
  /** Pitch with Opus (slower, deeper) instead of the quick Sonnet pass. */
  const [deep, setDeep] = useState(false);
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

  /**
   * One request per idea, all at once, each with its own angle: it takes as long as a single idea,
   * and every card shows up as soon as it is ready.
   */
  const pitch = async (again = false) => {
    setStep(Step.Thinking);
    setError(null);
    setConcepts([]);
    setPending(count);
    const agent = deep ? { model: AgentModel.Opus, effort: AgentEffort.Medium } : { model: AgentModel.Sonnet, effort: AgentEffort.Low };
    const base = { idea: idea, format, count, steer: again ? steer : undefined, avoid: again ? seen : undefined, references: refs.refs, ...agent };
    let cost = 0;
    let failed = 0;
    await Promise.all(
      Array.from({ length: count }, (_, angle) =>
        api
          .concepts(brandId, { ...base, angle })
          .then(({ concepts: [c], usage }) => {
            cost += usage?.costUsd ?? 0;
            if (!c) return;
            setConcepts((cs) => [...cs, c]);
            setSeen((s) => [...s, c.title]);
            setStep(Step.Pick);
          })
          .catch((e: Error) => {
            failed += 1;
            setError(e.message);
          })
          .finally(() => setPending((n) => n - 1)),
      ),
    );
    setPitchCost(cost ? `${cost.toFixed(2).replace(".", ",")} $` : null);
    setSteer("");
    if (failed === count) setStep(Step.Count);
  };

  /** The video, once created: a failed voice is retried on it instead of creating another. */
  const created = useRef<string | null>(null);
  const create = async (c: Concept) => (created.current ??= (await api.createProject(c.title.slice(0, 80), c.prompt, format, brandId, c.voiceover, refs.refs)).id);

  /** Open the editor on the new video; with a voice, it captions it first and then builds. */
  const open = async (addVoice: (id: string) => Promise<unknown> | null) => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const id = await create(chosen);
      const voiced = addVoice(id);
      if (voiced) await voiced;
      requestPipeline(id, voiced ? VideoPipeline.TranscribeThenGenerate : VideoPipeline.Generate);
      navigate({ name: RouteName.Editor, id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const finish = (voice: File | null) => open((id) => (voice ? api.uploadAudio(id, voice) : null));
  /** ElevenLabs reads the script with the user's voice: every word comes timed. */
  const finishWithVoice = (voice: Voice, model: VoiceModel) =>
    open((id) => api.generateVoice(id, { voiceId: voice.id, voiceName: voice.name, modelId: model, text: chosen?.voiceover }));

  const current = step === Step.Thinking ? Step.Pick : step;
  const index = VISIBLE.findIndex((v) => v.step === current);

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-neutral-950 text-white">
      <Glow index={index} />
      <header className="relative z-10 flex items-center justify-between px-8 py-6">
        <Logo />
        <a href={back} className="text-sm text-neutral-500 hover:text-white">
          Exit
        </a>
      </header>
      <Progress index={index} onJump={(i) => i < index && step !== Step.Thinking && setStep(VISIBLE[i]!.step)} />

      <main className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col px-8 pt-[12vh] pb-16">
        {step === Step.Idea && (
          <Panel key={step} kicker="Step 1" title="What do you want to say?" hint={`In your own words: who it's for, what problem it solves, what tone. ${agent} takes care of the rest.`}>
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && idea.trim() && setStep(Step.Format)}
              rows={5}
              autoFocus
              placeholder="E.g. a reel for physical therapists who lose slots to last-minute cancellations; with the waitlist they fill themselves. Warm, with humor. (Paste or drop reference images or videos)"
              {...refs.handlers}
              className="w-full resize-none rounded-2xl bg-white/5 px-6 py-5 text-lg leading-relaxed ring-1 ring-white/10 transition placeholder:text-neutral-600 focus:bg-white/[0.07] focus:outline-none focus:ring-white/30"
            />
            <ReferenceStrip r={refs} />
            <Next disabled={!idea.trim() || refs.uploading} onClick={() => setStep(Step.Format)} hint="⌘ + Enter" />
          </Panel>
        )}

        {step === Step.Format && (
          <Panel key={step} kicker="Step 2" title="Where will it be watched?" hint="It changes the whole composition, so better decide now.">
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
          <Panel key={step} kicker="Step 3" title="How many ideas do you want to see?" hint="Each one is a different angle, with its own ElevenLabs script. More ideas take a little longer.">
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
            <label className="flex cursor-pointer items-center gap-3 text-sm text-neutral-400">
              <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} className="size-4 accent-white" />
              Think the ideas through (Opus, slower) — by default they are quick (~20 s)
            </label>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <Next label={`Pitch ${count === 1 ? "one idea" : `${count} ideas`}`} onClick={() => void pitch()} />
          </Panel>
        )}

        {step === Step.Thinking && <Thinking count={count} />}

        {step === Step.Pick && (
          <Panel key={`pick-${seen.length}`} kicker="Step 4" title="Pick an angle" hint="They all tell your idea, each in its own way. You can tweak the script in the next step.">
            <div className={`grid gap-5 ${count > 1 ? "md:grid-cols-2" : ""} ${count > 4 ? "xl:grid-cols-3" : ""}`}>
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
                  <PlannedCurve beats={c.beats} />
                  <span className="mt-1 flex flex-col gap-1.5 border-t border-white/10 pt-4 text-xs text-neutral-500">
                    {c.beats.map((b, j) => (
                      <span key={j}>
                        <span className="font-mono text-neutral-400">{b.at}</span> · {b.what}
                        {b.device && <span className="ml-1.5 rounded-full bg-white/5 px-1.5 py-px font-mono text-[10px] text-neutral-400">{b.device.replace(/_/g, " ")}</span>}
                      </span>
                    ))}
                  </span>
                  <span className="mt-auto pt-2 text-sm font-semibold text-white opacity-60 transition group-hover:opacity-100">Pick this one →</span>
                </button>
              ))}
              {Array.from({ length: pending }, (_, i) => (
                <ComposingCard key={`pending-${i}`} index={concepts.length + i} />
              ))}
            </div>
            {pitchCost && <p className="text-xs text-neutral-600">These pitches: {pitchCost}</p>}
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                value={steer}
                onChange={(e) => setSteer(e.target.value)}
                placeholder="None of them? Tell it what to change: more humor, another hook, less text…"
                className="flex-1 rounded-xl bg-white/5 px-5 py-3 text-sm ring-1 ring-white/10 placeholder:text-neutral-600 focus:outline-none focus:ring-white/30"
              />
              <button type="button" onClick={() => void pitch(true)} className="rounded-xl bg-white/10 px-5 py-3 text-sm font-semibold transition hover:bg-white/20">
                {count} more
              </button>
            </div>
          </Panel>
        )}

        {step === Step.Script && chosen && (
          <Panel key={step} kicker="Step 5" title="Your script" hint="The video is built on this voice. Tweak it until it sounds like you; it's in ElevenLabs v3 format.">
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
                  {wordCount(chosen.voiceover)} words · ~{Math.round(wordCount(chosen.voiceover) / WORDS_PER_SECOND)} s of voice
                </span>
                <CopyButton text={chosen.voiceover} />
              </aside>
            </div>
            <Next label="I have my script" onClick={() => setStep(Step.Voice)} />
          </Panel>
        )}

        {step === Step.Voice && chosen && (
          <Panel key={step} kicker="Step 6" title="Add the voice" hint="Pick one of your ElevenLabs voices and Motionily reads the script for you, every word timed. Or drop a recording you already have.">
            <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
              <div className="flex flex-col gap-4 rounded-3xl bg-white/[0.03] p-6 ring-1 ring-white/10">
                <span className="text-xl font-semibold">Generate it with ElevenLabs</span>
                <VoicePicker cta="Generate the voice and build" busy={busy} onGenerate={(v, m) => void finishWithVoice(v, m)} />
              </div>
              <VoiceDrop busy={busy} onFile={(f) => void finish(f)} />
            </div>
            <div className="flex max-w-xl flex-col gap-2">
              <span className="text-sm text-neutral-400">How should we build it?</span>
              <ModePicker prefs={prefs} onChange={updatePrefs} />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button type="button" disabled={busy} onClick={() => void finish(null)} className="self-start text-sm text-neutral-500 underline-offset-4 hover:text-white hover:underline disabled:opacity-50">
              Generate without a voice (the script sets the timing)
            </button>
          </Panel>
        )}
      </main>
    </div>
  );
}

const WORDS_PER_SECOND = 2.3;

/** First number of a beat's "at" ("0-1.5s" → 0). */
const beatStart = (at: string) => Number.parseFloat(at.replace(",", "."));

/** The concept's planned attention curve, from its beats' energy (the sawtooth Reels and TikTok need). */
function PlannedCurve({ beats }: { beats: Concept["beats"] }) {
  const tagged = beats.filter((b) => b.energy !== undefined);
  if (tagged.length < 2) return null;
  const starts = tagged.map((b) => beatStart(b.at));
  const at = starts.every(Number.isFinite) ? starts : undefined;
  return (
    <span className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-neutral-500">Attention curve</span>
      <AttentionCurve values={tagged.map((b) => b.energy! / 100)} at={at} floor={0.3} dots className="h-12 w-full text-emerald-300" />
    </span>
  );
}

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

function Next({ label = "Next", onClick, disabled, hint }: { label?: string; onClick: () => void; disabled?: boolean; hint?: string }) {
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
        <span className="font-mono text-xs text-neutral-500">Step 4</span>
        <h1 className="text-5xl font-semibold leading-[1.05] sm:text-6xl">Composing {count === 1 ? "one idea" : `${count} ideas`}</h1>
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
      {copied ? "Copied ✓" : "Copy for ElevenLabs"}
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
      <span className="text-2xl font-semibold">{busy ? "Preparing your video…" : "Drop your recording here"}</span>
      <span className="text-sm text-neutral-500">{busy ? "Adding the voice and opening the editor" : "mp3, wav or a video · or click to choose it"}</span>
    </div>
  );
}

