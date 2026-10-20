import { useEffect, useState } from "react";
import { GenerateEventKind, TOOL_LABEL, type GenerateState } from "./GeneratePanel";

/** Phases the API reports for a full build (mirrors GeneratePhase). */
export const Phase = { Plan: "plan", Build: "build", Review: "review" } as const;
type Phase = (typeof Phase)[keyof typeof Phase];
const PHASES: { id: Phase; label: string }[] = [
  { id: Phase.Plan, label: "Dirección de arte" },
  { id: Phase.Build, label: "Montaje en paralelo" },
  { id: Phase.Review, label: "Revisión" },
];
/** Premium mode: one designer plans and builds the whole film, then the reviewer. */
const SOLO_PHASES: { id: Phase; label: string }[] = [
  { id: Phase.Build, label: "Diseño y montaje" },
  { id: Phase.Review, label: "Revisión" },
];
/** Role tag of the premium designer's events. */
const DESIGN_ROLE = "design";
/** After this long without a tool call, say when the last step was (the agent is writing or thinking). */
const QUIET_MS = 20_000;

const GAGS = [
  "Discutiendo si ese verde es menta o pistacho…",
  "Quitando una Comic Sans que alguien coló…",
  "Convenciendo al rebote de que no se pase de frenada…",
  "Midiendo márgenes con una regla de verdad…",
  "Calentando los keyframes, que salen fríos…",
  "Pidiendo al becario que alinee los píxeles…",
  "Negociando con el título para que quepa en una línea…",
  "Lijando las curvas de animación…",
  "Haciendo que el fondo deje de estar quieto…",
  "Poniendo el café para el revisor…",
];
const GAG_MS = 3400;
const TAG = /^\[([^\]]+)\] (.*)$/;
const MAX_BRICKS = 12;

export type Lane = { group: string; start: number; end: number; tools: number; last: string | null; done: boolean };

/** Reads the event stream into phases and one lane per beat. */
export function readState(state: GenerateState) {
  let phase: Phase | null = null;
  let lanes: Lane[] = [];
  let direction: string | null = null;
  let plannerSteps = 0;
  let reviewLast: string | null = null;
  let solo = false;
  let design: { tools: number; last: string | null } = { tools: 0, last: null };
  let lastStepAt: number | null = null;
  for (const e of state.events) {
    if (e.kind === GenerateEventKind.Phase) {
      // Team runs open with the planner; premium runs go straight to building.
      if (!phase && e.text === Phase.Build) solo = true;
      phase = e.text as Phase;
    }
    else if (e.kind === GenerateEventKind.Plan) {
      try {
        lanes = (JSON.parse(e.text) as { group: string; start: number; end: number }[]).map((b) => ({ ...b, tools: 0, last: null, done: false }));
      } catch {
        // Malformed plan event: keep going without lanes.
      }
    } else if (e.kind === GenerateEventKind.Done) {
      const l = lanes.find((x) => x.group === e.text);
      if (l) l.done = true;
    } else if (e.kind === GenerateEventKind.Text && !direction && !TAG.test(e.text)) direction = e.text;
    else if (e.kind === GenerateEventKind.Tool) {
      lastStepAt = Date.parse(e.at);
      const m = TAG.exec(e.text);
      const role = m?.[1];
      const tool = m?.[2] ?? e.text;
      const lane = lanes.find((x) => x.group === role);
      if (lane) {
        lane.tools += 1;
        lane.last = TOOL_LABEL[tool] ?? tool;
      } else if (role === "plan") plannerSteps += 1;
      else if (role === DESIGN_ROLE) design = { tools: design.tools + 1, last: TOOL_LABEL[tool] ?? tool };
      else if (role === "review") reviewLast = TOOL_LABEL[tool] ?? tool;
    }
  }
  return { phase, lanes, direction, plannerSteps, reviewLast, solo, design, lastStepAt };
}

/**
 * What the agent team is doing, live: phases, one lane per beat with its stickman at work
 * (bricks = layers written), the reviewer sweeping at the end, and a running gag.
 */
