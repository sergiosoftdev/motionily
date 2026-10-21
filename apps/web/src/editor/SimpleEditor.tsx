import { useState } from "react";
import { mediaUrl } from "../api/client";
import { Logo } from "../components/Logo";
import { AskBox, AskVariant } from "../components/AskBox";
import { AgentBar } from "../components/AgentBar";
import { ActivityLog } from "../components/ActivityLog";
import { ConnectAgent } from "../components/ConnectAgent";
import { ExportButton } from "../export/ExportButton";
import { href, RouteName } from "../router";
import { useEditor } from "../store";
import { AgentLine } from "./AgentLine";
import type { EditorProps } from "./context";
import { ModeSwitch } from "./mode";
import { PROJECT_TABS, ProjectPanel, type ProjectTab } from "./ProjectPanels";
import { ProjectTitle } from "./ProjectTitle";
import { SceneStrip } from "./SceneStrip";
import { Viewer } from "./Viewer";

/** Widest the preview gets, like a video player rather than a full-bleed canvas. */
const PREVIEW_MAX_WIDTH = 1100;

/** Simple mode: the video, its moments, and one box to ask for changes. Everything else is in Settings. */
export function SimpleEditor({ ed }: { ed: EditorProps }) {
  const { project, g } = ed;
  const [settings, setSettings] = useState(false);
  const hasScene = !!project?.scene;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-4 px-5 py-3">
        <a href={href({ name: RouteName.Projects })} className="shrink-0">
          <Logo />
        </a>
        <ProjectTitle project={project} onRename={ed.rename} className="flex-1 rounded-md px-2 py-1 text-sm font-medium hover:bg-neutral-900 focus:bg-neutral-900" />
        <ModeSwitch mode={ed.mode} onChange={ed.setMode} className="bg-neutral-900" />
        <button type="button" onClick={() => setSettings(true)} className="rounded-lg px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900 hover:text-white">
          Video settings
        </button>
        {project && <ExportButton name={project.name} audioUrl={project.audio ? mediaUrl(project.audio.url) : null} />}
      </header>

      <main className="flex min-h-0 flex-1 flex-col items-center gap-5 px-6 pb-6">
        <Viewer canvas={ed.canvas} error={ed.error} maxWidth={PREVIEW_MAX_WIDTH} canvasClass="rounded-2xl shadow-2xl shadow-black/50" />
        <div className="flex w-full max-w-3xl flex-col gap-3">
          <SceneStrip />
          <AgentLine g={g} captioning={ed.captioning} />
          {project &&
            (hasScene || g.running ? (
              <AskBox g={g} hasScene={hasScene} projectId={ed.id} variant={AskVariant.Simple} />
            ) : ed.captioning ? null : (
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <button type="button" onClick={() => void g.start()} className="rounded-xl bg-white px-6 py-3 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
                  Generate video
                </button>
                <button type="button" onClick={() => setSettings(true)} className="text-xs text-neutral-500 hover:text-white">
                  Claude builds it from your brief · review the brief first
                </button>
                {g.error && <p className="text-xs text-red-400">{g.error}</p>}
              </div>
            ))}
        </div>
      </main>

      {settings && project && <SettingsDrawer ed={ed} onClose={() => setSettings(false)} />}
    </div>
  );
}

const DrawerTab = { Agent: "agent", Activity: "activity" } as const;
type DrawerTab = (typeof DrawerTab)[keyof typeof DrawerTab] | ProjectTab;

/** Everything that is not watching and asking: the agent, the brief, the voice, the format, the log. */
function SettingsDrawer({ ed, onClose }: { ed: EditorProps; onClose: () => void }) {
  const [tab, setTab] = useState<DrawerTab>(DrawerTab.Agent);
  const agentConnected = useEditor((s) => s.agentConnected);
  const project = ed.project!;
  const tabs: [DrawerTab, string][] = [[DrawerTab.Agent, "Agent"], ...PROJECT_TABS, [DrawerTab.Activity, "Activity"]];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <aside className="flex h-full w-full max-w-md flex-col bg-neutral-950 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 pt-5 pb-4">
          <h2 className="text-base font-semibold">Video settings</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-lg text-neutral-500 hover:text-white">
            ×
          </button>
        </div>
        <nav className="flex gap-1 px-5">
          {tabs.map(([t, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${tab === t ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-white"}`}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {tab === DrawerTab.Agent && (
            <div className="flex flex-col gap-8">
              <AgentBar g={ed.g} hasScene={!!project.scene} runs={project.agentRuns ?? []} />
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span className="flex items-center gap-1.5">
                  <span className={`size-2 rounded-full ${agentConnected ? "bg-emerald-400" : "bg-neutral-600"}`} />
                  {agentConnected ? "Agent connected" : "No agent connected"}
                </span>
                <ConnectAgent projectId={ed.id} />
              </div>
            </div>
          )}
          {tab === DrawerTab.Activity && <ActivityLog />}
          {tab !== DrawerTab.Agent && tab !== DrawerTab.Activity && (
            <ProjectPanel tab={tab} project={project} onProject={ed.setProject} onBrief={ed.saveBrief} onReferences={ed.saveReferences} onFormat={ed.changeFormat} />
          )}
        </div>
      </aside>
    </div>
  );
}
