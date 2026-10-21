import { useState } from "react";
import { GenerateEventKind, GenerateStatus, TOOL_LABEL } from "../components/GeneratePanel";
import type { Generation } from "../components/useGenerate";
import type { CaptionProgress } from "../captions/voiceCaptions";

/** "Reading the audio… 40%" */
export const captioningLabel = (p: CaptionProgress) => `${p.label}${p.ratio !== null ? ` ${Math.round(p.ratio * 100)}%` : ""}`;

/** One line of what the agent is doing or just did, above Simple mode's request box. */
export function AgentLine({ g, captioning }: { g: Generation; captioning: CaptionProgress | null }) {
  const { state, running } = g;
  const [open, setOpen] = useState(false);
  if (captioning)
    return (
      <div className="flex items-center gap-3 px-1 text-sm">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />
        <span className="min-w-0 flex-1 truncate text-neutral-300">{captioningLabel(captioning)}</span>
      </div>
    );
  if (!state) return null;
  const last = [...state.events].reverse().find((e) => e.kind === GenerateEventKind.Tool || e.kind === GenerateEventKind.Text || e.kind === GenerateEventKind.Phase);

  if (running)
    return (
      <div className="flex items-center gap-3 px-1 text-sm">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />
        <span className="min-w-0 flex-1 truncate text-neutral-300">{last ? (TOOL_LABEL[last.text] ?? last.text) : "Getting started…"}</span>
        <button type="button" onClick={g.stop} className="shrink-0 rounded-md px-2.5 py-1 text-xs text-neutral-400 ring-1 ring-white/15 hover:text-white">
          Stop
        </button>
      </div>
    );
  if (state.status === GenerateStatus.Failed)
    return <p className="px-1 text-sm text-red-400">{state.events.filter((e) => e.kind === GenerateEventKind.Error).at(-1)?.text ?? "The agent failed."}</p>;
  if (state.status === GenerateStatus.Interrupted)
    return <p className="px-1 text-sm text-amber-200/90">The server restarted and the agent stopped (it isn't spending). Ask again to continue.</p>;
  if (state.status === GenerateStatus.Done && state.summary)
    return (
      <button type="button" onClick={() => setOpen((o) => !o)} className={`px-1 text-left text-sm text-neutral-400 hover:text-neutral-200 ${open ? "" : "line-clamp-2"}`}>
        <span className="text-emerald-400">Done · </span>
        {state.summary}
      </button>
    );
  return null;
}
