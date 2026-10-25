import { EXPORT_PRESETS, type Output } from "@motionily/protocol";
import { desktop } from "../desktop";
import { revealFile } from "./nativeExport";
import { JobStatus, cancel, clearFinished, enqueue, useExportQueue } from "./queue";

const STATUS_LABEL: Record<JobStatus, string> = { queued: "Waiting", rendering: "Rendering", done: "Done", failed: "Failed", cancelled: "Cancelled" };

/**
 * The render queue: presets (or the settings above) added as jobs that render one after the other while
 * you keep editing; each takes the video as it is when its turn comes.
 */
export function QueueSection({ current }: { current: Output }) {
  const jobs = useExportQueue((s) => s.jobs);
  const presets = EXPORT_PRESETS.filter((p) => desktop || !p.desktop);
  const add = (label: string, output: Output) => void enqueue([{ label, output: { ...output, ...(current.range ? { range: current.range } : {}) } }]);
  return (
    <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-300">Queue</span>
        {jobs.some((j) => j.status !== JobStatus.Queued && j.status !== JobStatus.Rendering) && (
          <button type="button" onClick={clearFinished} className="text-[11px] text-neutral-500 hover:text-white">
            Clear finished
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        <button type="button" onClick={() => add(`${current.short_side}p ${current.codec}`, current)} className="rounded-md bg-neutral-800 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700">
          + These settings
        </button>
        {presets.map((p) => (
          <button key={p.name} type="button" onClick={() => add(p.name, p.output)} className="rounded-md bg-neutral-800 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700">
            + {p.name}
          </button>
        ))}
      </div>
      {jobs.map((j) => (
        <div key={j.id} className="flex flex-col gap-1 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-neutral-300">{j.label}</span>
            <span className="flex shrink-0 items-center gap-2 text-neutral-500">
              {j.status === JobStatus.Rendering ? `${Math.round(j.progress * 100)}%` : STATUS_LABEL[j.status]}
              {(j.status === JobStatus.Queued || j.status === JobStatus.Rendering) && (
                <button type="button" onClick={() => cancel(j.id)} className="hover:text-white">
                  Cancel
                </button>
              )}
              {j.status === JobStatus.Done && j.file && (
                <button type="button" onClick={() => void revealFile(j.file!)} className="text-neutral-300 hover:text-white">
                  Show
                </button>
              )}
              {j.status === JobStatus.Done && j.url && (
                <a href={j.url} download className="text-neutral-300 hover:text-white">
                  Download
                </a>
              )}
            </span>
          </div>
          {j.status === JobStatus.Rendering && (
            <div className="h-1 overflow-hidden rounded-full bg-neutral-800">
              <div className="h-full bg-white transition-[width]" style={{ width: `${Math.round(j.progress * 100)}%` }} />
            </div>
          )}
          {j.error && <span className="text-red-400">{j.error}</span>}
        </div>
      ))}
    </div>
  );
}
