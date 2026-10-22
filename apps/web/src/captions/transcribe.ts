import { WHISPER_SAMPLE_RATE, WhisperMsg, type FromWorker, type WhisperChunk } from "./protocol";

export type CaptionWord = { text: string; start: number; end: number; emphasis?: boolean };

/** Decode any audio/video file to mono 16 kHz samples. */
export async function decodeForWhisper(source: Blob | string): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
  try {
    const bytes = typeof source === "string" ? await (await fetch(source)).arrayBuffer() : await source.arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    return buffer.getChannelData(0);
  } finally {
    void ctx.close();
  }
}

let worker: Worker | null = null;

/** Transcribe in a worker; `language` = what is spoken (Whisper's name or ISO code: it never guesses, English by default). */
export function transcribe(audio: Float32Array, onProgress: (label: string, ratio: number | null) => void, language = "english"): Promise<CaptionWord[]> {
  worker ??= new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  const w = worker;
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      switch (msg.type) {
        case WhisperMsg.Progress:
          onProgress(msg.label, msg.ratio);
          break;
        case WhisperMsg.Done:
          resolve(toWords(msg.chunks));
          break;
        case WhisperMsg.Error:
          reject(new Error(msg.message));
          break;
      }
    };
    // Copy before transferring: the caller keeps its samples to align the words with.
    const copy = audio.slice();
    w.postMessage({ type: WhisperMsg.Transcribe, audio: copy, language }, [copy.buffer]);
  });
}

/** Whisper chunks -> caption words, with a first guess at key words. */
export function toWords(chunks: WhisperChunk[]): CaptionWord[] {
  const words: CaptionWord[] = [];
  for (const c of chunks) {
    const text = c.text.trim();
    if (!text) continue;
    const start = c.timestamp[0];
    const end = Math.max(start, c.timestamp[1] ?? start + 0.3);
    const prev = words.at(-1);
    words.push({ text, start: Math.max(start, prev?.start ?? 0), end, emphasis: isKeyWord(text) });
  }
  return words;
}

/**
 * Whisper's word starts often land a few hundred ms before or after the sound. Move each start to the
 * nearest real onset (silence → speech) in the waveform, within ±0.4 s.
 */
export function snapToSpeech(words: CaptionWord[], audio: Float32Array, rate = WHISPER_SAMPLE_RATE): CaptionWord[] {
  const hop = Math.round(rate / 100); // 10 ms frames
  const frames = Math.floor(audio.length / hop);
  const env = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += (audio[i] ?? 0) ** 2;
    env[f] = Math.sqrt(sum / hop);
    peak = Math.max(peak, env[f] ?? 0);
  }
  const at = (f: number) => env[f] ?? 0;
  const threshold = peak * 0.08;
  const onsetNear = (t: number) => {
    const c = Math.round(t * 100);
    let best = -1;
    for (let f = Math.max(5, c - 40); f <= Math.min(frames - 1, c + 40); f++) {
      if (at(f) < threshold || at(f - 5) >= threshold) continue;
      if (best < 0 || Math.abs(f - c) < Math.abs(best - c)) best = f;
    }
    return best < 0 ? t : best / 100;
  };
  let last = 0;
  return words.map((w) => {
    const start = Math.max(last, onsetNear(w.start));
    last = start;
    return { ...w, start, end: Math.max(start + 0.05, w.end) };
  });
}

/** Numbers, long words and shouting tend to be the words worth highlighting. */
export function isKeyWord(word: string): boolean {
  const bare = word.replace(/[^\p{L}\p{N}%€$]/gu, "");
  return /\d/.test(bare) || bare.length >= 9 || (bare.length >= 3 && bare === bare.toUpperCase() && /\p{L}/u.test(bare));
}
