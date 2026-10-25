import { audioBus } from "./bus";
import { mixFx, scheduleMix, type MixSources } from "./mix";
import { prepareFx } from "./fx";

/** Lead time (s) between asking to play and the first sample, so nothing starts late. */
const LEAD = 0.05;

/**
 * The preview's soundtrack, scheduled on the mix bus from the playhead exactly as the export mixes it,
 * and the playback clock: while it plays, the picture follows the sound actually coming out of the
 * speakers (output latency included), so they never drift apart and nothing reseeks mid-play.
 */
export class PreviewMix {
  private sources: AudioScheduledSourceNode[] = [];
  private session = 0;
  /** Scene second heard at context second `ctx`. */
  private anchor: { t: number; ctx: number } | null = null;

  /** Play from scene second `t`: the sounds are scheduled once `load` resolves, from where the clock is by then. */
  start(t: number, load: () => Promise<MixSources>) {
    this.stop();
    const session = ++this.session;
    const ctx = audioBus.context();
    this.anchor = { t, ctx: ctx.currentTime + LEAD };
    void load().then(async (m) => {
      await prepareFx(ctx, mixFx(m)).catch(() => undefined);
      if (session !== this.session || !this.anchor) return;
      const when = Math.max(this.anchor.ctx, ctx.currentTime + LEAD);
      this.sources = scheduleMix(ctx, audioBus.master, m, this.anchor.t + (when - this.anchor.ctx), when);
    });
  }

  stop() {
    this.session++;
    this.anchor = null;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // Not started or already ended.
      }
    }
    this.sources = [];
  }

  /** Scene second being heard right now, or null when the audio clock is not running (then the caller keeps time). */
  now(): number | null {
    const a = this.anchor;
    const ctx = audioBus.peek();
    if (!a || !ctx || ctx.state !== "running") return null;
    return Math.max(a.t, a.t + (heardTime(ctx) - a.ctx));
  }
}

/** Context second coming out of the speakers now (what was scheduled at it is what is heard). */
function heardTime(ctx: AudioContext): number {
  const ts = ctx.getOutputTimestamp?.();
  if (ts?.contextTime !== undefined && ts.performanceTime) return ts.contextTime + Math.max(0, performance.now() - ts.performanceTime) / 1000;
  return ctx.currentTime - (ctx.outputLatency || 0);
}
