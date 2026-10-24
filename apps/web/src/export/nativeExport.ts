import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { decodeMono } from "../engine/audioReactive";
import { engineHost } from "../engine/host";
import { mixAudio, wavBytes } from "./exportVideo";

/** Codecs the desktop exporter writes (apps/desktop/src-tauri/src/ffmpeg.rs). */
export const NativeCodec = { H264: "h264", Hevc: "hevc", Prores: "prores" } as const;
export type NativeCodec = (typeof NativeCodec)[keyof typeof NativeCodec];

/** Asset kinds the native engine stores (the `x-kind` header of `engine_add_asset`). */
const AssetKind = { Font: "font", Model: "model", Texture: "texture", Image: "image" } as const;
type AssetKind = (typeof AssetKind)[keyof typeof AssetKind];

type Progress = { frame: number; frames: number };

/** Sends one asset as a binary IPC body; key and sizes ride in headers. */
function sendAsset(kind: AssetKind, key: string, bytes: Uint8Array, a = 0, b = 0) {
  return invoke("engine_add_asset", bytes, { headers: { "x-kind": kind, "x-key": encodeURIComponent(key), "x-a": String(a), "x-b": String(b) } });
}

async function missing(kind: AssetKind, keys: string[]): Promise<Set<string>> {
  return new Set(await invoke<string[]>("engine_missing_assets", { kind, keys }));
}

/** Gives the native engine every font, model, texture and image the editor's engine has loaded (only new ones cross). */
async function syncAssets() {
  const [fonts, stage, images] = await Promise.all([engineHost.loadedFontFiles(), engineHost.stageAssets(), engineHost.imageAssets()]);
  // Fonts are keyed by family; a family is resent when any of its weights is new to keep it simple.
  const newFamilies = await missing(AssetKind.Font, [...new Set(fonts.map((f) => f.family))]);
  for (const f of fonts) if (newFamilies.has(f.family)) await sendAsset(AssetKind.Font, f.family, f.bytes, f.weight);
  const newModels = await missing(AssetKind.Model, stage.models.map((m) => m.key));
  for (const m of stage.models) if (newModels.has(m.key)) await sendAsset(AssetKind.Model, m.key, m.bytes);
  const newTextures = await missing(AssetKind.Texture, stage.textures.map((t) => t.pack));
  for (const t of stage.textures) if (newTextures.has(t.pack)) await sendAsset(AssetKind.Texture, t.pack, t.rgba, t.width, t.height);
  const newImages = await missing(AssetKind.Image, images.map((i) => i.src));
  for (const i of images) if (newImages.has(i.src)) await sendAsset(AssetKind.Image, i.src, i.rgba, i.width, i.height);
}

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
  await syncAssets();
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
