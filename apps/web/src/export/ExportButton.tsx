import { useRef, useState } from "react";
import { OpName, OutputCodec, type Output } from "@motionily/protocol";
import { agentBridge } from "../bridge";
import { desktop } from "../desktop";
import { engineHost } from "../engine/host";
import { exportNative, revealFile } from "./nativeExport";
import { renderCurrentScene } from "./renderScene";
import { RESOLUTIONS, sceneOutput } from "./resolution";
import { SideFilesRow } from "./SideFilesRow";
import { QueueSection } from "./QueueSection";
import { JobStatus, useExportQueue } from "./queue";

const Stage = { Idle: "idle", Rendering: "rendering", Done: "done", Error: "error" } as const;
type Stage = (typeof Stage)[keyof typeof Stage];

const QUALITIES = [
  { shortSide: 1080, label: "1080p" },
  { shortSide: 720, label: "720p" },
];
/** The desktop app renders natively: up to 4K, and pro codecs. */
const NATIVE_QUALITIES = RESOLUTIONS;
const NATIVE_CODECS = [
  { codec: OutputCodec.H264, label: "MP4", hint: "H.264, plays everywhere" },
  { codec: OutputCodec.Hevc, label: "HEVC", hint: "10-bit, smaller files" },
  { codec: OutputCodec.Prores, label: "ProRes", hint: "422 HQ for editing" },
  { codec: OutputCodec.Prores4444, label: "4444", hint: "ProRes 4444 with transparency" },
  { codec: OutputCodec.Vp9Alpha, label: "VP9α", hint: "WebM with transparency" },
];

/** What this exporter can render of the scene's settings (the browser: 720/1080 H.264). */
function usable(o: Output): Output {
  if (desktop) return o;
  return { ...o, codec: OutputCodec.H264, short_side: QUALITIES.some((q) => q.shortSide === o.short_side) ? o.short_side : 1080 };
}
const OPTION_CLASS = (on: boolean) => `rounded-md py-1.5 text-xs ${on ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`;

/** Export the current scene to a video file, rendered frame by frame on the GPU. */
export function ExportButton({ name, audioUrl }: { projectId: string; name: string; audioUrl: string | null }) {
  const [open, setOpen] = useState(false);
  /** Queued renders still to finish (shown on the button while you keep editing). */
  const pending = useExportQueue((s) => s.jobs.filter((j) => j.status === JobStatus.Queued || j.status === JobStatus.Rendering).length);
  // The scene's export settings (Project settings, set_output), as this exporter can render them.
  const [output, setOutputState] = useState<Output>(() => usable(sceneOutput()));
  const shortSide = output.short_side;
  const codec = output.codec;
  /** A choice made here is the project's setting from now on (the agent sees it too). */
  const choose = (o: Partial<Output>) => {
    setOutputState({ ...output, ...o });
    engineHost.applyOps([{ op: OpName.SetOutput, output: { ...sceneOutput(), ...o } }]);
    agentBridge.sceneChanged();
  };
  const setShortSide = (v: number) => choose({ short_side: v });
  const setCodec = (v: OutputCodec) => choose({ codec: v });
  const [stage, setStage] = useState<Stage>(Stage.Idle);
  const [progress, setProgress] = useState(0);
  const [file, setFile] = useState<{ url: string; filename: string; size: number } | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const start = async () => {
    setStage(Stage.Rendering);
    setProgress(0);
    setError(null);
    abort.current = new AbortController();
    try {
      if (desktop) {
        setSavedPath(await exportNative({ name, shortSide, codec, range: output.range ?? null, supersample: shortSide <= 1080, audioUrl, onProgress: setProgress, signal: abort.current.signal }));
        setStage(Stage.Done);
        return;
      }
      const res = await renderCurrentScene({ shortSide, range: output.range ?? null, audioUrl, onProgress: setProgress, signal: abort.current.signal });
      if (file) URL.revokeObjectURL(file.url);
      setFile({ url: URL.createObjectURL(res.blob), filename: `${name || "motionily"}.${res.extension}`, size: res.blob.size });
      setStage(Stage.Done);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return setStage(Stage.Idle);
      setError(e instanceof Error ? e.message : String(e));
      setStage(Stage.Error);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (stage !== Stage.Rendering) setOutputState(usable(sceneOutput()));
          setOpen(true);
        }}
        className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-semibold hover:bg-neutral-700"
      >
        Export
        {pending > 0 && <span className="ml-1.5 rounded-full bg-white px-1.5 text-[10px] text-neutral-900 tabular-nums">{pending}</span>}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => stage !== Stage.Rendering && setOpen(false)}>
          <div className="flex max-h-[90vh] w-full max-w-sm flex-col gap-5 overflow-y-auto rounded-2xl bg-neutral-900 p-6" onClick={(e) => e.stopPropagation()}>
            <div>
              <h2 className="text-lg font-bold">Export video</h2>
              <p className="mt-1 text-sm text-neutral-400">Rendered frame by frame on your GPU, with the trimmed audio{desktop ? ", saved to Movies/Motionily" : ""}.</p>
            </div>
            <div className={`grid gap-1 rounded-lg bg-neutral-950 p-1 ${desktop ? "grid-cols-5" : "grid-cols-2"}`}>
              {(desktop ? NATIVE_QUALITIES : QUALITIES).map((q) => (
                <button key={q.shortSide} type="button" disabled={stage === Stage.Rendering} onClick={() => setShortSide(q.shortSide)} className={OPTION_CLASS(shortSide === q.shortSide)}>
                  {q.label}
                </button>
              ))}
            </div>
            {desktop && (
              <div className="flex flex-col gap-1.5">
                <div className="grid grid-cols-5 gap-1 rounded-lg bg-neutral-950 p-1">
                  {NATIVE_CODECS.map((c) => (
                    <button key={c.codec} type="button" disabled={stage === Stage.Rendering} onClick={() => setCodec(c.codec)} className={OPTION_CLASS(codec === c.codec)}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-neutral-500">{NATIVE_CODECS.find((c) => c.codec === codec)?.hint}</p>
              </div>
            )}
            {stage === Stage.Rendering && (
              <div className="flex flex-col gap-2">
                <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
                  <div className="h-full bg-white transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
                <div className="flex justify-between text-xs text-neutral-400">
                  <span>Rendering… {Math.round(progress * 100)}%</span>
                  <button type="button" onClick={() => abort.current?.abort()} className="hover:text-white">
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {stage === Stage.Done && savedPath && (
              <button type="button" onClick={() => void revealFile(savedPath)} className="rounded-lg bg-white px-4 py-2.5 text-center text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
                Saved · Show {savedPath.split(/[\\/]/).pop()}
              </button>
            )}
            {stage === Stage.Done && !savedPath && file && (
              <a href={file.url} download={file.filename} className="rounded-lg bg-white px-4 py-2.5 text-center text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
                Download {file.filename} · {(file.size / 1e6).toFixed(1)} MB
              </a>
            )}
            {stage === Stage.Error && <p className="text-xs text-red-400">{error}</p>}
            {(stage === Stage.Idle || stage === Stage.Error) && (
              <button type="button" onClick={() => void start()} className="rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
                Export
              </button>
            )}
            <QueueSection current={output} />
            <SideFilesRow name={name} />
          </div>
        </div>
      )}
    </>
  );
}
