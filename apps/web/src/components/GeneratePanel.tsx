import type { AgentRunUsage } from "@motionily/protocol";
import type { GenerationMode } from "./ModePicker";

export const GenerateStatus = { Idle: "idle", Running: "running", Done: "done", Failed: "failed", Stopped: "stopped", Interrupted: "interrupted" } as const;
export type GenerateStatus = (typeof GenerateStatus)[keyof typeof GenerateStatus];
export const GenerateEventKind = { Tool: "tool", Text: "text", Error: "error", Phase: "phase", Plan: "plan", Done: "done" } as const;
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
        Gastado en este vídeo: {dollars(total)} · {runs.length} {runs.length === 1 ? "ejecución" : "ejecuciones"} · última {dollars(last.costUsd)}
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

const PREFS_KEY = "motionily.agent";

export const AgentModel = { Fable: "fable", Opus: "opus", Sonnet: "sonnet", Haiku: "haiku" } as const;
export type AgentModel = (typeof AgentModel)[keyof typeof AgentModel];
export const AgentEffort = { Low: "low", Medium: "medium", High: "high", XHigh: "xhigh", Max: "max" } as const;
export type AgentEffort = (typeof AgentEffort)[keyof typeof AgentEffort];
export type AgentPrefs = { model: AgentModel; effort: AgentEffort; mode?: GenerationMode };

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
  add_layers: "Dibuja capas",
  get_group: "Lee un grupo",
  define_component: "Crea un componente reutilizable",
  get_component: "Revisa un componente",
  view_image: "Mira una referencia",
  get_brand: "Lee el kit de marca",
  view_asset: "Mira una imagen de la marca",
  set_format: "Cambia el formato",
  ToolSearch: "Prepara sus herramientas",
};
