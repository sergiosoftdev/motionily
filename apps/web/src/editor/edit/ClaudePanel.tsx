import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import { AskBox, AskVariant } from "../../components/AskBox";
import { GenerateStatus } from "../../components/GeneratePanel";
import { ReferenceThumbs } from "../../components/References";
import { ActivitySource, useEditor, type Activity } from "../../store";
import { AgentLine } from "../AgentLine";
import type { EditorProps } from "../context";
import { ModePiece } from "../mode";
import { useAgentName } from "../../agentName";

/** Agent steps shown under an ask before "N earlier steps". */
const STEPS_SHOWN = 3;

/** One-click starts, put in the box (never sent on their own: every run costs). */
const SUGGESTIONS_FOOTAGE = ["Cut the pauses and filler words", "Open with a hook title in the first 2 seconds", "Add titles for the key points", "Add sound effects on the key moments"];
const SUGGESTIONS_GRAPHICS = ["Make the pace faster", "Bigger, bolder titles", "Warmer colors", "Add sound effects on the key moments"];

/** An ask and what the agent did after it (steps before any ask belong to a turn without one). */
type Turn = { ask: Activity | null; steps: Activity[] };

function toTurns(activity: Activity[]): Turn[] {
  const turns: Turn[] = [];
  // The store keeps the newest first.
  for (const a of [...activity].reverse()) {
    if (a.source === ActivitySource.Ask) turns.push({ ask: a, steps: [] });
    else if (a.source === ActivitySource.Agent || a.source === ActivitySource.System) {
      if (!turns.length) turns.push({ ask: null, steps: [] });
      turns.at(-1)!.steps.push(a);
    }
  }
  return turns;
}

/** "Whole video: faster pace" → scope and text (asks are logged with what they point at). */
function splitAsk(text: string): [string | null, string] {
  const i = text.indexOf(": ");
  return i > 0 && i < 40 ? [text.slice(0, i), text.slice(i + 2)] : [null, text];
}

/**
 * Edit mode's main tool: the conversation with Claude about this video. What is selected sits on
 * top (its settings, and what the next ask points at), the conversation in the middle, and the
 * box at the bottom, with a few starts when it is empty.
 */
export function ClaudePanel({ ed, hasScene, hasFootage, selection, bare = false }: { ed: EditorProps; hasScene: boolean; hasFootage: boolean; selection: ReactNode; bare?: boolean }) {
  const agent = useAgentName();
  const { project, g } = ed;
  const activity = useEditor((s) => s.activity);
  const turns = useMemo(() => toTurns(activity), [activity]);
  const [draft, setDraft] = useState<{ text: string; n: number }>();
  const scroller = useRef<HTMLDivElement>(null);
  const status = g.state?.status;

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns, status, ed.captioning]);

  /** Nothing said or done yet: the panel shows what it is for. */
  const quiet = !turns.length && !g.running && !ed.captioning && (!status || status === GenerateStatus.Idle);
  const suggestions = hasScene && !g.running ? (hasFootage ? SUGGESTIONS_FOOTAGE : SUGGESTIONS_GRAPHICS) : [];

  return (
    // `bare`: inside the side panel's tab (which has the title), not a panel of its own.
    <aside className={bare ? "flex min-h-0 flex-1 flex-col overflow-hidden" : `flex w-[380px] shrink-0 flex-col overflow-hidden rounded-2xl bg-neutral-900/50 ring-1 ring-white/[0.06] ${ModePiece.Right}`}>
      {!bare && (
        <header className="flex items-center gap-2 px-4 pt-3.5 pb-2">
          <Spark className="size-4 text-white" />
          <span className="text-sm font-semibold">{agent}</span>
          {g.running && <span className="ml-auto size-2 animate-pulse rounded-full bg-emerald-400" aria-label="Working" />}
        </header>
      )}

      {selection && <div className="mx-3 mb-2 max-h-[45%] shrink-0 overflow-y-auto rounded-xl bg-neutral-950/70 p-3">{selection}</div>}

      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-3">
        {quiet ? (
          <div className="m-auto flex max-w-[280px] flex-col items-center gap-3 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-white/5">
              <Spark className="size-5 text-white" />
            </span>
            <p className="font-semibold">{hasScene ? "What should change?" : "What are we making?"}</p>
            <p className="text-sm leading-relaxed text-neutral-500">
              {hasScene
                ? "Ask for anything: cut the pauses, a title, an animated map at the playhead. Click something in the video or the timeline to ask about just that."
                : `Describe the video and ${agent} builds it, or drop your clips on the left and ask it to cut them.`}
            </p>
          </div>
        ) : (
          <>
            {turns.map((t, i) => (
              <TurnView key={t.ask?.id ?? `steps-${i}`} turn={t} />
            ))}
            <AgentLine g={g} captioning={ed.captioning} />
          </>
        )}
      </div>

      <div className="flex flex-col gap-2 p-3">
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setDraft({ text: s, n: Date.now() })}
                className="rounded-full px-2.5 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-white"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {project && (
          <AskBox
            g={g}
            hasScene={hasScene}
            projectId={ed.id}
            variant={AskVariant.Chat}
            draft={draft}
            onBrief={project.brief.trim() ? undefined : (brief) => api.updateProject(ed.id, { brief }).then(ed.setProject)}
          />
        )}
      </div>
    </aside>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(false);
  const [scope, text] = turn.ask ? splitAsk(turn.ask.text) : [null, ""];
  const steps = open ? turn.steps : turn.steps.slice(-STEPS_SHOWN);
  const hidden = turn.steps.length - steps.length;
  return (
    <div className="flex flex-col gap-2">
      {turn.ask && (
        <div className="flex max-w-[88%] flex-col items-end gap-1 self-end">
          {scope && <span className="text-[10px] text-neutral-500">{scope}</span>}
          <p className="rounded-2xl rounded-br-md bg-neutral-800 px-3.5 py-2 text-sm whitespace-pre-wrap text-neutral-100">{text}</p>
          {turn.ask.images && <ReferenceThumbs urls={turn.ask.images} />}
        </div>
      )}
      {turn.steps.length > 0 && (
        <ul className="flex flex-col gap-1 border-l border-neutral-800 pl-3 text-xs text-neutral-500">
          {hidden > 0 && (
            <li>
              <button type="button" onClick={() => setOpen(true)} className="hover:text-white">
                {hidden} earlier {hidden === 1 ? "step" : "steps"}
              </button>
            </li>
          )}
          {steps.map((s) => (
            <li key={s.id} className={s.source === ActivitySource.System ? "text-amber-200/80" : ""}>
              {s.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Spark({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 2.5c.5 4.6 2.9 7 9.5 9.5-6.6 2.5-9 4.9-9.5 9.5-.5-4.6-2.9-7-9.5-9.5 6.6-2.5 9-4.9 9.5-9.5z" />
    </svg>
  );
}
