import { useState } from "react";
import { api } from "../api/client";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3100";

const CopyState = { Idle: "idle", Copied: "copied" } as const;
type CopyState = (typeof CopyState)[keyof typeof CopyState];

/** Gives the user a one-paste command that registers the Motionily MCP server in Claude Code for this project. */
export function ConnectAgent({ projectId }: { projectId: string }) {
  const [command, setCommand] = useState<string | null>(null);
  const [copy, setCopy] = useState<CopyState>(CopyState.Idle);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const show = async () => {
    setOpen(true);
    if (command) return;
    try {
      const { token } = await api.agentToken(projectId);
      setCommand(
        [
          "claude mcp remove motionily -s user >/dev/null 2>&1;",
          "claude mcp add motionily -s user",
          `-e MOTIONILY_API=${API_URL}`,
          `-e MOTIONILY_PROJECT=${projectId}`,
          `-e MOTIONILY_TOKEN=${token}`,
          `-- ${import.meta.env.VITE_MCP_TSX} ${import.meta.env.VITE_MCP_ENTRY}`,
        ].join(" "),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copyCommand = async () => {
    if (!command) return;
    await navigator.clipboard.writeText(command);
    setCopy(CopyState.Copied);
    setTimeout(() => setCopy(CopyState.Idle), 1500);
  };

  return (
    <>
      <button type="button" onClick={() => void show()} className="rounded-lg px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-white">
        Usar en Claude Code
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => setOpen(false)}>
          <div className="flex w-full max-w-xl flex-col gap-5 rounded-2xl bg-neutral-900 p-6" onClick={(e) => e.stopPropagation()}>
            <div>
              <h2 className="text-lg font-bold">Conecta tu agente</h2>
              <p className="mt-1 text-sm text-neutral-400">
                Pega esto en tu terminal. Registra Motionily en Claude Code con acceso solo a este proyecto.
              </p>
            </div>
            <ol className="flex flex-col gap-4 text-sm">
              <li className="flex flex-col gap-2">
                <span className="text-neutral-300">1. Registra el servidor</span>
                <div className="relative">
                  <pre className="max-h-32 overflow-auto rounded-lg bg-neutral-950 p-3 pr-20 text-[11px] leading-relaxed whitespace-pre-wrap break-all text-neutral-300">
                    {command ?? (error ? `Error: ${error}` : "Generando token…")}
                  </pre>
                  {command && (
                    <button type="button" onClick={() => void copyCommand()} className="absolute top-2 right-2 rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-neutral-900">
                      {copy === CopyState.Copied ? "Copiado" : "Copiar"}
                    </button>
                  )}
                </div>
              </li>
              <li className="flex flex-col gap-1">
                <span className="text-neutral-300">2. Abre Claude Code y pídele el vídeo</span>
                <code className="rounded-lg bg-neutral-950 px-3 py-2 text-xs text-neutral-300">claude "Monta el vídeo de mi proyecto de Motionily"</code>
              </li>
              <li className="text-neutral-400">3. Deja esta pestaña abierta: verás cómo lo monta en directo.</li>
            </ol>
            <p className="text-xs text-neutral-500">El token caduca en 90 días y no puede cambiar el estilo que elijas ni borrar el proyecto.</p>
          </div>
        </div>
      )}
    </>
  );
}
