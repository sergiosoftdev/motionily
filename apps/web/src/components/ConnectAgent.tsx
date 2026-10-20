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
              <h2 className="text-lg font-bold">Connect your agent</h2>
              <p className="mt-1 text-sm text-neutral-400">
                Paste this into your terminal. It registers Motionily in Claude Code with access to this project only.
              </p>
            </div>
            <ol className="flex flex-col gap-4 text-sm">
              <li className="flex flex-col gap-2">
                <span className="text-neutral-300">1. Registra el servidor</span>
                <div className="relative">
                  <pre className="max-h-32 overflow-auto rounded-lg bg-neutral-950 p-3 pr-20 text-[11px] leading-relaxed whitespace-pre-wrap break-all text-neutral-300">
                    {command ?? (error ? `Error: ${error}` : "Generating token…")}
                  </pre>
                  {command && (
                    <button type="button" onClick={() => void copyCommand()} className="absolute top-2 right-2 rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-neutral-900">
                      {copy === CopyState.Copied ? "Copied" : "Copy"}
                    </button>
                  )}
                </div>
              </li>
              <li className="flex flex-col gap-1">
                <span className="text-neutral-300">2. Open Claude Code and ask for the video</span>
                <code className="rounded-lg bg-neutral-950 px-3 py-2 text-xs text-neutral-300">claude "Build the video for my Motionily project"</code>
              </li>
              <li className="text-neutral-400">3. Keep this tab open: you'll watch it build live.</li>
            </ol>
            <p className="text-xs text-neutral-500">The token expires in 90 days and can't change the style you pick or delete the project.</p>
          </div>
        </div>
      )}
    </>
  );
}
