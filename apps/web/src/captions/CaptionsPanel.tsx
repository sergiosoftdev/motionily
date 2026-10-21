import { useEffect, useRef, useState } from "react";
import { OpName, type Project, type Voice, type VoiceModel } from "@motionily/protocol";
import { api, mediaUrl } from "../api/client";
import { engineHost } from "../engine/host";
import { agentBridge } from "../bridge";
import { ActivitySource, logActivity } from "../store";
import { decodeForWhisper, isKeyWord, snapToSpeech, transcribe, type CaptionWord } from "./transcribe";
import { VoicePicker } from "../voice/ElevenLabs";
import { startGenerate, takePipeline, VideoPipeline } from "../pipeline";
import { VoiceSyncDialog } from "./VoiceSyncDialog";

const ENGINE_POLL_MS = 300;

const Status = { Idle: "idle", Working: "working", Done: "done", Error: "error" } as const;
type Status = (typeof Status)[keyof typeof Status];

/**
 * The voice-over: generated with the user's ElevenLabs voices (each word comes timed), or
 * uploaded and transcribed in the browser. Either way it becomes timed captions.
 */
export function CaptionsPanel({ project, onProject, hasScene }: { project: Project; onProject: (p: Project) => void; hasScene: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const audio = project.audio;
  const [status, setStatus] = useState<Status>(Status.Idle);
  const [progress, setProgress] = useState<{ label: string; ratio: number | null }>({ label: "", ratio: null });
  const [words, setWords] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [askSync, setAskSync] = useState(false);
  const [picking, setPicking] = useState(false);

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setStatus(Status.Working);
    setProgress({ label: "Uploading the audio…", ratio: null });
    try {
      const p = await api.uploadAudio(project.id, f);
      onProject(p);
      void engineHost.setAudio(p.audio ? mediaUrl(p.audio.url) : null);
      setStatus(Status.Idle);
      if (hasScene) setAskSync(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(Status.Error);
    }
  };

  const run = async (a: Project["audio"] = audio) => {
    if (!a) return;
    setStatus(Status.Working);
    setError(null);
    try {
      let result: CaptionWord[];
      if (a.words?.length) {
        // Generated with ElevenLabs: the exact timing came with the audio.
        result = a.words.map((w) => ({ ...w, emphasis: isKeyWord(w.text) }));
      } else {
        setProgress({ label: "Reading the audio…", ratio: null });
        const samples = await decodeForWhisper(mediaUrl(a.url));
        result = snapToSpeech(await transcribe(samples, (label, ratio) => setProgress({ label, ratio })), samples);
      }
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

  /** Read the video's script with an ElevenLabs voice; captions follow at once from its timing. */
  const speak = async (voice: Voice, model: VoiceModel) => {
    setStatus(Status.Working);
    setError(null);
    setProgress({ label: `${voice.name} is reading the script in ElevenLabs…`, ratio: null });
    try {
      const p = await api.generateVoice(project.id, { voiceId: voice.id, voiceName: voice.name, modelId: model });
      onProject(p);
      setPicking(false);
      await engineHost.setAudio(p.audio ? mediaUrl(p.audio.url) : null);
      logActivity(ActivitySource.User, `Voice-over generated with ${voice.name} (ElevenLabs)`);
      await run(p.audio);
      if (hasScene) setAskSync(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(Status.Error);
    }
  };

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
        <button type="button" onClick={() => setPicking((v) => !v)} className={`rounded-lg px-3 py-1.5 text-xs ${picking ? "bg-white text-neutral-900" : "bg-neutral-800 hover:bg-neutral-700"}`}>
          {audio?.words ? "New ElevenLabs voice" : "Generate with ElevenLabs"}
        </button>
        <button type="button" onClick={() => input.current?.click()} className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700">
          {audio ? "Upload another" : "Upload voice or video"}
        </button>
      </div>
      {picking && (
        <div className="px-2 py-2">
          {project.voiceScript.trim() ? (
            <VoicePicker compact cta="Generate voice" busy={status === Status.Working} onGenerate={(v, m) => void speak(v, m)} />
          ) : (
            <p className="text-xs text-neutral-500">There is no script yet: write it in the new-video flow or ask the agent for one.</p>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 px-2">
        {audio && status !== Status.Working && (
          <button type="button" onClick={() => void run()} className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700">
            {words ? (audio.words ? "Rebuild captions" : "Transcribe again") : "Generate captions"}
          </button>
        )}
      </div>
      <p className="px-2 text-xs text-neutral-500">
        {status === Status.Working
          ? `${progress.label}${progress.ratio !== null ? ` ${Math.round(progress.ratio * 100)}%` : ""}`
          : status === Status.Done
            ? `${words} words. Key words are highlighted according to the caption style.`
            : audio?.words
              ? `${audio.name} · every word is timed by ElevenLabs, so captions need no transcription.`
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
      {askSync && (
        <VoiceSyncDialog
          onKeep={() => setAskSync(false)}
          onAdapt={() => {
            setAskSync(false);
            void run().then(() => startGenerate(project.id));
          }}
        />
      )}
    </section>
  );
}
