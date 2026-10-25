import { decodeAudio } from "./decode";
import { DEFAULT_SFX_VOLUME } from "@motionily/protocol";
import { mediaUrl } from "../api/client";
import { DUCK_RAMP, musicLevel, speechInFile, speechSpans, voiceOnTimeline, type MusicTrack, type SpeechSpan } from "./ducking";
import { playCue, type SfxCue } from "./sfxPlayer";
import { audioPieces, type AudioTrack } from "./track";
import { VIDEO_LAYER, type ClipSound } from "../engine/video";

/** Seconds between the points the music's level is sampled at while its envelope shapes it. */
const ENVELOPE_STEP = 0.02;

/** Every sound of a video with its decoded file: what one mix schedules. */
export type MixSources = {
  voice: { buf: AudioBuffer; track: AudioTrack } | null;
  /** The music ducks under `speech` (scene seconds). */
  music: { buf: AudioBuffer; track: MusicTrack; speech: SpeechSpan[] } | null;
  cues: { buf: AudioBuffer; cue: SfxCue }[];
  clips: { buf: AudioBuffer; clip: ClipSound }[];
};

/** What a mix reads from the scene. */
export type MixScene = {
  audio?: AudioTrack | null;
  music?: MusicTrack | null;
  sfx?: SfxCue[];
  /** The user's master level for every effect. */
  sfx_volume?: number;
  captions?: { words?: { start: number; end: number }[] } | null;
  layers?: { type: string; src?: string; volume?: unknown }[];
};

/** Every effect cue at the user's master effects level. */
export function sfxCues(scene: MixScene): SfxCue[] {
  return (scene.sfx ?? []).map((c) => ({ ...c, gain: (c.gain ?? 1) * (scene.sfx_volume ?? DEFAULT_SFX_VOLUME) }));
}

/** Where the voice file speaks (file seconds), measured once per decoded file. */
const fileSpeech = new WeakMap<AudioBuffer, SpeechSpan[]>();

/** Where the music ducks: the caption words, or the voice's own speech when there are none. */
export function mixSpeech(scene: MixScene, voice: AudioBuffer | null): SpeechSpan[] {
  const words = scene.captions?.words ?? [];
  if (words.length || !voice) return speechSpans(words);
  let spans = fileSpeech.get(voice);
  if (!spans) fileSpeech.set(voice, (spans = speechInFile(voice.getChannelData(0), voice.sampleRate)));
  return voiceOnTimeline(spans, scene.audio ?? { start: 0, trim_in: 0, trim_out: null });
}

/** Decode every sound the scene plays (files are decoded once and shared); unreadable files are left out. */
export async function loadMix(scene: MixScene, voiceUrl: string | null, clips: ClipSound[]): Promise<MixSources> {
  const track = scene.audio ?? { start: 0, trim_in: 0, trim_out: null };
  const videos = new Set((scene.layers ?? []).filter((l) => l.type === VIDEO_LAYER && l.src).map((l) => l.src!));
  const [voice, music, cues, clipBufs] = await Promise.all([
    voiceUrl ? decodeAudio(voiceUrl) : null,
    scene.music ? decodeAudio(mediaUrl(scene.music.src)) : null,
    Promise.all(sfxCues(scene).map(async (cue) => ({ cue, buf: await decodeAudio(mediaUrl(cue.src)) }))),
    Promise.all(clips.map(async (clip) => ({ clip, buf: await decodeAudio(mediaUrl(clip.src), videos.has(clip.src)) }))),
  ]);
  return {
    voice: voice ? { buf: voice, track } : null,
    music: music && scene.music ? { buf: music, track: scene.music, speech: mixSpeech(scene, voice) } : null,
    cues: cues.filter((c): c is { cue: SfxCue; buf: AudioBuffer } => !!c.buf),
    clips: clipBufs.filter((c): c is { clip: ClipSound; buf: AudioBuffer } => !!c.buf),
  };
}

/**
 * Schedule the whole soundtrack into `out`, from scene second `from`, with that second at context time
 * `when`. The export renders it offline from 0; the preview plays it live from the playhead, so both
 * sound the same: sample-accurate cuts, ducking and fades, never a media element seeking.
 */
export function scheduleMix(ctx: BaseAudioContext, out: AudioNode, m: MixSources, from: number, when: number): AudioScheduledSourceNode[] {
  const at = (t: number) => when + Math.max(0, t - from);
  const sources: AudioScheduledSourceNode[] = [];
  const source = (buf: AudioBuffer) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    sources.push(src);
    return src;
  };
  if (m.voice) {
    // One source per audible piece: cuts in the voice play as jump cuts.
    for (const p of audioPieces(m.voice.track, m.voice.buf.duration)) {
      const len = p.to - p.from;
      const into = Math.max(0, from - p.at);
      if (into >= len) continue;
      const src = source(m.voice.buf);
      src.connect(out);
      src.start(at(p.at), p.from + into, len - into);
    }
  }
  if (m.music) {
    const { buf, track, speech } = m.music;
    const end = track.trim_out ?? buf.duration;
    const len = Math.max(0, end - track.trim_in);
    const into = Math.max(0, from - track.start);
    if (into < len) {
      const g = ctx.createGain();
      // The level follows the speech (down to gain × duck over each stretch, with short ramps) and the envelope's keys.
      const times = speech.flatMap(([s, e]) => [s - DUCK_RAMP, s, e, e + DUCK_RAMP]);
      if (track.envelope?.length) for (let t = track.start; t < track.start + len; t += ENVELOPE_STEP) times.push(t);
      g.gain.setValueAtTime(musicLevel(track, speech, Math.max(0, from)), when);
      for (const t of times.filter((x) => x > from && x > 0).sort((a, b) => a - b)) g.gain.linearRampToValueAtTime(musicLevel(track, speech, t), at(t));
      const src = source(buf);
      src.connect(g).connect(out);
      src.start(at(track.start), track.trim_in + into, len - into);
    }
  }
  for (const { buf, cue } of m.cues) {
    const src = playCue(ctx, buf, cue, at(cue.at), Math.max(0, from - cue.at), out);
    if (src) sources.push(src);
  }
  for (const { buf, clip } of m.clips) {
    const into = Math.max(0, from - clip.at);
    if (into >= clip.seconds) continue;
    const g = ctx.createGain();
    g.gain.setValueAtTime(clipLevel(clip, clip.at + into), at(clip.at));
    for (const [t, v] of clip.levels) if (t > from) g.gain.linearRampToValueAtTime(v, at(t));
    const src = source(buf);
    src.playbackRate.value = clip.rate;
    src.connect(g).connect(out);
    // `seconds` of video play `seconds × rate` of the file.
    src.start(at(clip.at), clip.offset + into * clip.rate, (clip.seconds - into) * clip.rate);
  }
  return sources;
}

/** A clip's level at scene second `t`: its volume, then straight through its level keys. */
function clipLevel(clip: ClipSound, t: number): number {
  let [pt, pv] = [clip.at, clip.volume];
  for (const [kt, kv] of clip.levels) {
    if (kt >= t) return pv + ((kv - pv) * (t - pt)) / Math.max(1e-6, kt - pt);
    [pt, pv] = [kt, kv];
  }
  return pv;
}
