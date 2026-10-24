import { audioBus } from "./bus";
import { audioPieces, type AudioTrack } from "./track";

/** A jump in the playhead (s) beyond which the voice is rescheduled (a seek, a loop). */
const RESYNC = 0.25;
/** Lead time (s) so the first piece never starts late. */
const LEAD = 0.03;

/**
 * The voice-over in the preview, decoded once and scheduled piece by piece on the mix bus from the
 * playhead, exactly as the export mixes it: cuts are sample-accurate jump cuts, never seeks of a
 * media element (those stutter, worst in WebKit).
 */
export class VoicePlayer {
  private buffer: Promise<AudioBuffer | null> = Promise.resolve(null);
  private url: string | null = null;
  private sources: AudioBufferSourceNode[] = [];
  /** Scene time and context time playback started at, and the track it was scheduled for. */
  private started: { t: number; ctx: number; track: string } | null = null;
  private session = 0;

  load(url: string | null) {
    if (url === this.url) return;
    this.stop();
    this.url = url;
    this.buffer = url
      ? fetch(url)
          .then((r) => r.arrayBuffer())
          .then((a) => audioBus.context().decodeAudioData(a))
          .catch(() => null)
      : Promise.resolve(null);
  }

  /** Follow the playhead: start, reschedule after a jump or an edit of the track, stop when paused. */
  sync(t: number, playing: boolean, track: AudioTrack) {
    if (!playing) return this.stop();
    const key = JSON.stringify(track);
    const s = this.started;
    if (s) {
      const expected = s.t + (audioBus.context().currentTime - s.ctx);
      if (s.track === key && Math.abs(expected - t) < RESYNC) return;
    }
    void this.start(t, track, key);
  }

  private async start(t: number, track: AudioTrack, key: string) {
    this.stop();
    const session = ++this.session;
    const ctx = audioBus.context();
    this.started = { t, ctx: ctx.currentTime, track: key };
    const buf = await this.buffer;
    if (!buf || session !== this.session) return;
    // Decoding may have taken a moment: start from where the playhead is now.
    const now = ctx.currentTime;
    const at = t + (now - this.started.ctx);
    const t0 = now + LEAD;
    this.started = { t: at - LEAD, ctx: now, track: key };
    for (const p of audioPieces(track, buf.duration)) {
      const len = p.to - p.from;
      if (p.at + len <= at) continue;
      const into = Math.max(0, at - p.at);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(audioBus.master);
      src.start(t0 + Math.max(0, p.at - at), p.from + into, len - into);
      this.sources.push(src);
    }
  }

  stop() {
    this.session++;
    this.started = null;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // Already ended.
      }
    }
    this.sources = [];
  }
}
