import { mediaUrl } from "../api/client";
import { playCue, type SfxCue } from "../audio/sfxPlayer";
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
import { audioPieces, type AudioTrack } from "../audio/track";

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
    // One source per audible piece: cuts in the voice play as jump cuts.
    for (const p of audioPieces(track, file.duration)) {
      const src = ctx.createBufferSource();
      src.buffer = file;
      src.connect(ctx.destination);
      src.start(p.at, p.from, p.to - p.from);
    }
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
    if (buf && cue.at < duration) playCue(ctx, buf, cue, cue.at);
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

/** Every effect cue at the user's master effects level. */
function sfxCues(scene: SceneInfo) {
  return (scene.sfx ?? []).map((c) => ({ ...c, gain: (c.gain ?? 1) * (scene.sfx_volume ?? DEFAULT_SFX_VOLUME) }));
}

/** Whether the video has any sound at all (voice, music, effects or clips with their own sound). */
export function sceneHasAudio(sceneJson: string, audioUrl: string | null): boolean {
  const scene = JSON.parse(sceneJson) as SceneInfo;
  const hasClipSound = (scene.layers ?? []).some((l) => l.type === VIDEO_LAYER && hasSound(l.volume));
  return !!audioUrl || !!scene.music || sfxCues(scene).length > 0 || hasClipSound;
}

/** The video's whole soundtrack mixed into one buffer, or null when it is silent. Shared by the browser and native exporters. */
export async function mixAudio(sceneJson: string, audioUrl: string | null, clips: ClipSound[]): Promise<AudioBuffer | null> {
  if (!sceneHasAudio(sceneJson, audioUrl)) return null;
  const scene = JSON.parse(sceneJson) as SceneInfo;
  const speech = speechSpans(scene.captions?.words ?? []);
  return renderAudio(audioUrl, scene.audio ?? { start: 0, trim_in: 0, trim_out: null }, sfxCues(scene), scene.duration, clips, scene.music ?? null, speech);
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
    if (audio) await audio.add((await mixAudio(opts.sceneJson, opts.audioUrl, clipSounds(engine, scene.fps, scene.duration)))!);
    await output.finalize();
    opts.onProgress(1);
    const buffer = output.target.buffer!;
    return { blob: new Blob([buffer], { type: mp4 ? "video/mp4" : "video/webm" }), extension: mp4 ? "mp4" : "webm" };
  } finally {
    engine.free();
  }
}
