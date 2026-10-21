import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { mediaUrl } from "../../api/client";
import { ActivityLog } from "../../components/ActivityLog";
import { AgentBar } from "../../components/AgentBar";
import { captioningLabel } from "../AgentLine";
import { AskBox, AskVariant } from "../../components/AskBox";
import { ConnectAgent } from "../../components/ConnectAgent";
import { GenerateEventKind, TOOL_LABEL } from "../../components/GeneratePanel";
import { Logo } from "../../components/Logo";
import { ExportButton } from "../../export/ExportButton";
import { ScheduleButton } from "../../posts/ScheduleButton";
import { href, RouteName } from "../../router";
import { useEditor } from "../../store";
import type { EditorProps } from "../context";
import { EditorMode } from "../mode";
import { PROJECT_TABS, ProjectPanel, type ProjectTab } from "../ProjectPanels";
import { ProjectTitle } from "../ProjectTitle";
import { useSceneView } from "../sceneView";
import { useTransportKeys } from "../transportKeys";
import { Viewer } from "../Viewer";
import { EffectControls } from "./EffectControls";
import { Panel } from "./Panel";
import { PreviewControls } from "./PreviewControls";
import { ProTimeline } from "./ProTimeline";
import { timecode } from "./timecode";

const SPLIT_KEY = "motionily.proSplit";
/** Share of the height above the timeline, and how far the divider can go. */
const DEFAULT_SPLIT = 0.56;
const MIN_SPLIT = 0.25;
const MAX_SPLIT = 0.8;

const LeftTab = { Controls: "controls", Project: "project" } as const;
type LeftTab = (typeof LeftTab)[keyof typeof LeftTab];
const RightTab = { Agent: "agent", Activity: "activity" } as const;
type RightTab = (typeof RightTab)[keyof typeof RightTab];

function loadSplit() {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= MIN_SPLIT && v <= MAX_SPLIT ? v : DEFAULT_SPLIT;
  } catch {
    return DEFAULT_SPLIT;
  }
}

/**
 * Pro mode, laid out like After Effects: Effect Controls and Project on the left, the
 * Composition in the middle, Preview and the Agent on the right, the Timeline across the bottom.
 */
