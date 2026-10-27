import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAgentName } from "../../agentName";
import type { CaptionProgress } from "../../captions/voiceCaptions";
import type { Generation } from "../../components/useGenerate";
import { AgentLine } from "../AgentLine";
import { ModePiece } from "../mode";
import { Spark } from "./ClaudePanel";

/** Per-viewer: the agent's panel is open (it is, until closed once). */
const DOCK_KEY = "motionily.agentDock";

/** The agent's panel open or closed, remembered between visits. */
export function useAgentDock(): [boolean, (open: boolean | ((was: boolean) => boolean)) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(DOCK_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const set = (v: boolean | ((was: boolean) => boolean)) =>
    setOpen((was) => {
      const now = typeof v === "function" ? v(was) : v;
      try {
        localStorage.setItem(DOCK_KEY, now ? "open" : "closed");
      } catch {
        // Not remembered.
      }
      return now;
    });
  return [open, set];
}

const panel = "flex shrink-0 flex-col overflow-hidden rounded-2xl bg-neutral-900/50 ring-1 ring-white/[0.06]";

/** Edit mode's Inspector: what is selected, or the project's settings. Always there, like an editor's. */
export function InspectorPanel({ children, title }: { children: ReactNode; title: string }) {
  return (
    <aside className={`${panel} w-[340px] ${ModePiece.Right}`}>
      <h2 className="px-4 pt-3.5 pb-1 text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">{title}</h2>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-1 pb-4">{children}</div>
    </aside>
  );
}

/** The conversation with the agent, a panel that opens and closes (runs take a while; the edit needs the room). */
export function AgentDock({ children, running, onClose }: { children: ReactNode; running: boolean; onClose: () => void }) {
  const agent = useAgentName();
  return (
    <aside className={`${panel} w-[360px] ${ModePiece.Right}`}>
      <header className="flex items-center gap-2 px-4 pt-3 pb-1">
        <Spark className="size-3.5 text-white" />
        <span className="text-sm font-semibold">{agent}</span>
        {running && <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" aria-label="Working" />}
        <button type="button" onClick={onClose} title="Close (⌘J)" aria-label={`Close ${agent}`} className="ml-auto flex size-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-white">
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      {children}
    </aside>
  );
}

/** The header's switch for the agent's panel: lit while open, a pulse while it works. */
export function AgentToggle({ open, running, onToggle }: { open: boolean; running: boolean; onToggle: () => void }) {
  const agent = useAgentName();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      title={`${open ? "Hide" : "Show"} ${agent} (⌘J)`}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ring-1 transition-colors ${open ? "bg-white/10 text-white ring-white/15" : "text-neutral-400 ring-white/10 hover:bg-white/5 hover:text-white"}`}
    >
      <Spark className="size-3.5" />
      {agent}
      {running && <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" aria-label="Working" />}
    </button>
  );
}

/**
 * With the panel closed, what the agent is doing floats over the viewer in one line (and what it did,
 * once it finishes, until read): the run is followed without giving it the room.
 */
export function AgentPill({ g, captioning, onOpen }: { g: Generation; captioning: CaptionProgress | null; onOpen: () => void }) {
  const [unread, setUnread] = useState(false);
  const was = useRef(g.running);
  useEffect(() => {
    if (was.current && !g.running) setUnread(true);
    was.current = g.running;
  }, [g.running]);
  if (!g.running && !captioning && !unread) return null;
  return (
    <div className="pointer-events-auto absolute top-2 left-1/2 z-30 flex w-[min(460px,90%)] -translate-x-1/2 items-center gap-2 rounded-2xl bg-neutral-900/95 py-2 pr-2 pl-3 shadow-2xl ring-1 shadow-black/60 ring-white/10 backdrop-blur">
      <div className="min-w-0 flex-1">
        <AgentLine g={g} captioning={captioning} />
      </div>
      <button
        type="button"
        onClick={() => {
          setUnread(false);
          onOpen();
        }}
        className="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-neutral-200 ring-1 ring-white/15 hover:bg-white/10"
      >
        Open
      </button>
      {!g.running && !captioning && (
        <button type="button" onClick={() => setUnread(false)} aria-label="Dismiss" className="flex size-6 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:text-white">
          <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
    </div>
  );
}
