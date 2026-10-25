import type { SfxCue } from "../audio/sfxPlayer";
import type { MusicTrack } from "../audio/ducking";
import { loadMix, scheduleMix, sfxCues } from "../audio/mix";
import type { Mix } from "@motionily/protocol";
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  canEncodeAudio,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
} from "mediabunny";
import { Engine } from "../engine/pkg/engine_wasm.js";
import { AUDIO_LAYER, VIDEO_LAYER, clipSounds, hasSound, type ClipSound, type VideoLibrary } from "../engine/video";
import type { AudioTrack } from "../audio/track";

type SceneInfo = {
  width: number;
  height: number;
  fps: number;
  duration: number;
  audio?: AudioTrack | null;
  sfx?: SfxCue[];
  /** The user's master level for every effect. */
  sfx_volume?: number;
  layers?: { type: string; volume?: unknown }[];
  music?: MusicTrack | null;
  captions?: { words?: { start: number; end: number }[] } | null;
  mix?: Mix | null;
};

export type ExportResult = { blob: Blob; extension: "mp4" | "webm" };
export type FontFile = { family: string; weight: number; bytes: Uint8Array };

const AUDIO_RATE = 48_000;

/** Mix the voice-over, the music (ducked under speech), every sound effect and the clips' own sound into one buffer the length of the video. */
async function renderAudio(scene: SceneInfo, url: string | null, clips: ClipSound[], master: number): Promise<AudioBuffer> {
  const sources = await loadMix(scene, url, clips);
  const ctx = new OfflineAudioContext(2, Math.ceil(scene.duration * AUDIO_RATE), AUDIO_RATE);
  // The mix bus: everything plays into it, at the scene's master level.
  const bus = ctx.createGain();
  bus.gain.value = master;
  bus.connect(ctx.destination);
  scheduleMix(ctx, bus, sources, 0, 0);
  return ctx.startRendering();
}

/** Whether the video has any sound at all (voice, music, effects or clips with their own sound). */
export function sceneHasAudio(sceneJson: string, audioUrl: string | null): boolean {
  const scene = JSON.parse(sceneJson) as SceneInfo;
  const hasClipSound = (scene.layers ?? []).some((l) => (l.type === VIDEO_LAYER || l.type === AUDIO_LAYER) && hasSound(l.volume));
  return !!audioUrl || !!scene.music || sfxCues(scene).length > 0 || hasClipSound;
}

/**
 * The video's whole soundtrack mixed into one buffer, or null when it is silent. Shared by the browser and
 * native exporters; `master: false` leaves the master level out (what loudness normalization measures).
 */
export async function mixAudio(sceneJson: string, audioUrl: string | null, clips: ClipSound[], o: { master?: boolean } = {}): Promise<AudioBuffer | null> {
  if (!sceneHasAudio(sceneJson, audioUrl)) return null;
  const scene = JSON.parse(sceneJson) as SceneInfo;
  const master = o.master === false ? 1 : 10 ** ((scene.mix?.master_db ?? 0) / 20);
  return renderAudio(scene, audioUrl, clips, master);
}

/** The `[in, out]` seconds of a mix (export of a range). */
export function sliceAudio(buf: AudioBuffer, [from, to]: [number, number]): AudioBuffer {
  const a = Math.max(0, Math.floor(from * buf.sampleRate));
  const b = Math.min(buf.length, Math.ceil(to * buf.sampleRate));
  const out = new AudioBuffer({ length: Math.max(1, b - a), numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(a, b), c);
  return out;
}

/** 16-bit PCM WAV of a buffer (what ffmpeg muxes into native exports). */
export function wavBytes(buf: AudioBuffer): Uint8Array {
  const channels = buf.numberOfChannels;
  const frames = buf.length;
  const out = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + frames * channels * 2, true);
  text(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, channels, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * channels * 2, true);
  out.setUint16(32, channels * 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => buf.getChannelData(c));
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c]![i]!));
      out.setInt16(at, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      at += 2;
    }
  }
  return new Uint8Array(out.buffer);
}