export function ProEditor({ ed }: { ed: EditorProps }) {
  const { project, g } = ed;
  const scene = useSceneView();
  const fps = scene?.fps ?? 30;
  const time = useEditor((s) => s.time);
  const [sceneW, sceneH] = useEditor((s) => s.sceneSize);
  const selected = useEditor((s) => s.selectedLayerId);
  const group = useEditor((s) => s.selectedGroup);
  const agentConnected = useEditor((s) => s.agentConnected);
  const [left, setLeft] = useState<LeftTab>(LeftTab.Controls);
  const [sub, setSub] = useState<ProjectTab>(PROJECT_TABS[0]![0]);
  const [right, setRight] = useState<RightTab>(RightTab.Agent);
  const [split, setSplit] = useState(loadSplit);
  const body = useRef<HTMLDivElement>(null);
  useTransportKeys(fps, true);

  // Select something on the canvas or the timeline: its controls come to the front.
  const target = group ?? selected;
  useEffect(() => {
    if (target) setLeft(LeftTab.Controls);
  }, [target]);

  const dragSplit = (e: ReactPointerEvent) => {
    e.preventDefault();
    const r = body.current!.getBoundingClientRect();
    let v = split;
    const move = (ev: PointerEvent) => {
      v = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, (ev.clientY - r.top) / r.height));
      setSplit(v);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      try {
        localStorage.setItem(SPLIT_KEY, String(v));
      } catch {
        // Not critical.
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const running = g.running && g.state;
  const lastStep = running ? [...g.state!.events].reverse().find((e) => e.kind === GenerateEventKind.Tool) : undefined;

  return (
    <div className="flex h-dvh flex-col bg-[#121212] text-[12px] text-[#c9c9c9]">
      <header className="flex h-10 shrink-0 items-center gap-3 bg-[#232323] px-3">
        <a href={href({ name: RouteName.Projects })} className="shrink-0 scale-90">
          <Logo />
        </a>
        <ProjectTitle project={project} onRename={ed.rename} className="w-56 rounded-sm px-1.5 py-0.5 text-[13px] text-[#e6e6e6] hover:bg-[#1b1b1b] focus:bg-[#1b1b1b]" />
        <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[11px] text-[#8a8a8a]">
          <span className={`size-2 shrink-0 rounded-full ${running ? "animate-pulse bg-emerald-400" : agentConnected ? "bg-emerald-400" : "bg-[#555]"}`} />
          <span className="truncate">{running ? `Agent · ${lastStep ? (TOOL_LABEL[lastStep.text] ?? lastStep.text) : "working"}` : agentConnected ? "Agent connected" : "No agent connected"}</span>
        </span>
        <nav className="flex items-center gap-3 border-l border-[#151515] pl-3" aria-label="Workspace">
          {[
            [EditorMode.Simple, "Simple"],
            [EditorMode.Pro, "Pro"],
          ].map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => ed.setMode(m as EditorMode)}
              className={ed.mode === m ? "text-[#4aa3f0] underline decoration-2 underline-offset-[11px]" : "text-[#8a8a8a] hover:text-[#c9c9c9]"}
            >
              {label}
            </button>
          ))}
        </nav>
        <ConnectAgent projectId={ed.id} />
        {project && <ScheduleButton ed={ed} />}
        {project && <ExportButton name={project.name} audioUrl={project.audio ? mediaUrl(project.audio.url) : null} />}
      </header>

      <div ref={body} className="flex min-h-0 flex-1 flex-col p-1">
        <div className="flex min-h-0 gap-1" style={{ height: `${split * 100}%` }}>
          <Panel
            className="w-[320px] shrink-0"
            tabs={[
              [LeftTab.Controls, target ? `Effect Controls: ${target}` : "Effect Controls"],
              [LeftTab.Project, "Project"],
            ]}
            active={left}
            onTab={setLeft}
            bodyClass="overflow-y-auto"
          >
            {left === LeftTab.Controls ? (
              <EffectControls scene={scene} />
            ) : (
              project && (
                <div className="flex flex-col gap-4 p-3">
                  <div className="flex gap-1">
                    {PROJECT_TABS.map(([t, label]) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setSub(t)}
                        className={`rounded-sm px-2 py-0.5 ${sub === t ? "bg-[#2e2e2e] text-[#e6e6e6]" : "text-[#8a8a8a] hover:text-[#c9c9c9]"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <ProjectPanel tab={sub} project={project} onProject={ed.setProject} onBrief={ed.saveBrief} onReferences={ed.saveReferences} onFormat={ed.changeFormat} />
                </div>
              )
            )}
          </Panel>

          <Panel className="min-w-0 flex-1" tabs={[["comp", `Composition: ${project?.name ?? ""}`]]} bodyClass="flex flex-col">
            <div className="flex min-h-0 flex-1 flex-col bg-[#1a1a1a] p-3">
              <Viewer canvas={ed.canvas} error={ed.error} />
            </div>
            <div className="flex h-7 shrink-0 items-center gap-4 border-t border-[#151515] px-3 text-[11px] text-[#8a8a8a]">
              <span>Fit</span>
              <span className="text-[#4aa3f0] tabular-nums">{timecode(time, fps)}</span>
              <span>Full</span>
              <span className="tabular-nums">
                {sceneW} × {sceneH}
              </span>
              <span>{fps} fps</span>
            </div>
          </Panel>

          <div className="flex w-[340px] shrink-0 flex-col gap-1">
            <Panel tabs={[["preview", "Preview"]]}>
              <PreviewControls fps={fps} />
            </Panel>
            <Panel
              className="flex-1"
              tabs={[
                [RightTab.Agent, "Agent"],
                [RightTab.Activity, "Activity"],
              ]}
              active={right}
              onTab={setRight}
              bodyClass="flex flex-col"
            >
              {right === RightTab.Agent ? (
                <>
                  <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {ed.captioning && <p className="pb-3 text-[#8a8a8a]">{captioningLabel(ed.captioning)}</p>}
                    {project && <AgentBar g={g} hasScene={!!project.scene} runs={project.agentRuns ?? []} />}
                  </div>
                  {project && (
                    <div className="border-t border-[#151515] p-2">
                      <AskBox g={g} hasScene={!!project.scene} projectId={ed.id} variant={AskVariant.Pro} />
                    </div>
                  )}
                </>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  <ActivityLog />
                </div>
              )}
            </Panel>
          </div>
        </div>

        <div onPointerDown={dragSplit} className="group flex h-1.5 shrink-0 cursor-row-resize items-center" role="separator" aria-orientation="horizontal">
          <span className="h-px w-full group-hover:bg-[#2d8ceb]" />
        </div>

        <Panel className="min-h-0 flex-1" tabs={[["timeline", project?.name ?? "Timeline"]]}>
          <ProTimeline scene={scene} audioUrl={project?.audio ? mediaUrl(project.audio.url) : null} />
        </Panel>
      </div>
    </div>
  );
}
