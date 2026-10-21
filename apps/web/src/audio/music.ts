import { mediaUrl } from "../api/client";
import { duckAt, musicFileTime, type MusicTrack, type SpeechSpan } from "./ducking";

export * from "./ducking";

/** Preview drift (s) tolerated before the music element is re-synced. */
const DRIFT = 0.25;

/** Plays the scene's music in the preview, following the playhead, its trim and the ducking. */
export class MusicPlayer {
  private el: HTMLAudioElement | null = null;
  private track: MusicTrack | null = null;

  setTrack(track: MusicTrack | null) {
    if (track?.src !== this.track?.src) {
      this.el?.pause();
      this.el = track ? new Audio(mediaUrl(track.src)) : null;
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
    a.volume = Math.min(1, m.gain * duckAt(spans, m.duck, t));
    if (Math.abs(a.currentTime - f) > DRIFT) a.currentTime = f;
    if (playing && a.paused) void a.play();
    if (!playing && !a.paused) a.pause();
  }

  pause() {
    this.el?.pause();
  }
}
