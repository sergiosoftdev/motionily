/** Messages between the editor and the Whisper worker. */
export const WhisperMsg = {
  Transcribe: "transcribe",
  Progress: "progress",
  Done: "done",
  Error: "error",
} as const;

export type WhisperChunk = { text: string; timestamp: [number, number | null] };

export type ToWorker = { type: typeof WhisperMsg.Transcribe; audio: Float32Array; language: string };
export type FromWorker =
  | { type: typeof WhisperMsg.Progress; label: string; ratio: number | null }
  | { type: typeof WhisperMsg.Done; chunks: WhisperChunk[] }
  | { type: typeof WhisperMsg.Error; message: string };

/** Whisper wants mono 16 kHz audio. */
export const WHISPER_SAMPLE_RATE = 16_000;
