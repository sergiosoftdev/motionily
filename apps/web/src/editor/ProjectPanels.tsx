import { useState } from "react";
import type { Project, VideoFormat } from "@motionily/protocol";
import { ReferenceStrip, useReferences } from "../components/References";
import { ImageCredits } from "../components/ImageCredits";
import { FormatPicker } from "../components/FormatPicker";
import { CaptionsPanel } from "../captions/CaptionsPanel";

export const ProjectTab = { Brief: "brief", Voice: "voice", Format: "format" } as const;
export type ProjectTab = (typeof ProjectTab)[keyof typeof ProjectTab];
export const PROJECT_TABS: [ProjectTab, string][] = [
  [ProjectTab.Brief, "Brief"],
  [ProjectTab.Voice, "Voice"],
  [ProjectTab.Format, "Format"],
];

/** What the video is built from: the brief and references, the voice and captions, the frame shape. */
export function ProjectPanel({
  tab,
  project,
  onProject,
  onBrief,
  onReferences,
  onFormat,
}: {
  tab: ProjectTab;
  project: Project;
  onProject: (p: Project) => void;
  onBrief: (brief: string) => void;
  onReferences: (refs: string[]) => void;
  onFormat: (f: VideoFormat) => void;
}) {
  if (tab === ProjectTab.Brief) return <BriefBox key={project.id} project={project} onBrief={onBrief} onReferences={onReferences} />;
  if (tab === ProjectTab.Voice)
    return (
      <div className="flex flex-col gap-6">
        {project.voiceScript.trim() && <VoiceScript script={project.voiceScript} hasVoice={!!project.audio} />}
        <CaptionsPanel project={project} onProject={onProject} hasScene={!!project.scene} />
      </div>
    );
  return <FormatPicker value={project.format} onChange={onFormat} />;
}

/** The ElevenLabs script the video is built on: copy it, generate the voice, upload it below. */
function VoiceScript({ script, hasVoice }: { script: string; hasVoice: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold">Voice script</span>
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(script).then(() => setCopied(true))}
          className="text-xs text-neutral-400 hover:text-white"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-neutral-300">{script}</p>
      <span className="text-xs text-neutral-500">
        {hasVoice ? "The voice is in: the agent ties the video to its words." : "Generate it below with one of your ElevenLabs voices, or upload your own recording."}
      </span>
    </section>
  );
}

/** The brief plus its reference images (paste, drop or attach); both are what the agent builds from. */
function BriefBox({ project, onBrief, onReferences }: { project: Project; onBrief: (brief: string) => void; onReferences: (refs: string[]) => void }) {
  const refs = useReferences(project.references, onReferences);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="brief" className="text-xs text-neutral-500">
        What the video is about · Claude designs all of it from this
      </label>
      <textarea
        id="brief"
        defaultValue={project.brief}
        onBlur={(e) => onBrief(e.target.value)}
        rows={6}
        placeholder="E.g. a 20 s ad for my booking app for physical therapists, warm tone"
        className="resize-none rounded-lg bg-neutral-900 px-3 py-2 text-[13px] leading-relaxed placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
        {...refs.handlers}
      />
      <span className="mt-3 text-xs text-neutral-500">References · images or videos (⌘V or drag)</span>
      <ReferenceStrip r={refs} />
      {project.imageCredits.length > 0 && (
        <div className="mt-6">
          <ImageCredits credits={project.imageCredits} />
        </div>
      )}
    </div>
  );
}