/**
 * Render every frame deterministically with a dedicated engine at export size,
 * encode with WebCodecs (H.264/AAC in MP4, or VP9/Opus in WebM) and mux it.
 */
export async function exportVideo(opts: {
  sceneJson: string;
  /** Output height for vertical/square, width for horizontal: 1080 or 720. */
  shortSide: number;
  /** Only `[in, out]` seconds (null = the whole video). */
  range?: [number, number] | null;
  fonts: FontFile[];
  stage: { models: { key: string; bytes: Uint8Array }[]; textures: { pack: string; rgba: Uint8Array; width: number; height: number }[] };
  images: { src: string; rgba: Uint8Array; width: number; height: number }[];
  /** `.cube` LUTs the color effects use. */
  luts: { src: string; text: string }[];
  audioUrl: string | null;
  /** Decoders of the scene's video layers (each frame is decoded exactly before it renders). */
  videos?: VideoLibrary;
  onProgress: (ratio: number) => void;
  signal: AbortSignal;
}): Promise<ExportResult> {
  const scene = JSON.parse(opts.sceneJson) as SceneInfo;
  const k = opts.shortSide / Math.min(scene.width, scene.height);
  // Encoders want even dimensions.
  const width = Math.round((scene.width * k) / 2) * 2;
  const height = Math.round((scene.height * k) / 2) * 2;

  const mp4 = await canEncodeVideo("avc", { width, height });
  const videoCodec = mp4 ? "avc" : "vp9";
  const audioCodec = mp4 ? "aac" : "opus";
  const withAudio = sceneHasAudio(opts.sceneJson, opts.audioUrl) && (await canEncodeAudio(audioCodec));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const engine = await Engine.create(canvas);
  try {
    engine.resize(width, height);
    for (const f of opts.fonts) engine.addFont(f.family, f.weight, f.bytes);
    for (const m of opts.stage.models) engine.addModel(m.key, m.bytes);
    for (const t of opts.stage.textures) engine.addTexture(t.pack, t.rgba, t.width, t.height);
    for (const i of opts.images) engine.addImage(i.src, i.rgba, i.width, i.height);
    for (const l of opts.luts) engine.addLut(l.src, l.text);
    engine.loadScene(opts.sceneJson);
    const frameCache = new Map<string, boolean>();

    const output = new Output({ format: mp4 ? new Mp4OutputFormat() : new WebMOutputFormat(), target: new BufferTarget() });
    const video = new CanvasSource(canvas, { codec: videoCodec, quality: new Quality("high") });
    output.addVideoTrack(video, { frameRate: scene.fps });
    const audio = withAudio ? new AudioBufferSource({ codec: audioCodec, quality: new Quality("high") }) : null;
    if (audio) output.addAudioTrack(audio);
    await output.start();

    // A range exports `[in, out]` only; its frames are timestamped from 0.
    const [from, to] = opts.range ? [Math.max(0, opts.range[0]), Math.min(scene.duration, opts.range[1])] : [0, scene.duration];
    const frames = Math.max(1, Math.round((to - from) * scene.fps));
    for (let i = 0; i < frames; i++) {
      if (opts.signal.aborted) {
        await output.cancel();
        throw new DOMException("Export cancelled", "AbortError");
      }
      const t = from + i / scene.fps;
      await opts.videos?.prepare(engine, t, frameCache);
      engine.render(t);
      await video.add(i / scene.fps, 1 / scene.fps);
      opts.onProgress((i + 1) / (frames + (audio ? frames * 0.1 : 0)));
    }
    if (audio) {
      const mix = (await mixAudio(opts.sceneJson, opts.audioUrl, clipSounds(engine, scene.fps, scene.duration)))!;
      await audio.add(opts.range ? sliceAudio(mix, [from, to]) : mix);
    }
    await output.finalize();
    opts.onProgress(1);
    const buffer = output.target.buffer!;
    return { blob: new Blob([buffer], { type: mp4 ? "video/mp4" : "video/webm" }), extension: mp4 ? "mp4" : "webm" };
  } finally {
    engine.free();
  }
}
