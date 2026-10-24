import { mediaUrl } from "../api/client";
import { audioBus } from "./bus";
import { musicFileTime, musicLevel, type MusicTrack, type SpeechSpan } from "./ducking";

export * from "./ducking";

/** Preview drift (s) tolerated before the music element is re-synced. */
const DRIFT = 0.25;

/** Plays the scene's music in the preview, following the playhead, its trim, the ducking and its envelope. */
export class MusicPlayer {
  private el: HTMLAudioElement | null = null;
  private track: MusicTrack | null = null;

  setTrack(track: MusicTrack | null) {
    if (track?.src !== this.track?.src) {
      this.el?.pause();
      this.el = track ? audioBus.element(mediaUrl(track.src)) : null;
    }
    this.track = track;
  }

  sync(t: number, playing: boolean, spans: SpeechSpan[]) {
    const a = this.el;
    const m = this.track;
    if (!a || !m) return;
    const f = musicFileTime(m, t, Number.isFinite(a.duration) ? a.duration : Infinity);
    if (f === null) {
      if (!a.paused) a.pause();
      return;
    }
    audioBus.gain(a, musicLevel(m, spans, t));
    if (Math.abs(a.currentTime - f) > DRIFT) a.currentTime = f;
    if (playing && a.paused) void a.play();
    if (!playing && !a.paused) a.pause();
  }

  pause() {
    this.el?.pause();
  }
}
