import { useEffect, useRef, useState } from "react";
import { OpName, type Project } from "@motionily/protocol";
import { api, mediaUrl } from "../api/client";
import { engineHost } from "../engine/host";
import { agentBridge } from "../bridge";
import { ActivitySource, logActivity } from "../store";
import { decodeForWhisper, transcribe } from "./transcribe";
import { startGenerate, takePipeline, VideoPipeline } from "../pipeline";

const ENGINE_POLL_MS = 300;

const Status = { Idle: "idle", Working: "working", Done: "done", Error: "error" } as const;
type Status = (typeof Status)[keyof typeof Status];

/** Upload the voice-over, transcribe it in the browser and turn it into timed captions. */
export function CaptionsPanel({ project, onProject }: { project: Project; onProject: (p: Project) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const audio = project.audio;
  const [status, setStatus] = useState<Status>(Status.Idle);
  const [progress, setProgress] = useState<{ label: string; ratio: number | null }>({ label: "", ratio: null });
  const [words, setWords] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setStatus(Status.Working);
    setProgress({ label: "Uploading the audio…", ratio: null });
    try {
      const p = await api.uploadAudio(project.id, f);
      onProject(p);
      void engineHost.setAudio(p.audio ? mediaUrl(p.audio.url) : null);
      setStatus(Status.Idle);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(Status.Error);
    }
  };

  const run = async () => {
    if (!audio) return;
    setStatus(Status.Working);
    setError(null);
    try {
      setProgress({ label: "Leyendo audio…", ratio: null });
      const samples = await decodeForWhisper(mediaUrl(audio.url));
      const result = await transcribe(samples, (label, ratio) => setProgress({ label, ratio }));
      const duration = Math.max(engineHost.duration(), (result.at(-1)?.end ?? 0) + 0.5);
      engineHost.applyOps([
        { op: OpName.SetDuration, duration },
        { op: OpName.SetCaptions, captions: { words: result } },
      ]);
      agentBridge.sceneChanged();
      setWords(result.length);
      setStatus(Status.Done);
      logActivity(ActivitySource.User, `Captions: ${result.length} words transcribed`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(Status.Error);
    }
  };

  // Fresh from the wizard with a voice: transcribe as soon as the engine is up, then hand over to the agent.
  useEffect(() => {
    if (!audio || !takePipeline(project.id, VideoPipeline.TranscribeThenGenerate)) return;
    const wait = setInterval(() => {
      if (!engineHost.ready) return;
      clearInterval(wait);
      void run().then(() => startGenerate(project.id));
    }, ENGINE_POLL_MS);
    return () => clearInterval(wait);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const clear = () => {
    engineHost.applyOps([{ op: OpName.SetCaptions, captions: null }]);
    agentBridge.sceneChanged();
    setWords(0);
    setStatus(Status.Idle);
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-2 text-[11px] font-medium text-neutral-500">Voice & captions</h3>
      <input ref={input} type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => void choose(e.target.files?.[0])} />
      <div className="flex items-center gap-2 px-2">
        <button type="button" onClick={() => input.current?.click()} className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700">
          {audio ? "Change audio" : "Upload voice or video"}
        </button>
        {audio && status !== Status.Working && (
          <button type="button" onClick={() => void run()} className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700">
            {words ? "Transcribe again" : "Generate captions"}
          </button>
        )}
      </div>
      <p className="px-2 text-xs text-neutral-500">
        {status === Status.Working
          ? `${progress.label}${progress.ratio !== null ? ` ${Math.round(progress.ratio * 100)}%` : ""}`
          : status === Status.Done
            ? `${words} words. Key words are highlighted according to the caption style.`
            : audio
              ? `${audio.name} · plays with the preview and you can trim it below. Transcription runs in your browser.`
              : "The first time it downloads the speech model (~150 MB), then it stays cached."}
      </p>
      {status === Status.Done && (
        <button type="button" onClick={clear} className="self-start px-2 text-xs text-neutral-500 hover:text-white">
          Remove captions
        </button>
      )}
      {error && <p className="px-2 text-xs text-red-400">{error}</p>}
    </section>
  );
}
