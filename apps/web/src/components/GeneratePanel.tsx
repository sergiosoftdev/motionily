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
  return `${dollars(u.costUsd)} · ${tokens(u.outputTokens)} written · ${tokens(u.inputTokens + u.cacheWriteTokens)} read + ${tokens(u.cacheReadTokens)} cached · ${u.turns} steps · ${Math.round(u.durationMs / 1000)} s`;
}

/** Total spent on a video across every agent run. */
export function UsageSummary({ runs }: { runs: AgentRunUsage[] }) {
  if (!runs.length) return null;
  const total = runs.reduce((s, r) => s + r.costUsd, 0);
  const last = runs[runs.length - 1]!;
  return (
    <details className="text-xs text-neutral-500">
      <summary className="cursor-pointer hover:text-neutral-300">
        Spent on this video: {dollars(total)} · {runs.length} {runs.length === 1 ? "run" : "runs"} · last {dollars(last.costUsd)}
      </summary>
      <ol className="mt-2 flex flex-col gap-1">
        {runs.map((r, i) => (
          <li key={i}>
            <span className="text-neutral-400">{r.kind === "edit" ? "Edit" : "Generate"}</span> {r.model ?? ""} {r.effort ?? ""} · {usageLine(r)}
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
export const EFFORT_LABEL: Record<AgentEffort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Very high", max: "Max" };

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
  get_project: "Reads your brief and style",
  get_reference: "Reviews how a scene is built",
  list_bricks: "Looks at the available options",
  get_brick: "Studies an option",
  inspect: "Checks the scene or an element",
  load_scene: "Builds the first cut",
  apply_ops: "Adjusts the video",
  render_frames: "Looks at the result",
  create_brick: "Creates a new animation",
  get_feedback: "Reads your comments",
  set_option: "Changes a video option",
  list_prefabs: "Checks your 3D library",
  get_prefab: "Studies a prefab",
  save_prefab: "Builds and saves a prefab",
  clone_prefab: "Copies a prefab",
  list_templates: "Looks at the templates",
  apply_template: "Applies a template",
  review_video: "Reviews the whole video",
  add_layers: "Draws layers",
  edit_layers: "Restyles layers",
  checkpoint: "Saves or restores a version",
  next_step: "Decides the next step",
  examples: "Looks at approved videos",
  define_component: "Makes a reusable component",
  get_component: "Checks a component",
  view_image: "Looks at a reference",
  get_brand: "Reads the brand kit",
  view_asset: "Looks at a brand image",
  search_assets: "Looks for real photos, logos and footage",
  import_assets: "Saves the chosen material",
  cut_out: "Cuts out a subject",
  add_vector: "Places a logo as vectors",
  add_map: "Draws a map",
  list_library: "Checks your library",
  generate_image: "Generates an image",
  set_direction: "Decides the look",
  find_icons: "Looks for icons",
  set_format: "Changes the format",
  ToolSearch: "Gets its tools ready",
};
