import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { decodeMono } from "../engine/audioReactive";
import { engineHost } from "../engine/host";
import { syncNativeAssets } from "../native/assets";
import { mixAudio, wavBytes } from "./exportVideo";

type Progress = { frame: number; frames: number };

/** Codecs the desktop exporter writes (apps/desktop/src-tauri/src/ffmpeg.rs). */
export const NativeCodec = { H264: "h264", Hevc: "hevc", Prores: "prores" } as const;
export type NativeCodec = (typeof NativeCodec)[keyof typeof NativeCodec];

/**
 * Exports the current scene with the desktop app's native engine: full size up to 4K, H.264, HEVC
 * 10-bit or ProRes, written straight to disk. Resolves with the file's path.
 */
export async function exportNative(o: {
  name: string;
  shortSide: number;
  codec: NativeCodec;
  supersample: boolean;
  audioUrl: string | null;
  onProgress: (ratio: number) => void;
  signal: AbortSignal;
}): Promise<string> {
  engineHost.pause();
  await engineHost.mediaReady();
  const sceneJson = engineHost.sceneJson();
  await syncNativeAssets(engineHost);
  // Audio-reactive expressions read the voice-over's analysis, as in the editor.
  if (o.audioUrl) {
    const { samples, rate } = await decodeMono(o.audioUrl);
    await invoke("engine_audio_analysis", new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), { headers: { "x-rate": String(rate) } });
  } else {
    await invoke("engine_audio_analysis", new Uint8Array(0), { headers: { "x-rate": "0" } });
  }
  const mix = await mixAudio(sceneJson, o.audioUrl, engineHost.clipSounds());
  await invoke("export_audio", mix ? wavBytes(mix) : new Uint8Array(0));

  const unlisten = await listen<Progress>("export-progress", (e) => o.onProgress(e.payload.frame / e.payload.frames));
  const onAbort = () => void invoke("export_cancel");
  o.signal.addEventListener("abort", onAbort);
  try {
    return await invoke<string>("export_video", { request: { sceneJson, shortSide: o.shortSide, codec: o.codec, supersample: o.supersample, name: o.name } });
  } catch (e) {
    if (o.signal.aborted) throw new DOMException("Export cancelled", "AbortError");
    throw new Error(String(e));
  } finally {
    unlisten();
    o.signal.removeEventListener("abort", onAbort);
  }
}

/** Shows an exported file in Finder / Explorer. */
export function revealFile(path: string) {
  return invoke("reveal", { path });
}
