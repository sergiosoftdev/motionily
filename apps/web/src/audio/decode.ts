import { ALL_FORMATS, AudioBufferSink, Input, UrlSource } from "mediabunny";
import { audioBus } from "./bus";

const decoded = new Map<string, Promise<AudioBuffer | null>>();

/**
 * A sound file decoded once for every mix (preview and exports share it); null when it cannot be read.
 * `video` files are read track by track (only their audio is fetched, not the whole file).
 */
export function decodeAudio(url: string, video = false): Promise<AudioBuffer | null> {
  let p = decoded.get(url);
  if (!p) {
    const whole = () =>
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((a) => audioBus.context().decodeAudioData(a));
    p = (video ? audioTrackOf(url).then((b) => b ?? whole()) : whole()).catch(() => null);
    decoded.set(url, p);
  }
  return p;
}

/** A video file's audio track as one buffer (null without one, or when this browser cannot decode it). */
async function audioTrackOf(url: string): Promise<AudioBuffer | null> {
  try {
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;
    const parts: { buf: AudioBuffer; at: number }[] = [];
    for await (const w of new AudioBufferSink(track).buffers()) parts.push({ buf: w.buffer, at: w.timestamp });
    const first = parts[0]?.buf;
    if (!first) return null;
    // Each piece lands at its own timestamp (file second 0 = sample 0), so the sound stays on the picture.
    const rate = first.sampleRate;
    const place = (at: number) => Math.max(0, Math.round(at * rate));
    const length = Math.max(...parts.map((p) => place(p.at) + p.buf.length));
    const out = new AudioBuffer({ length, numberOfChannels: first.numberOfChannels, sampleRate: rate });
    for (const { buf, at } of parts) {
      const skip = Math.max(0, -Math.round(at * rate));
      if (skip >= buf.length) continue;
      for (let c = 0; c < out.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).subarray(skip), c, place(at));
    }
    return out;
  } catch {
    return null;
  }
}