export function AgentWorkshop({ state }: { state: GenerateState }) {
  const { phase, lanes, direction, plannerSteps, reviewLast, solo, design, lastStepAt } = readState(state);
  const [gag, setGag] = useState(() => Math.floor(Math.random() * GAGS.length));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const g = setInterval(() => setGag((n) => (n + 1) % GAGS.length), GAG_MS);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(g);
      clearInterval(t);
    };
  }, []);
  const started = state.events[0] ? Date.parse(state.events[0].at) : now;
  const secs = Math.max(0, Math.round((now - started) / 1000));
  const phases = solo ? SOLO_PHASES : PHASES;
  const phaseIndex = phases.findIndex((p) => p.id === phase);
  const quiet = lastStepAt !== null && now - lastStepAt > QUIET_MS ? Math.round((now - lastStepAt) / 1000) : null;

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-neutral-900/70 p-3 ring-1 ring-white/5">
      <div className="flex items-center justify-between text-[11px] text-neutral-500">
        <span className="font-mono">
          {clock(secs)}
        </span>
        <span>{quiet !== null ? `Escribiendo · último paso hace ${clock(quiet)}` : "El vídeo se monta en directo a la izquierda"}</span>
      </div>

      {/* Phase rail */}
      <div className="flex gap-1">
        {phases.map((p, i) => (
          <div key={p.id} className="flex flex-1 flex-col gap-1">
            <span className="relative h-1 overflow-hidden rounded-full bg-white/10">
              {i < phaseIndex && <span className="absolute inset-0 bg-emerald-400" />}
              {i === phaseIndex && <span className="wiz-shimmer absolute inset-0 bg-emerald-400/50" />}
            </span>
            <span className={`text-[10px] ${i === phaseIndex ? "text-white" : i < phaseIndex ? "text-neutral-400" : "text-neutral-600"}`}>{p.label}</span>
          </div>
        ))}
      </div>

      {solo && phase === Phase.Build ? (
        <div className="flex items-center gap-3">
          <Builder working />
          <div className="flex min-w-0 flex-col text-xs">
            <span className="text-neutral-200">El diseñador monta el vídeo entero</span>
            <span className="truncate text-neutral-500">{design.last ? `${design.tools} pasos · ${design.last}` : "Leyendo el brief y tu marca…"}</span>
          </div>
        </div>
      ) : phase === Phase.Plan || !phase ? (
        <div className="flex items-center gap-3">
          <Director />
          <div className="flex flex-col text-xs">
            <span className="text-neutral-200">La directora de arte está pensando el vídeo</span>
            <span className="text-neutral-500">{plannerSteps ? `${plannerSteps} decisiones tomadas` : "Leyendo el brief y tu marca…"}</span>
          </div>
        </div>
      ) : (
        <>
          {direction && <p className="line-clamp-2 text-[11px] text-neutral-400 italic">“{direction}”</p>}
          <div className="flex flex-col gap-2">
            {lanes.map((l) => (
              <div key={l.group} className="flex items-center gap-2">
                <Builder working={!l.done && phase === Phase.Build} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="truncate font-medium text-neutral-200">{l.group}</span>
                    <span className="shrink-0 font-mono text-neutral-600">
                      {l.start}–{l.end}s
                    </span>
                  </div>
                  <div className="flex h-2.5 items-end gap-0.5">
                    {Array.from({ length: Math.min(MAX_BRICKS, l.tools * 2) }, (_, b) => (
                      <span key={b} className="ws-brick h-2.5 w-3 rounded-[2px] bg-emerald-400/80" style={{ animationDelay: `${(b % 2) * 0.12}s` }} />
                    ))}
                    {l.done && <span className="ml-1 text-[10px] text-emerald-400">✓ listo</span>}
                  </div>
                  {!l.done && <span className="truncate text-[10px] text-neutral-500">{l.last ?? "Afilando el lápiz…"}</span>}
                </div>
              </div>
            ))}
          </div>
          {phase === Phase.Review && <Reviewer last={reviewLast} />}
        </>
      )}

      <p key={gag} className="wiz-in text-[11px] text-neutral-500">
        {GAGS[gag]}
      </p>
    </div>
  );
}

const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

/** The crew: faceless black stickmen, like the rest of the brand. */
function Builder({ working }: { working: boolean }) {
  return (
    <svg viewBox="0 0 28 32" className={`h-8 w-7 shrink-0 ${working ? "ws-bob" : ""}`} aria-hidden>
      <circle cx="11" cy="6" r="4.5" fill="#e5e5e5" />
      <path d="M11 11 L11 21 M11 21 L7 30 M11 21 L15 30 M11 13 L6 19" stroke="#e5e5e5" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <g transform="translate(12 13)">
        <g className={working ? "ws-hammer" : ""}>
          <path d="M0 0 L9 0" stroke="#e5e5e5" strokeWidth="2.6" strokeLinecap="round" />
          <path d="M9 -3.5 L9 3.5" stroke="#34d399" strokeWidth="3.5" strokeLinecap="round" />
        </g>
      </g>
      {working && <circle cx="24" cy="18" r="1.2" fill="#fde68a" className="ws-spark" style={{ ["--sx" as string]: "5px" }} />}
    </svg>
  );
}

function Director() {
  return (
    <svg viewBox="0 0 40 32" className="ws-bob h-10 w-12 shrink-0" aria-hidden>
      <circle cx="10" cy="6" r="4.5" fill="#e5e5e5" />
      <path d="M10 11 L10 21 M10 21 L6 30 M10 21 L14 30 M10 13 L17 12" stroke="#e5e5e5" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <path d="M17 9 L24 6 L24 18 L17 15 Z" fill="#34d399" />
      <g className="ws-shout">
        <path d="M27 8 Q30 12 27 16 M31 6 Q35 12 31 18" stroke="#34d399" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function Reviewer({ last }: { last: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="relative h-8 overflow-hidden rounded-md bg-white/[0.03]" style={{ ["--ws-w" as string]: "100%" }}>
        <svg viewBox="0 0 28 32" className="ws-sweep absolute top-0 left-0 h-8 w-7" aria-hidden>
          <circle cx="9" cy="6" r="4.5" fill="#e5e5e5" />
          <path d="M9 11 L9 21 M9 21 L5 30 M9 21 L13 30 M9 13 L15 15" stroke="#e5e5e5" strokeWidth="2.6" strokeLinecap="round" fill="none" />
          <circle cx="19" cy="16" r="4" stroke="#fde68a" strokeWidth="2" fill="rgb(253 230 138 / 0.15)" />
        </svg>
      </div>
      <span className="text-[10px] text-neutral-500">El revisor repasa el montaje entero{last ? ` · ${last}` : "…"}</span>
    </div>
  );
}
