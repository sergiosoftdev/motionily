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

type AudioTrack = { start: number; trim_in: number; trim_out: number | null };
type SceneInfo = { width: number; height: number; fps: number; duration: number; audio?: AudioTrack | null };

export type ExportResult = { blob: Blob; extension: "mp4" | "webm" };
export type FontFile = { family: string; weight: number; bytes: Uint8Array };

const AUDIO_RATE = 48_000;

/** Mix the project audio into a buffer the length of the video, honoring its trim and offset. */
async function renderAudio(url: string, track: AudioTrack, duration: number): Promise<AudioBuffer> {
  const decodeCtx = new AudioContext();
  const file = await decodeCtx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  void decodeCtx.close();
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * AUDIO_RATE), AUDIO_RATE);
  const src = ctx.createBufferSource();
  src.buffer = file;
  src.connect(ctx.destination);
  const end = track.trim_out ?? file.duration;
  src.start(track.start, track.trim_in, Math.max(0, end - track.trim_in));
  return ctx.startRendering();
}

/**
 * Render every frame deterministically with a dedicated engine at export size,
 * encode with WebCodecs (H.264/AAC in MP4, or VP9/Opus in WebM) and mux it.
 */
export async function exportVideo(opts: {
  sceneJson: string;
  /** Output height for vertical/square, width for horizontal: 1080 or 720. */
  shortSide: number;
  fonts: FontFile[];
  stage: { models: { key: string; bytes: Uint8Array }[]; textures: { pack: string; rgba: Uint8Array; width: number; height: number }[] };
  images: { src: string; rgba: Uint8Array; width: number; height: number }[];
  audioUrl: string | null;
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
  const withAudio = !!opts.audioUrl && (await canEncodeAudio(audioCodec));

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
    engine.loadScene(opts.sceneJson);

    const output = new Output({ format: mp4 ? new Mp4OutputFormat() : new WebMOutputFormat(), target: new BufferTarget() });
    const video = new CanvasSource(canvas, { codec: videoCodec, quality: new Quality("high") });
    output.addVideoTrack(video, { frameRate: scene.fps });
    const audio = withAudio ? new AudioBufferSource({ codec: audioCodec, quality: new Quality("high") }) : null;
    if (audio) output.addAudioTrack(audio);
    await output.start();

    const frames = Math.max(1, Math.round(scene.duration * scene.fps));
    for (let i = 0; i < frames; i++) {
      if (opts.signal.aborted) {
        await output.cancel();
        throw new DOMException("Export cancelled", "AbortError");
      }
      const t = i / scene.fps;
      engine.render(t);
      await video.add(t, 1 / scene.fps);
      opts.onProgress((i + 1) / (frames + (audio ? frames * 0.1 : 0)));
    }
    if (audio && opts.audioUrl) {
      await audio.add(await renderAudio(opts.audioUrl, scene.audio ?? { start: 0, trim_in: 0, trim_out: null }, scene.duration));
    }
    await output.finalize();
    opts.onProgress(1);
    const buffer = output.target.buffer!;
    return { blob: new Blob([buffer], { type: mp4 ? "video/mp4" : "video/webm" }), extension: mp4 ? "mp4" : "webm" };
  } finally {
    engine.free();
  }
}
