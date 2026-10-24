import { useEffect } from "react";
import { create } from "zustand";
import { AgentCli, api } from "./api/client";

/** Short name of each coding agent, for the editor's copy ("Ask Codex", "Gemini is writing…"). */
const SHORT_NAME: Record<AgentCli, string> = {
  [AgentCli.Claude]: "Claude",
  [AgentCli.Codex]: "Codex",
  [AgentCli.Gemini]: "Gemini",
  [AgentCli.OpenCode]: "OpenCode",
};

type AgentNameStore = { name: string; loaded: boolean; set: (cli: AgentCli) => void };

/** The agent the user picked in Settings (Claude until the API says otherwise). */
export const useAgentNameStore = create<AgentNameStore>((set) => ({
  name: SHORT_NAME[AgentCli.Claude],
  loaded: false,
  set: (cli) => set({ name: SHORT_NAME[cli] ?? SHORT_NAME[AgentCli.Claude], loaded: true }),
}));

let loading: Promise<void> | null = null;

/** The name to show for the agent that works inside Motionily. */
export function useAgentName(): string {
  const { name, loaded, set } = useAgentNameStore();
  useEffect(() => {
    if (loaded || loading) return;
    loading = api
      .agentSettings()
      .then((s) => set(s.cli))
      .catch(() => undefined)
      .finally(() => (loading = null));
  }, [loaded, set]);
  return name;
}
