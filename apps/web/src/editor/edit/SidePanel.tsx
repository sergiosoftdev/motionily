import { useEffect, useState, type ReactNode } from "react";
import { useAgentName } from "../../agentName";
import { ModePiece } from "../mode";
import { Spark } from "./ClaudePanel";

export const SideTab = { Inspector: "inspector", Agent: "agent" } as const;
export type SideTab = (typeof SideTab)[keyof typeof SideTab];

/**
 * Edit mode's right panel, like an editor's: the Inspector (what is selected, or the project's
 * settings) and the agent, each a tab. Selecting something brings the Inspector forward.
 */
export function SidePanel({ inspector, agentPanel, selectedKey, running }: { inspector: ReactNode; agentPanel: ReactNode; selectedKey: string | null; running: boolean }) {
  const agent = useAgentName();
  const [tab, setTab] = useState<SideTab>(SideTab.Agent);
  useEffect(() => {
    if (selectedKey) setTab(SideTab.Inspector);
  }, [selectedKey]);
  const tabClass = (t: SideTab) => `flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${tab === t ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-white"}`;
  return (
    <aside className={`flex w-[380px] shrink-0 flex-col overflow-hidden rounded-2xl bg-neutral-900/50 ring-1 ring-white/[0.06] ${ModePiece.Right}`}>
      <div className="flex items-center gap-1 px-3 pt-3 pb-2" role="tablist">
        <button type="button" role="tab" aria-selected={tab === SideTab.Inspector} onClick={() => setTab(SideTab.Inspector)} className={tabClass(SideTab.Inspector)}>
          Inspector
        </button>
        <button type="button" role="tab" aria-selected={tab === SideTab.Agent} onClick={() => setTab(SideTab.Agent)} className={tabClass(SideTab.Agent)}>
          <Spark className="size-3.5" />
          {agent}
          {running && <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" aria-label="Working" />}
        </button>
      </div>
      {tab === SideTab.Inspector ? <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-1 pb-4">{inspector}</div> : agentPanel}
    </aside>
  );
}
