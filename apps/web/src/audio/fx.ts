import { BandType, type AudioFx } from "@motionily/protocol";

/** The limiter's AudioWorklet node name (limiter.worklet.js). */
const LIMITER = "motionily-limiter";
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** Biquad types of the EQ bands. */
const BIQUAD: Record<BandType, BiquadFilterType> = { high_pass: "highpass", low_pass: "lowpass", low_shelf: "lowshelf", high_shelf: "highshelf", peak: "peaking" };

const db = (v: number) => 10 ** (v / 20);

/** Whether `fx` changes anything. */
export function hasFx(fx: AudioFx | null | undefined): fx is AudioFx {
  return !!fx && (!!fx.eq?.length || !!fx.compressor || !!fx.limiter);
}

/** Make the limiter available on `ctx` (once per context; the preview's and every export's). */
export function prepareFx(ctx: BaseAudioContext, fx: (AudioFx | null | undefined)[]): Promise<void> {
  if (!fx.some((f) => f?.limiter)) return Promise.resolve();
  let p = loaded.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(new URL("./limiter.worklet.js", import.meta.url));
    loaded.set(ctx, p);
  }
  return p;
}

/**
 * The effects as WebAudio nodes, in order (EQ bands, compressor and its makeup gain, limiter): connect
 * into `input`, take the sound from `output`. Call `prepareFx` first when it has a limiter.
 */
export function fxChain(ctx: BaseAudioContext, fx: AudioFx): { input: AudioNode; output: AudioNode } {
  const nodes: AudioNode[] = [];
  for (const b of fx.eq ?? []) {
    const f = ctx.createBiquadFilter();
    f.type = BIQUAD[b.type];
    f.frequency.value = b.freq;
    f.gain.value = b.gain_db ?? 0;
    f.Q.value = b.q ?? (b.type === BandType.Peak ? 1 : 0.707);
    nodes.push(f);
  }
  const c = fx.compressor;
  if (c) {
    const k = ctx.createDynamicsCompressor();
    k.threshold.value = c.threshold_db;
    k.ratio.value = c.ratio;
    k.attack.value = c.attack ?? 0.01;
    k.release.value = c.release ?? 0.25;
    k.knee.value = c.knee_db ?? 6;
    nodes.push(k);
    // WebAudio's compressor adds its own makeup, (1 / gain at full scale)^0.6: taken back out, so the
    // sound only comes up by `makeup_db` (the same in every browser and in exports).
    const fullScaleDb = c.threshold_db * (1 - 1 / c.ratio);
    const g = ctx.createGain();
    g.gain.value = db(0.6 * fullScaleDb + (c.makeup_db ?? 0));
    nodes.push(g);
  }
  if (fx.limiter) {
    try {
      const l = new AudioWorkletNode(ctx, LIMITER, { outputChannelCount: [2] });
      l.parameters.get("ceiling")!.value = db(fx.limiter.ceiling_db ?? -1);
      nodes.push(l);
    } catch {
      // This browser has no AudioWorklet (or it did not load): the sound plays unlimited.
    }
  }
  if (!nodes.length) {
    const pass = ctx.createGain();
    return { input: pass, output: pass };
  }
  nodes.reduce((a, b) => (a.connect(b), b));
  return { input: nodes[0]!, output: nodes.at(-1)! };
}
