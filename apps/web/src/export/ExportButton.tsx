import { useRef, useState } from "react";
import { desktop } from "../desktop";
import { NativeCodec, exportNative, revealFile } from "./nativeExport";
import { renderCurrentScene } from "./renderScene";

const Stage = { Idle: "idle", Rendering: "rendering", Done: "done", Error: "error" } as const;
type Stage = (typeof Stage)[keyof typeof Stage];

const QUALITIES = [
  { shortSide: 1080, label: "1080p" },
  { shortSide: 720, label: "720p" },
];
/** The desktop app renders natively: up to 4K, and pro codecs. */
const NATIVE_QUALITIES = [
  { shortSide: 720, label: "720p" },
  { shortSide: 1080, label: "1080p" },
  { shortSide: 1440, label: "1440p" },
  { shortSide: 2160, label: "4K" },
];
const NATIVE_CODECS = [
  { codec: NativeCodec.H264, label: "MP4", hint: "H.264, plays everywhere" },
  { codec: NativeCodec.Hevc, label: "HEVC", hint: "10-bit, smaller files" },
  { codec: NativeCodec.Prores, label: "ProRes", hint: "422 HQ for editing" },
];
const OPTION_CLASS = (on: boolean) => `rounded-md py-1.5 text-xs ${on ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`;

/** Export the current scene to a video file, rendered frame by frame on the GPU. */
export function ExportButton({ name, audioUrl }: { name: string; audioUrl: string | null }) {
  const [open, setOpen] = useState(false);
  const [shortSide, setShortSide] = useState(1080);
  const [stage, setStage] = useState<Stage>(Stage.Idle);
  const [progress, setProgress] = useState(0);
  const [file, setFile] = useState<{ url: string; filename: string; size: number } | null>(null);
  const [codec, setCodec] = useState<NativeCodec>(NativeCodec.H264);
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
        setSavedPath(await exportNative({ name, shortSide, codec, supersample: shortSide <= 1080, audioUrl, onProgress: setProgress, signal: abort.current.signal }));
        setStage(Stage.Done);
        return;
      }
      const res = await renderCurrentScene({ shortSide, audioUrl, onProgress: setProgress, signal: abort.current.signal });
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
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-semibold hover:bg-neutral-700">
        Export
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => stage !== Stage.Rendering && setOpen(false)}>
          <div className="flex w-full max-w-sm flex-col gap-5 rounded-2xl bg-neutral-900 p-6" onClick={(e) => e.stopPropagation()}>
            <div>
              <h2 className="text-lg font-bold">Export video</h2>
              <p className="mt-1 text-sm text-neutral-400">Rendered frame by frame on your GPU, with the trimmed audio{desktop ? ", saved to Movies/Motionily" : ""}.</p>
            </div>
            <div className={`grid gap-1 rounded-lg bg-neutral-950 p-1 ${desktop ? "grid-cols-4" : "grid-cols-2"}`}>
              {(desktop ? NATIVE_QUALITIES : QUALITIES).map((q) => (
                <button key={q.shortSide} type="button" disabled={stage === Stage.Rendering} onClick={() => setShortSide(q.shortSide)} className={OPTION_CLASS(shortSide === q.shortSide)}>
                  {q.label}
                </button>
              ))}
            </div>
            {desktop && (
              <div className="flex flex-col gap-1.5">
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-neutral-950 p-1">
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
          </div>
        </div>
      )}
    </>
  );
}
