import { useEffect, useState } from "react";
import { OpName, type Project } from "@motionily/protocol";
import { mediaUrl } from "../api/client";
import { engineHost } from "../engine/host";
import { agentBridge } from "../bridge";
import { ActivitySource, logActivity } from "../store";
import { startGenerate, takePipeline, VideoPipeline } from "../pipeline";
import { decodeForWhisper, isKeyWord, snapToSpeech, transcribe, type CaptionWord } from "./transcribe";

const ENGINE_POLL_MS = 300;

export type VoiceAudio = NonNullable<Project["audio"]>;
export type CaptionProgress = { label: string; ratio: number | null };

/** The voice's timed words: ElevenLabs sends them with the audio, anything else is transcribed in the browser. */
export async function voiceWords(audio: VoiceAudio, onProgress: (p: CaptionProgress) => void): Promise<CaptionWord[]> {
  if (audio.words?.length) return audio.words.map((w) => ({ ...w, emphasis: isKeyWord(w.text) }));
  onProgress({ label: "Reading the audio…", ratio: null });
  const samples = await decodeForWhisper(mediaUrl(audio.url));
  return snapToSpeech(await transcribe(samples, (label, ratio) => onProgress({ label, ratio })), samples);
}

/** Put the words on the video as captions; the video lasts at least as long as the voice. */
export function applyCaptions(words: CaptionWord[]) {
  const duration = Math.max(engineHost.duration(), (words.at(-1)?.end ?? 0) + 0.5);
  engineHost.applyOps([
    { op: OpName.SetDuration, duration },
    { op: OpName.SetCaptions, captions: { words } },
  ]);
  agentBridge.sceneChanged();
  logActivity(ActivitySource.User, `Captions: ${words.length} words transcribed`);
}

/**
 * Fresh from the wizard with a voice: caption it as soon as the engine is up, then hand over to
 * the agent. Lives on the editor screen, so it runs whichever panels are open.
 */
export function useVoicePipeline(project: Project | null): CaptionProgress | null {
  const [progress, setProgress] = useState<CaptionProgress | null>(null);
  const audio = project?.audio ?? null;
  useEffect(() => {
    if (!project || !audio || !takePipeline(project.id, VideoPipeline.TranscribeThenGenerate)) return;
    setProgress({ label: "Captioning the voice…", ratio: null });
    const wait = setInterval(() => {
      if (!engineHost.ready) return;
      clearInterval(wait);
      voiceWords(audio, setProgress)
        .then(applyCaptions)
        .catch((e: Error) => logActivity(ActivitySource.System, `Captions failed: ${e.message}`))
        .finally(() => {
          setProgress(null);
          startGenerate(project.id);
        });
    }, ENGINE_POLL_MS);
    return () => clearInterval(wait);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);
  return progress;
}
