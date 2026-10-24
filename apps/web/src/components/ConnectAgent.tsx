import { useState } from "react";
import { createPortal } from "react-dom";
import { API_URL, api } from "../api/client";
import { desktop } from "../desktop";
import {
  McpClient,
  SetupKind,
  clientSetups,
  type ClientSetup,
} from "./agentClients";

const CopyState = { Idle: "idle", Copied: "copied" } as const;
type CopyState = (typeof CopyState)[keyof typeof CopyState];

/** Where the button sits: the editor's top bar, or the dashboard's side navigation. */
export const ConnectAgentPlacement = { Editor: "editor", Nav: "nav" } as const;
type ConnectAgentPlacement =
  (typeof ConnectAgentPlacement)[keyof typeof ConnectAgentPlacement];

const TRIGGER_CLASS: Record<ConnectAgentPlacement, string> = {
  [ConnectAgentPlacement.Editor]:
    "rounded-lg px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-white",
  [ConnectAgentPlacement.Nav]:
    "flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-neutral-400 hover:bg-neutral-900/60 hover:text-white",
};

/** How agents start the MCP server on this machine: the desktop app's bundled one, or the repo's in development. */
function mcpCommand(): { command: string; args: string[] } {
  if (desktop?.mcp) return desktop.mcp;
  return {
    command: import.meta.env.VITE_MCP_TSX,
    args: [import.meta.env.VITE_MCP_ENTRY],
  };
}

/**
 * Gives the user what registers the Motionily MCP server in their agent of choice (Claude Code, Codex,
 * Gemini CLI, OpenCode, Cursor, VS Code, Claude Desktop or any MCP client). From the editor it starts
 * on that video; from the dashboard it starts on none and creates or opens them.
 */
export function ConnectAgent({
  projectId,
  placement = ConnectAgentPlacement.Editor,
}: {
  projectId?: string;
  placement?: ConnectAgentPlacement;
}) {
  const [setups, setSetups] = useState<ClientSetup[] | null>(null);
  const [client, setClient] = useState<McpClient>(McpClient.ClaudeCode);
  const [copy, setCopy] = useState<CopyState>(CopyState.Idle);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const show = async () => {
    setOpen(true);
    if (setups) return;
    try {
      const { token } = await api.accountAgentToken();
      const env: Record<string, string> = {
        MOTIONILY_API: API_URL,
        ...(projectId ? { MOTIONILY_PROJECT: projectId } : {}),
        MOTIONILY_TOKEN: token,
      };
      const ask = projectId
        ? "Build the video for my Motionily project"
        : "Look at my app's code and make a Motionily ad for it";
      setSetups(clientSetups({ ...mcpCommand(), env }, ask));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setup = setups?.find((s) => s.client === client);
  const copyText = async () => {
    if (!setup) return;
    await navigator.clipboard.writeText(setup.text);
    setCopy(CopyState.Copied);
    setTimeout(() => setCopy(CopyState.Idle), 1500);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void show()}
        className={TRIGGER_CLASS[placement]}
      >
        {placement === ConnectAgentPlacement.Nav && (
          <svg
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M4 17l6-5-6-5M12 19h8" />
          </svg>
        )}
        Connect your agent
      </button>
      {open &&
        // Portaled: from the side navigation the dialog would be stuck in its stacking context, under the page.
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
            onClick={() => setOpen(false)}
          >
            <div
              className="flex w-full max-w-2xl flex-col gap-5 rounded-2xl bg-neutral-900 p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div>
                <h2 className="text-lg font-bold">Connect your agent</h2>
                <p className="mt-1 text-sm text-neutral-400">
                  Motionily works with any agent that speaks MCP. Register it
                  once{projectId ? ", starting on this video" : ""}: it can then
                  create new videos and open any of yours.
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {(setups ?? []).map((s) => (
                  <button
                    key={s.client}
                    type="button"
                    onClick={() => setClient(s.client)}
                    className={`rounded-md px-2.5 py-1 text-xs ${client === s.client ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <ol className="flex flex-col gap-4 text-sm">
                <li className="flex flex-col gap-2">
                  <span className="text-neutral-300">
                    {setup?.kind === SetupKind.File
                      ? `1. Add this to ${setup.file}`
                      : "1. Paste this into your terminal"}
                  </span>
                  <div className="relative">
                    <pre className="max-h-48 overflow-auto rounded-lg bg-neutral-950 p-3 pr-20 text-[11px] leading-relaxed whitespace-pre-wrap break-all text-neutral-300">
                      {setup?.text ??
                        (error ? `Error: ${error}` : "Generating token…")}
                    </pre>
                    {setup && (
                      <button
                        type="button"
                        onClick={() => void copyText()}
                        className="absolute top-2 right-2 rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-neutral-900"
                      >
                        {copy === CopyState.Copied ? "Copied" : "Copy"}
                      </button>
                    )}
                  </div>
                </li>
                {setup && (
                  <li className="flex flex-col gap-1">
                    <span className="text-neutral-300">
                      2. Ask for the video
                    </span>
                    <code className="rounded-lg bg-neutral-950 px-3 py-2 text-xs text-neutral-300">
                      {setup.next}
                    </code>
                  </li>
                )}
                <li className="text-neutral-400">
                  {projectId
                    ? "3. Keep this window open: you'll watch it build live."
                    : "3. Open the new video from Projects to watch it build live."}
                </li>
              </ol>
              <p className="text-xs text-neutral-500">
                The token expires in 90 days. It can create and edit videos, but
                never delete them.
              </p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
