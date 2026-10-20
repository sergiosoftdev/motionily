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

/** Transcribe in a worker; `onProgress` gets human-readable steps. */
export function transcribe(audio: Float32Array, onProgress: (label: string, ratio: number | null) => void): Promise<CaptionWord[]> {
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
    w.postMessage({ type: WhisperMsg.Transcribe, audio, language: "english" }, [audio.buffer]);
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

/** Numbers, long words and shouting tend to be the words worth highlighting. */
export function isKeyWord(word: string): boolean {
  const bare = word.replace(/[^\p{L}\p{N}%€$]/gu, "");
  return /\d/.test(bare) || bare.length >= 9 || (bare.length >= 3 && bare === bare.toUpperCase() && /\p{L}/u.test(bare));
}
