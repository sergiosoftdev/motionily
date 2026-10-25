import { create } from "zustand";
import type { Output } from "@motionily/protocol";

/** Where a queued export is. */
export const JobStatus = { Queued: "queued", Rendering: "rendering", Done: "done", Failed: "failed", Cancelled: "cancelled" } as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

/** One render of the queue: a preset (or the dialog's settings) and how it went. */
export type ExportJob = { id: number; label: string; output: Output; status: JobStatus; progress: number; file?: string; url?: string; error?: string };
/** What a render gives back: a path on disk (desktop app) or a download URL (browser). */
export type Rendered = { file?: string; url?: string };
/** Renders one output; set by the editor screen (native in the desktop app, WebCodecs in the browser). */
export type Renderer = (output: Output, onProgress: (ratio: number) => void, signal: AbortSignal) => Promise<Rendered>;

type QueueState = { jobs: ExportJob[] };
export const useExportQueue = create<QueueState>(() => ({ jobs: [] }));

let renderer: Renderer | null = null;
let nextId = 1;
let running = false;
let current: { id: number; abort: AbortController } | null = null;
const waiting = new Map<number, (job: ExportJob) => void>();

const update = (id: number, patch: Partial<ExportJob>) => useExportQueue.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));
const job = (id: number) => useExportQueue.getState().jobs.find((j) => j.id === id)!;

/** The editor screen's renderer (null while no video is open: queued jobs wait). */
export function setRenderer(r: Renderer | null) {
  renderer = r;
  if (r) void drain();
}

/**
 * Queue renders; they run one after the other with the video as it is when each starts. Resolves with
 * the jobs once every one of these is finished (done, failed or cancelled).
 */
export function enqueue(items: { label: string; output: Output }[]): Promise<ExportJob[]> {
  const added = items.map((i) => ({ id: nextId++, label: i.label, output: i.output, status: JobStatus.Queued, progress: 0 }) satisfies ExportJob);
  useExportQueue.setState((s) => ({ jobs: [...s.jobs, ...added] }));
  const done = Promise.all(added.map((a) => new Promise<ExportJob>((resolve) => waiting.set(a.id, resolve))));
  void drain();
  return done;
}

/** Cancel a job: a queued one is skipped, the rendering one stops. */
export function cancel(id: number) {
  const j = job(id);
  if (!j) return;
  if (j.status === JobStatus.Queued) finish(id, { status: JobStatus.Cancelled });
  else if (j.status === JobStatus.Rendering && current?.id === id) current.abort.abort();
}

/** Forget finished jobs. */
export function clearFinished() {
  useExportQueue.setState((s) => ({ jobs: s.jobs.filter((j) => j.status === JobStatus.Queued || j.status === JobStatus.Rendering) }));
}

function finish(id: number, patch: Partial<ExportJob>) {
  update(id, patch);
  waiting.get(id)?.(job(id));
  waiting.delete(id);
}

async function drain() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const r = renderer;
      const next = useExportQueue.getState().jobs.find((j) => j.status === JobStatus.Queued);
      if (!r || !next) return;
      const abort = new AbortController();
      current = { id: next.id, abort };
      update(next.id, { status: JobStatus.Rendering, progress: 0 });
      try {
        const out = await r(next.output, (p) => update(next.id, { progress: p }), abort.signal);
        finish(next.id, { status: JobStatus.Done, progress: 1, ...out });
      } catch (e) {
        const aborted = e instanceof DOMException && e.name === "AbortError";
        finish(next.id, aborted ? { status: JobStatus.Cancelled } : { status: JobStatus.Failed, error: e instanceof Error ? e.message : String(e) });
      } finally {
        current = null;
      }
    }
  } finally {
    running = false;
  }
}
