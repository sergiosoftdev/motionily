/**
 * Live loudness and peak of what the preview plays (after the master level and master effects), as
 * an editor's meters show it: momentary (400 ms) and short-term (3 s) LUFS, integrated LUFS since
 * playback started (BS.1770 gating), and per-channel sample peaks with a hold. Fed by a worklet that
 * sees every sample (meter.worklet.js), so the numbers match `normalize_loudness`'s offline ones.
 */
import { audioBus } from "./bus";
import { gatedLoudness, kWeighting, lufsOf } from "./loudness";

const BLOCK_S = 0.1;
/** Blocks in a momentary (400 ms) and a short-term (3 s) window. */
const MOMENTARY = 4;
const SHORT_TERM = 30;
/** Seconds a peak marker stays before it falls. */
const PEAK_HOLD_S = 1.5;
/** Integrated loudness keeps at most this many 400 ms blocks (an hour). */
const MAX_BLOCKS = 36000;

export type MeterReading = {
  /** LUFS (−Infinity when silent). */
  momentary: number;
  shortTerm: number;
  integrated: number;
  /** Per channel, dBFS: the latest block's peak and the held one. */
  peakDb: number[];
  holdDb: number[];
  /** Highest sample peak since playback started, dBFS. */
  maxPeakDb: number;
};

const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

class LiveMeter {
  private node: AudioWorkletNode | null = null;
  private loading: Promise<void> | null = null;
  /** Sum over channels of each 100 ms block's mean square, newest last. */
  private blocks: number[] = [];
  /** 400 ms block powers since the last reset (for the integrated value). */
  private gating: number[] = [];
  private peaks: number[] = [];
  private hold: { db: number; until: number }[] = [];
  private maxPeak = 0;
  private listeners = new Set<(r: MeterReading) => void>();

  /** Start listening to the bus (loads the worklet once); readings go to `fn` every 100 ms. */
  subscribe(fn: (r: MeterReading) => void) {
    this.listeners.add(fn);
    void this.ensure();
    return () => void this.listeners.delete(fn);
  }

  /** A new playback starts: integrated loudness and the max peak count from here. */
  reset() {
    this.gating = [];
    this.maxPeak = 0;
  }

  private ensure() {
    this.loading ??= (async () => {
      const ctx = audioBus.context();
      await ctx.audioWorklet.addModule(new URL("./meter.worklet.js", import.meta.url));
      const node = new AudioWorkletNode(ctx, "motionily-meter", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { coeffs: kWeighting(ctx.sampleRate) } });
      // A muted sink keeps the node in the rendered graph without adding to the sound.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink).connect(ctx.destination);
      audioBus.tap().connect(node);
      node.port.onmessage = (e: MessageEvent<{ ms: number[]; peak: number[] }>) => this.block(e.data.ms, e.data.peak);
      this.node = node;
    })().catch((e: unknown) => {
      this.loading = null;
      console.warn("[motionily] meter unavailable:", e);
    });
    return this.loading;
  }

  private block(ms: number[], peak: number[]) {
    this.blocks.push(ms.reduce((a, b) => a + b, 0));
    if (this.blocks.length > SHORT_TERM) this.blocks.shift();
    const mean = (n: number) => {
      const last = this.blocks.slice(-n);
      return last.length < n ? 0 : last.reduce((a, b) => a + b, 0) / n;
    };
    const momentary = mean(MOMENTARY);
    if (this.blocks.length >= MOMENTARY && this.gating.length < MAX_BLOCKS) this.gating.push(momentary);
    const now = performance.now();
    this.peaks = peak;
    this.maxPeak = Math.max(this.maxPeak, ...peak);
    this.hold = peak.map((p, c) => {
      const h = this.hold[c];
      return !h || db(p) >= h.db || now > h.until ? { db: db(p), until: now + PEAK_HOLD_S * 1000 } : h;
    });
    const reading: MeterReading = {
      momentary: lufsOf(momentary),
      shortTerm: this.blocks.length >= SHORT_TERM ? lufsOf(mean(SHORT_TERM)) : -Infinity,
      integrated: gatedLoudness(this.gating),
      peakDb: this.peaks.map(db),
      holdDb: this.hold.map((h) => h.db),
      maxPeakDb: db(this.maxPeak),
    };
    this.listeners.forEach((fn) => fn(reading));
  }
}

export const liveMeter = new LiveMeter();
export const METER_BLOCK_S = BLOCK_S;
