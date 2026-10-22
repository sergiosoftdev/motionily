import { mediaUrl } from "../api/client";
import type { SfxCue } from "../audio/sfxPlayer";
import { DUCK_RAMP, musicLevel, speechInFile, speechSpans, voiceOnTimeline, type MusicTrack, type SpeechSpan } from "../audio/ducking";
import { DEFAULT_SFX_VOLUME } from "@motionily/protocol";
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
import { VIDEO_LAYER, clipSounds, hasSound, type ClipSound, type VideoLibrary } from "../engine/video";

type AudioTrack = { start: number; trim_in: number; trim_out: number | null };
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
};

export type ExportResult = { blob: Blob; extension: "mp4" | "webm" };
export type FontFile = { family: string; weight: number; bytes: Uint8Array };

const AUDIO_RATE = 48_000;
/** Seconds between the points the music's level is sampled at while its envelope shapes it. */
const ENVELOPE_STEP = 0.02;

/**
 * Mix the voice-over (with its trim and offset), the music (ducked under speech), every sound effect
 * and the video clips' own sound into one buffer the length of the video.
 */
async function renderAudio(url: string | null, track: AudioTrack, cues: SfxCue[], duration: number, clips: ClipSound[], music: MusicTrack | null, speech: SpeechSpan[]): Promise<AudioBuffer> {
  const decodeCtx = new AudioContext();
  const decode = async (u: string) => decodeCtx.decodeAudioData(await (await fetch(u)).arrayBuffer());
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * AUDIO_RATE), AUDIO_RATE);
  if (url) {
    const file = await decode(url);
    // No caption words to duck under: the voice file says where the speech is.
    if (!speech.length) speech = voiceOnTimeline(speechInFile(file.getChannelData(0), file.sampleRate), track);
    const src = ctx.createBufferSource();
    src.buffer = file;
    src.connect(ctx.destination);
    const end = track.trim_out ?? file.duration;
    src.start(track.start, track.trim_in, Math.max(0, end - track.trim_in));
  }
  if (music) {
    const file = await decode(mediaUrl(music.src)).catch(() => null);
    if (file && music.start < duration) {
      const src = ctx.createBufferSource();
      src.buffer = file;
      const g = ctx.createGain();
      // The level follows the speech (down to gain × duck over each stretch, with short ramps) and the envelope's keys.
      const times = speech.flatMap(([s0, e0]) => [s0 - DUCK_RAMP, s0, e0, e0 + DUCK_RAMP]);
      if (music.envelope?.length) for (let t = music.start; t < duration; t += ENVELOPE_STEP) times.push(t);
      g.gain.setValueAtTime(musicLevel(music, speech, 0), 0);
      for (const t of times.filter((x) => x > 0 && x < duration).sort((a, b) => a - b)) g.gain.linearRampToValueAtTime(musicLevel(music, speech, t), t);
      src.connect(g).connect(ctx.destination);
      const end = music.trim_out ?? file.duration;
      src.start(music.start, music.trim_in, Math.max(0, end - music.trim_in));
    }
  }
  const buffers = new Map<string, AudioBuffer | null>();
  for (const cue of cues) {
    if (!buffers.has(cue.src)) buffers.set(cue.src, await decode(mediaUrl(cue.src)).catch(() => null));
    const buf = buffers.get(cue.src);
    if (!buf || cue.at >= duration) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = cue.gain ?? 1;
    src.connect(g).connect(ctx.destination);
    src.start(cue.at);
  }
  for (const clip of clips) {
    if (!buffers.has(clip.src)) buffers.set(clip.src, await decode(mediaUrl(clip.src)).catch(() => null));
    const buf = buffers.get(clip.src);
    if (!buf || clip.at >= duration) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = clip.rate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(clip.volume, clip.at);
    for (const [t, v] of clip.levels) g.gain.linearRampToValueAtTime(v, t);
    src.connect(g).connect(ctx.destination);
    // `seconds` of video play `seconds × rate` of the file.
    src.start(clip.at, clip.offset, clip.seconds * clip.rate);
  }
  void decodeCtx.close();
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
  const cues = (scene.sfx ?? []).map((c) => ({ ...c, gain: (c.gain ?? 1) * (scene.sfx_volume ?? DEFAULT_SFX_VOLUME) }));
  const hasClipSound = (scene.layers ?? []).some((l) => l.type === VIDEO_LAYER && hasSound(l.volume));
  const withAudio = (!!opts.audioUrl || !!scene.music || cues.length > 0 || hasClipSound) && (await canEncodeAudio(audioCodec));

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
    const frameCache = new Map<string, boolean>();

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
      await opts.videos?.prepare(engine, t, frameCache);
      engine.render(t);
      await video.add(t, 1 / scene.fps);
      opts.onProgress((i + 1) / (frames + (audio ? frames * 0.1 : 0)));
    }
    if (audio) {
      const clips = clipSounds(engine, scene.fps, scene.duration);
      const speech = speechSpans(scene.captions?.words ?? []);
      await audio.add(await renderAudio(opts.audioUrl, scene.audio ?? { start: 0, trim_in: 0, trim_out: null }, cues, scene.duration, clips, scene.music ?? null, speech));
    }
    await output.finalize();
    opts.onProgress(1);
    const buffer = output.target.buffer!;
    return { blob: new Blob([buffer], { type: mp4 ? "video/mp4" : "video/webm" }), extension: mp4 ? "mp4" : "webm" };
  } finally {
    engine.free();
  }
}
