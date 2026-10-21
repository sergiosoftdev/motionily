import { useEffect, useState } from "react";
import { OpName, type Project } from "@motionily/protocol";
import { api, mediaUrl } from "../api/client";
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
 * Fresh from the wizard or from "Edit footage": caption the voice (or transcribe each clip) as soon
 * as the editor opens, then hand over to the agent. Lives on the editor screen, so it runs whichever
 * panels are open.
 */
export function useVoicePipeline(project: Project | null, onProject: (p: Project) => void): CaptionProgress | null {
  const [progress, setProgress] = useState<CaptionProgress | null>(null);
  useEffect(() => {
    if (!project) return;
    const handOver = () => {
      setProgress(null);
      startGenerate(project.id);
    };
    if (project.footage.length && takePipeline(project.id, VideoPipeline.TranscribeFootageThenGenerate)) {
      let cancelled = false;
      transcribeFootage(project, setProgress, (p) => !cancelled && onProject(p))
        .catch((e: Error) => logActivity(ActivitySource.System, `Transcription failed: ${e.message}`))
        .finally(() => !cancelled && handOver());
      return () => {
        cancelled = true;
      };
    }
    const audio = project.audio;
    if (!audio || !takePipeline(project.id, VideoPipeline.TranscribeThenGenerate)) return;
    setProgress({ label: "Captioning the voice…", ratio: null });
    const wait = setInterval(() => {
      if (!engineHost.ready) return;
      clearInterval(wait);
      voiceWords(audio, setProgress)
        .then(applyCaptions)
        .catch((e: Error) => logActivity(ActivitySource.System, `Captions failed: ${e.message}`))
        .finally(handOver);
    }, ENGINE_POLL_MS);
    return () => clearInterval(wait);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);
  return progress;
}

/** Each clip without a transcript, transcribed in its language and saved, so the agent can cut it by its words. */
async function transcribeFootage(project: Project, onProgress: (p: CaptionProgress) => void, onProject: (p: Project) => void) {
  const pending = project.footage.filter((c) => !c.words);
  for (const [i, clip] of pending.entries()) {
    const which = pending.length > 1 ? ` ${i + 1} of ${pending.length}` : "";
    onProgress({ label: `Listening to clip${which}…`, ratio: null });
    const samples = await decodeForWhisper(mediaUrl(clip.url));
    const words = snapToSpeech(await transcribe(samples, (label, ratio) => onProgress({ label: `Clip${which}: ${label}`, ratio }), clip.language), samples);
    onProject(await api.saveFootageWords(project.id, clip.id, words.map(({ text, start, end }) => ({ text, start, end }))));
    logActivity(ActivitySource.User, `Transcribed ${clip.name}: ${words.length} words`);
  }
}
