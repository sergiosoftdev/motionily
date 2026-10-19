import type { AgentRunUsage } from "@motionily/protocol";
import { GENERATE_EVENT, takePipeline, VideoPipeline } from "../pipeline";
import { useEffect, useRef, useState } from "react";
import { ReferenceStrip, useReferences } from "./References";
import { api } from "../api/client";

export const GenerateStatus = { Idle: "idle", Running: "running", Done: "done", Failed: "failed", Stopped: "stopped" } as const;
export type GenerateStatus = (typeof GenerateStatus)[keyof typeof GenerateStatus];
export const GenerateEventKind = { Tool: "tool", Text: "text", Error: "error" } as const;
export type GenerateEventKind = (typeof GenerateEventKind)[keyof typeof GenerateEventKind];
export type GenerateState = {
  status: GenerateStatus;
  events: { at: string; kind: GenerateEventKind; text: string }[];
  summary: string | null;
  usage: AgentRunUsage | null;
};

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const dollars = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;

/** One line of what a run cost: cost, output, fresh input, cached input, turns, time. */
export function usageLine(u: AgentRunUsage) {
  return `${dollars(u.costUsd)} · ${tokens(u.outputTokens)} escritos · ${tokens(u.inputTokens + u.cacheWriteTokens)} leídos + ${tokens(u.cacheReadTokens)} en caché · ${u.turns} pasos · ${Math.round(u.durationMs / 1000)} s`;
}

/** Total spent on a video across every agent run. */
export function UsageSummary({ runs }: { runs: AgentRunUsage[] }) {
  if (!runs.length) return null;
  const total = runs.reduce((s, r) => s + r.costUsd, 0);
  const last = runs[runs.length - 1]!;
  return (
    <details className="text-xs text-neutral-500">
      <summary className="cursor-pointer hover:text-neutral-300">
        Coste del vídeo: {dollars(total)} en {runs.length} {runs.length === 1 ? "ejecución" : "ejecuciones"} · última: {usageLine(last)}
      </summary>
      <ol className="mt-2 flex flex-col gap-1">
        {runs.map((r, i) => (
          <li key={i}>
            <span className="text-neutral-400">{r.kind === "edit" ? "Cambio" : "Generar"}</span> {r.model ?? ""} {r.effort ?? ""} · {usageLine(r)}
          </li>
        ))}
      </ol>
    </details>
  );
}

const POLL_MS = 1500;
const PREFS_KEY = "motionily.agent";

export const AgentModel = { Fable: "fable", Opus: "opus", Sonnet: "sonnet", Haiku: "haiku" } as const;
export type AgentModel = (typeof AgentModel)[keyof typeof AgentModel];
export const AgentEffort = { Low: "low", Medium: "medium", High: "high", XHigh: "xhigh", Max: "max" } as const;
export type AgentEffort = (typeof AgentEffort)[keyof typeof AgentEffort];
export type AgentPrefs = { model: AgentModel; effort: AgentEffort };

export const MODEL_LABEL: Record<AgentModel, string> = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
export const EFFORT_LABEL: Record<AgentEffort, string> = { low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Muy alto", max: "Máximo" };

export function loadPrefs(): AgentPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return JSON.parse(raw) as AgentPrefs;
  } catch {
    // Storage unavailable: defaults.
  }
  return { model: AgentModel.Opus, effort: AgentEffort.High };
}

export function savePrefs(p: AgentPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Not critical.
  }
}

/** What each agent tool means, in the user's words. */
export const TOOL_LABEL: Record<string, string> = {
  get_project: "Lee tu brief y tu estilo",
  get_reference: "Repasa cómo se construye una escena",
  list_bricks: "Mira las opciones disponibles",
  get_brick: "Estudia una opción",
  get_scene: "Revisa la escena",
  get_layer: "Revisa un elemento",
  load_scene: "Monta el primer corte",
  apply_ops: "Ajusta el vídeo",
  render_frames: "Mira cómo queda",
  create_brick: "Crea una animación nueva",
  get_feedback: "Lee tus comentarios",
  set_option: "Cambia una opción del vídeo",
  list_prefabs: "Revisa tu biblioteca 3D",
  get_prefab: "Estudia un prefab",
  save_prefab: "Construye y guarda un prefab",
  clone_prefab: "Duplica un prefab",
  list_templates: "Mira las plantillas",
  apply_template: "Aplica una plantilla",
  review_video: "Revisa el vídeo entero",
  get_brand: "Lee el kit de marca",
  view_asset: "Mira una imagen de la marca",
  set_format: "Cambia el formato",
  ToolSearch: "Prepara sus herramientas",
};

