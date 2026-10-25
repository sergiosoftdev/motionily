import { DEFAULT_OUTPUT, FORMAT_SIZE, FRAME_RATES, OpName, OutputCodec, type Output, type VideoFormat } from "@motionily/protocol";
import { FormatPicker } from "../../components/FormatPicker";
import { desktop } from "../../desktop";
import { RESOLUTIONS } from "../../export/resolution";
import type { EditorProps } from "../context";
import type { SceneView } from "../sceneView";
import type { EditActions } from "./useEditActions";
import { LoudnessSection } from "./LoudnessSection";
import { MixerSection } from "./MixerSection";
import { VersionsSection } from "./VersionsSection";

/** Codecs by where they can be written: the desktop app has ffmpeg, the browser has WebCodecs (H.264). */
const CODECS: { codec: OutputCodec; label: string; hint: string; desktopOnly: boolean }[] = [
  { codec: OutputCodec.H264, label: "H.264", hint: "MP4, plays everywhere", desktopOnly: false },
  { codec: OutputCodec.Hevc, label: "HEVC", hint: "MP4, 10-bit, smaller files", desktopOnly: true },
  { codec: OutputCodec.Prores, label: "ProRes", hint: "MOV, 422 HQ for editing", desktopOnly: true },
  { codec: OutputCodec.Prores4444, label: "ProRes 4444", hint: "MOV with transparency", desktopOnly: true },
  { codec: OutputCodec.Vp9Alpha, label: "VP9 alpha", hint: "WebM with transparency", desktopOnly: true },
];

/** Size of the output for a short side, like "2160 × 3840". */
function outputSize(format: VideoFormat, shortSide: number) {
  const [w, h] = FORMAT_SIZE[format];
  const k = shortSide / Math.min(w, h);
  return `${Math.round((w * k) / 2) * 2} × ${Math.round((h * k) / 2) * 2}`;
}

const ROW = "grid gap-1 rounded-lg bg-neutral-900 p-1";
const OPTION = (on: boolean) => `rounded-md py-1.5 text-xs ${on ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`;

/**
 * What the Inspector shows with nothing selected: the project's settings, saved in the scene
 * (`set_output`, `set_fps`) so Export and agents read the same values. The format reshapes the frame
 * (full-frame clips follow it); resolution, codec and range are what Export renders.
 */
export function ProjectInspector({ ed, scene, edits, onFormat }: { ed: EditorProps; scene: SceneView | null; edits: EditActions; onFormat: (f: VideoFormat) => void }) {
  const project = ed.project;
  if (!project || !scene) return null;
  const output: Output = { ...DEFAULT_OUTPUT, ...(scene.output ?? {}) };
  const setOutput = (o: Partial<Output>, what: string) => {
    const next = { ...output, ...o };
    if (!next.range) delete next.range;
    edits.apply([{ op: OpName.SetOutput, output: next }], what, false);
  };
  const fps = scene.fps ?? 30;
  const codecs = CODECS.filter((c) => desktop || !c.desktopOnly);
  const range = scene.work_area;
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
        <span className="text-xs text-neutral-400">Frame rate</span>
        <select
          value={fps}
          onChange={(e) => edits.apply([{ op: OpName.SetFps, fps: Number(e.target.value) }], `Frame rate: ${e.target.value} fps`, false)}
          className="rounded-md bg-neutral-900 px-2 py-1.5 text-sm text-white"
        >
          {[...new Set<number>([...FRAME_RATES, fps])].sort((a, b) => a - b).map((r) => (
            <option key={r} value={r}>
              {r} fps
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-neutral-400">Resolution</span>
        <div className={`${ROW} grid-cols-5`}>
          {RESOLUTIONS.map((r) => (
            <button key={r.shortSide} type="button" onClick={() => setOutput({ short_side: r.shortSide }, `Export resolution: ${r.label}`)} className={OPTION(output.short_side === r.shortSide)}>
              {r.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-neutral-500 tabular-nums">Exports at {outputSize(project.format, output.short_side)} px</p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-neutral-400">Codec</span>
        <select value={output.codec} onChange={(e) => setOutput({ codec: e.target.value as OutputCodec }, `Export codec: ${e.target.value}`)} className="rounded-md bg-neutral-900 px-2 py-1.5 text-sm text-white">
          {codecs.map((c) => (
            <option key={c.codec} value={c.codec}>
              {c.label} · {c.hint}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center justify-between gap-2 text-xs text-neutral-400">
        <span>
          Export only the in–out range
          <span className="block text-[11px] text-neutral-500">{range ? `${range[0].toFixed(2)}–${range[1].toFixed(2)} s (I and O on the timeline)` : "Set it with I and O on the timeline"}</span>
        </span>
        <input
          type="checkbox"
          disabled={!range && !output.range}
          checked={!!output.range}
          onChange={(e) => setOutput({ range: e.target.checked && range ? range : undefined }, e.target.checked ? "Exports the in–out range" : "Exports the whole video")}
          className="accent-white"
        />
      </label>
      <LoudnessSection mix={scene.mix} edits={edits} />
      <MixerSection scene={scene} footage={project.footage ?? []} edits={edits} />
      <VersionsSection projectId={project.id} />
    </div>
  );
}
