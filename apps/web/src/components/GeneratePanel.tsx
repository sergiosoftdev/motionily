import { useEffect, useState } from "react";
import { api } from "../api/client";

export const GenerateStatus = { Idle: "idle", Running: "running", Done: "done", Failed: "failed", Stopped: "stopped" } as const;
export type GenerateStatus = (typeof GenerateStatus)[keyof typeof GenerateStatus];
export const GenerateEventKind = { Tool: "tool", Text: "text", Error: "error" } as const;
export type GenerateEventKind = (typeof GenerateEventKind)[keyof typeof GenerateEventKind];
export type GenerateState = {
  status: GenerateStatus;
  events: { at: string; kind: GenerateEventKind; text: string }[];
  summary: string | null;
};

const POLL_MS = 1500;

/** What each agent tool means, in the user's words. */
const TOOL_LABEL: Record<string, string> = {
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
  set_format: "Cambia el formato",
  ToolSearch: "Prepara sus herramientas",
};

/** The main action of the editor: let the agent build or change the video, no terminal needed. */
export function GeneratePanel({ projectId, hasScene }: { projectId: string; hasScene: boolean }) {
  const [state, setState] = useState<GenerateState | null>(null);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
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

  const start = async () => {
    setError(null);
    try {
      setState(await api.generate(projectId, instruction));
      setInstruction("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const steps = (state?.events ?? []).filter((e) => e.kind !== GenerateEventKind.Text).slice(-6);
  const lastThought = [...(state?.events ?? [])].reverse().find((e) => e.kind === GenerateEventKind.Text);

  return (
    <section className="flex flex-col gap-3">
      {hasScene && !running && (
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void start()}
          placeholder="Pide un cambio: «más ritmo», «título más grande»…"
          className="rounded-lg bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
        />
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
      {!running && state?.status === GenerateStatus.Failed && (
        <p className="text-xs text-red-400">{state.events.filter((e) => e.kind === GenerateEventKind.Error).at(-1)?.text ?? "El agente falló."}</p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </section>
  );
}
