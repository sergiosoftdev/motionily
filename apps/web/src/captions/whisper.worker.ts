/// <reference lib="webworker" />
import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { WhisperMsg, type FromWorker, type ToWorker, type WhisperChunk } from "./protocol";

// Multilingual, small enough to cache in the browser, and exported with the
// cross-attentions word-level timestamps need (the plain export lacks them).
const MODEL = "onnx-community/whisper-base_timestamped";

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
const post = (msg: FromWorker) => self.postMessage(msg);

function load() {
  asr ??= pipeline("automatic-speech-recognition", MODEL, {
    device: "gpu" in navigator ? "webgpu" : "wasm",
    progress_callback: (p: { status: string; file?: string; progress?: number }) => {
      if (p.status === "progress") post({ type: WhisperMsg.Progress, label: `Descargando modelo (${p.file ?? ""})`, ratio: (p.progress ?? 0) / 100 });
    },
  }) as Promise<AutomaticSpeechRecognitionPipeline>;
  return asr;
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  try {
    const model = await load();
    post({ type: WhisperMsg.Progress, label: "Transcribiendo…", ratio: null });
    const out = await model(e.data.audio, { return_timestamps: "word", language: e.data.language, chunk_length_s: 30, stride_length_s: 5 });
    const chunks = (Array.isArray(out) ? out[0] : out).chunks as WhisperChunk[] | undefined;
    post({ type: WhisperMsg.Done, chunks: chunks ?? [] });
  } catch (err) {
    post({ type: WhisperMsg.Error, message: err instanceof Error ? err.message : String(err) });
  }
};
