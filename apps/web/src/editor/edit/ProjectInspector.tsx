import { useState } from "react";
import { FORMAT_SIZE, type VideoFormat } from "@motionily/protocol";
import { FormatPicker } from "../../components/FormatPicker";
import { RESOLUTIONS, projectResolution, setProjectResolution } from "../../export/resolution";
import type { EditorProps } from "../context";

/** Size of the output for a short side, like "2160 × 3840". */
function outputSize(format: VideoFormat, shortSide: number) {
  const [w, h] = FORMAT_SIZE[format];
  const k = shortSide / Math.min(w, h);
  return `${Math.round((w * k) / 2) * 2} × ${Math.round((h * k) / 2) * 2}`;
}

/**
 * What the Inspector shows with nothing selected: the project's settings. The format reshapes the
 * frame (full-frame clips follow it); the resolution is what Export renders at.
 */
export function ProjectInspector({ ed, onFormat }: { ed: EditorProps; onFormat: (f: VideoFormat) => void }) {
  const project = ed.project;
  const [shortSide, setShortSide] = useState(() => projectResolution(project?.id));
  if (!project) return null;
  return (
    <div className="flex flex-col gap-5 text-sm">
      <div>
        <p className="text-sm font-semibold">Project settings</p>
        <p className="text-xs text-neutral-500">Select a clip, a sound or a graphic on the timeline to edit it.</p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-neutral-400">Format</span>
        <FormatPicker value={project.format} onChange={onFormat} />
        <p className="text-[11px] text-neutral-500">Clips that fill the frame are reframed to the new shape; graphics are recomposed by the agent.</p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-neutral-400">Resolution</span>
        <div className="grid grid-cols-4 gap-1 rounded-lg bg-neutral-900 p-1">
          {RESOLUTIONS.map((r) => (
            <button
              key={r.shortSide}
              type="button"
              onClick={() => {
                setShortSide(r.shortSide);
                setProjectResolution(project.id, r.shortSide);
              }}
              className={`rounded-md py-1.5 text-xs ${shortSide === r.shortSide ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-neutral-500 tabular-nums">Exports at {outputSize(project.format, shortSide)} px</p>
      </div>
    </div>
  );
}
