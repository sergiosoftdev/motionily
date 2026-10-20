import type { AgentRunUsage } from "@motionily/protocol";
import { AgentWorkshop } from "./AgentWorkshop";
import { GenerateEventKind, GenerateStatus, TOOL_LABEL, UsageSummary } from "./GeneratePanel";
import { ModePicker } from "./ModePicker";
import type { Generation } from "./useGenerate";

/**
 * Top of the sidebar, always in view: what the agent is doing and the main action.
 * Idle: generate + mode. Working: progress + stop. Done: what it made and what it cost.
 */
export function AgentBar({ g, hasScene, runs }: { g: Generation; hasScene: boolean; runs: AgentRunUsage[] }) {
  const { state, running } = g;
  const steps = (state?.events ?? []).filter((e) => e.kind !== GenerateEventKind.Text).slice(-4);
  const thought = [...(state?.events ?? [])].reverse().find((e) => e.kind === GenerateEventKind.Text);
  const allRuns = state?.usage && !runs.some((r) => r.at === state.usage!.at) ? [...runs, state.usage] : runs;

  if (running && state) {
    return (
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-medium">
            <span className="size-2 animate-pulse rounded-full bg-emerald-400" /> Generating
          </span>
          <button type="button" onClick={g.stop} className="rounded-md px-2.5 py-1 text-xs text-neutral-300 ring-1 ring-white/15 hover:bg-white/5 hover:text-white">
            Stop
          </button>
        </div>
        {g.resumed && <p className="text-xs text-emerald-300/80">It kept working while you were away; you can close or reload.</p>}
        {state.events.some((e) => e.kind === GenerateEventKind.Phase) ? (
          <AgentWorkshop state={state} />
        ) : (
          <div className="flex flex-col gap-1 text-xs">
            {steps.map((e, i) => (
              <span key={i} className={e.kind === GenerateEventKind.Error ? "text-red-400" : "text-neutral-500"}>
                {TOOL_LABEL[e.text] ?? e.text}
              </span>
            ))}
            {thought && <span className="line-clamp-2 text-neutral-400">{thought.text}</span>}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {state?.status === GenerateStatus.Interrupted && (
        <p className="text-xs text-amber-200/90">It stopped because the server restarted (the agents were stopped and aren't spending). Generate again to resume.</p>
      )}
      {state?.status === GenerateStatus.Failed && (
        <p className="text-xs text-red-400">{state.events.filter((e) => e.kind === GenerateEventKind.Error).at(-1)?.text ?? "The agent failed."}</p>
      )}
      {state?.status === GenerateStatus.Done && state.summary && <p className="line-clamp-4 text-xs leading-relaxed text-neutral-400">{state.summary}</p>}
      <ModePicker prefs={g.prefs} onChange={g.updatePrefs} />
      <button type="button" onClick={() => void g.start()} className="rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
        {hasScene ? "Regenerate from scratch" : "Generate video"}
      </button>
      {g.error && <p className="text-xs text-red-400">{g.error}</p>}
      <UsageSummary runs={allRuns} />
    </section>
  );
}