/** The main action of the editor: let the agent build or change the video, no terminal needed. */
export function GeneratePanel({ projectId, hasScene, runs = [] }: { projectId: string; hasScene: boolean; runs?: AgentRunUsage[] }) {
  const [state, setState] = useState<GenerateState | null>(null);
  const [instruction, setInstruction] = useState("");
  const refs = useReferences();
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<AgentPrefs>(loadPrefs);
  const updatePrefs = (p: Partial<AgentPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    savePrefs(next);
  };
  const running = state?.status === GenerateStatus.Running;

  useEffect(() => {
    let alive = true;
    const tick = () => api.generateStatus(projectId).then((s) => alive && setState(s), () => undefined);
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectId]);

  // Videos fresh from the wizard start by themselves (after their captions, if they have a voice).
  const startRef = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    if (takePipeline(projectId, VideoPipeline.Generate)) void startRef.current();
    const onGo = (e: Event) => (e as CustomEvent<string>).detail === projectId && void startRef.current();
    window.addEventListener(GENERATE_EVENT, onGo);
    return () => window.removeEventListener(GENERATE_EVENT, onGo);
  }, [projectId]);

  const start = async () => {
    setError(null);
    try {
      setState(await api.generate(projectId, instruction, prefs, refs.refs));
      refs.clear();
      setInstruction("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  startRef.current = start;

  const steps = (state?.events ?? []).filter((e) => e.kind !== GenerateEventKind.Text).slice(-6);
  const lastThought = [...(state?.events ?? [])].reverse().find((e) => e.kind === GenerateEventKind.Text);

  return (
    <section className="flex flex-col gap-3">
      {hasScene && !running && (
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void start()}
          placeholder="Pide un cambio: «más ritmo», «título más grande»… (⌘V pega imágenes)"
          className="rounded-lg bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
          {...refs.handlers}
        />
      )}
      {hasScene && !running && <ReferenceStrip r={refs} />}
      {!running && (
        <div className="flex gap-2 text-xs">
          <select
            value={prefs.model}
            onChange={(e) => updatePrefs({ model: e.target.value as AgentModel })}
            aria-label="Modelo"
            className="flex-1 rounded-lg bg-neutral-900 px-2 py-1.5 text-neutral-300 focus:outline-none"
          >
            {Object.values(AgentModel).map((m) => (
              <option key={m} value={m}>
                {MODEL_LABEL[m]}
              </option>
            ))}
          </select>
          <select
            value={prefs.effort}
            onChange={(e) => updatePrefs({ effort: e.target.value as AgentEffort })}
            aria-label="Esfuerzo"
            className="flex-1 rounded-lg bg-neutral-900 px-2 py-1.5 text-neutral-300 focus:outline-none"
          >
            {Object.values(AgentEffort).map((x) => (
              <option key={x} value={x}>
                Esfuerzo: {EFFORT_LABEL[x]}
              </option>
            ))}
          </select>
        </div>
      )}
      {running ? (
        <button
          type="button"
          onClick={() => void api.stopGenerate(projectId).then(setState)}
          className="rounded-lg bg-neutral-800 px-4 py-2.5 text-sm font-semibold hover:bg-neutral-700"
        >
          Parar al agente
        </button>
      ) : (
        <button type="button" onClick={() => void start()} className="rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
          {hasScene ? (instruction.trim() ? "Aplicar cambio" : "Volver a generar") : "Generar vídeo"}
        </button>
      )}
      {running && (
        <div className="flex flex-col gap-1.5 text-xs">
          <span className="flex items-center gap-2 text-neutral-300">
            <span className="size-2 animate-pulse rounded-full bg-emerald-400" /> El agente está trabajando…
          </span>
          {steps.map((e, i) => (
            <span key={i} className={e.kind === GenerateEventKind.Error ? "text-red-400" : "text-neutral-500"}>
              {TOOL_LABEL[e.text] ?? e.text}
            </span>
          ))}
          {lastThought && <span className="line-clamp-3 text-neutral-400">{lastThought.text}</span>}
        </div>
      )}
      {!running && state?.summary && state.status === GenerateStatus.Done && <p className="text-xs text-neutral-400">{state.summary}</p>}
      <UsageSummary runs={state?.usage && !runs.some((r) => r.at === state.usage!.at) ? [...runs, state.usage] : runs} />
      {!running && state?.status === GenerateStatus.Failed && (
        <p className="text-xs text-red-400">{state.events.filter((e) => e.kind === GenerateEventKind.Error).at(-1)?.text ?? "El agente falló."}</p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </section>
  );
}
