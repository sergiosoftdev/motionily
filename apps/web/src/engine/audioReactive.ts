/**
 * Audio-reactive expressions (`vol`, `beat`, `bass`, `spec(k)`…): the project's voice-over/music is
 * decoded here to mono at the engine's fixed analysis rate and analysed in Rust (`analyzeAudio`).
 * Nothing is saved with the scene: the same file always gives the same analysis, so it is simply
 * recomputed whenever the editor loads the audio.
 */
import { audioSampleRate } from "./pkg/engine_wasm.js";

export type AudioAnalysisInfo = { duration: number; beats: number[]; bpm: number | null };

/** Mono samples of `url` at the analysis rate (an OfflineAudioContext decodes at its own fixed rate). */
export async function decodeMono(url: string): Promise<{ samples: Float32Array; rate: number }> {
  const rate = audioSampleRate();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio ${res.status}`);
  const buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(await res.arrayBuffer());
  const samples = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < data.length; i++) samples[i]! += data[i]! / buf.numberOfChannels;
  }
  return { samples, rate };
}
