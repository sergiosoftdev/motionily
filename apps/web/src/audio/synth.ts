/**
 * Procedural sound effects for motion graphics. A sound is a small JSON recipe (oscillators,
 * noise, filters, envelopes, sweeps) rendered offline to PCM — the agent can write new ones,
 * and the user keeps them in a library to reuse across videos.
 */

export const Wave = { Sine: "sine", Square: "square", Saw: "sawtooth", Triangle: "triangle", Noise: "noise" } as const;
export type Wave = (typeof Wave)[keyof typeof Wave];
export const FilterKind = { Low: "lowpass", High: "highpass", Band: "bandpass" } as const;
export type FilterKind = (typeof FilterKind)[keyof typeof FilterKind];

/** [start, end] sweeps exponentially over the voice's length; a single number stays put. */
type Sweep = number | [number, number];

export type Voice = {
  wave: Wave;
  /** Hz (ignored for noise). */
  freq?: Sweep;
  gain?: number;
  /** Seconds from the sound's start. */
  start?: number;
  /** Seconds this voice lasts (defaults to the sound's duration). */
  length?: number;
  /** Attack / decay times; the voice holds `sustain` until its release. */
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
  filter?: { kind: FilterKind; freq: Sweep; q?: number };
  /** -1 left … 1 right. */
  pan?: number;
  /** Vibrato/FM: rate (Hz) and depth (Hz). */
  wobble?: { rate: number; depth: number };
};

export type SoundRecipe = {
  duration: number;
  voices: Voice[];
  /** 0..1 room size. */
  reverb?: number;
  /** 0..1 grit. */
  drive?: number;
  /** Output peak 0..1 (default 0.89; beds/textures sit lower, ~0.5). */
  volume?: number;
};

export const SAMPLE_RATE = 44100;
const MAX_DURATION = 8;

function sweep(param: AudioParam, v: Sweep | undefined, fallback: number, t0: number, t1: number) {
  const [a, b] = Array.isArray(v) ? v : [v ?? fallback, v ?? fallback];
  param.setValueAtTime(Math.max(0.0001, a), t0);
  if (b !== a) param.exponentialRampToValueAtTime(Math.max(0.0001, b), Math.max(t0 + 0.001, t1));
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number) {
  const buf = ctx.createBuffer(1, Math.max(1, Math.ceil(seconds * ctx.sampleRate)), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function impulse(ctx: BaseAudioContext, size: number) {
  const len = Math.ceil((0.4 + size * 2.6) * ctx.sampleRate);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** (2.5 - size);
  }
  return buf;
}

function driveCurve(amount: number) {
  const k = amount * 60;
  return Float32Array.from({ length: 1024 }, (_, i) => {
    const x = (i / 1023) * 2 - 1;
    return ((1 + k) * x) / (1 + k * Math.abs(x));
  });
}

/** Render a recipe to an AudioBuffer (stereo). */
export async function renderSound(recipe: SoundRecipe): Promise<AudioBuffer> {
  const duration = Math.min(MAX_DURATION, Math.max(0.05, recipe.duration));
  const tail = recipe.reverb ? 0.4 + recipe.reverb * 2.6 : 0.05;
  const ctx = new OfflineAudioContext(2, Math.ceil((duration + tail) * SAMPLE_RATE), SAMPLE_RATE);
  const master = ctx.createGain();
  // Headroom while mixing; the final level comes from normalize().
  master.gain.value = 0.5;
  let bus: AudioNode = master;
  if (recipe.drive) {
    const ws = ctx.createWaveShaper();
    ws.curve = driveCurve(recipe.drive);
    ws.connect(master);
    bus = ws;
  }
  const dry = ctx.createGain();
  dry.connect(bus);
  if (recipe.reverb) {
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, recipe.reverb);
    const wet = ctx.createGain();
    wet.gain.value = 0.35 * recipe.reverb + 0.1;
    dry.connect(conv).connect(wet).connect(bus);
  }
  master.connect(ctx.destination);

  for (const v of recipe.voices) {
    const t0 = v.start ?? 0;
    const len = Math.min(duration - t0, v.length ?? duration - t0);
    if (len <= 0) continue;
    const t1 = t0 + len;
    let src: AudioScheduledSourceNode;
    if (v.wave === Wave.Noise) {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx, len);
      src = n;
    } else {
      const o = ctx.createOscillator();
      o.type = v.wave;
      sweep(o.frequency, v.freq, 440, t0, t1);
      if (v.wobble) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = v.wobble.rate;
        const depth = ctx.createGain();
        depth.gain.value = v.wobble.depth;
        lfo.connect(depth).connect(o.frequency);
        lfo.start(t0);
        lfo.stop(t1);
      }
      src = o;
    }
    let node: AudioNode = src;
    if (v.filter) {
      const f = ctx.createBiquadFilter();
      f.type = v.filter.kind;
      f.Q.value = v.filter.q ?? 1;
      sweep(f.frequency, v.filter.freq, 1000, t0, t1);
      node = node.connect(f);
    }
    // ADSR
    const env = ctx.createGain();
    const peak = v.gain ?? 0.5;
    const a = v.attack ?? 0.005;
    const d = v.decay ?? 0.1;
    const s = (v.sustain ?? 0) * peak;
    const r = Math.min(v.release ?? 0.05, len);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(peak, t0 + a);
    env.gain.linearRampToValueAtTime(Math.max(s, 0.0001), Math.min(t1, t0 + a + d));
    env.gain.setValueAtTime(Math.max(s, 0.0001), Math.max(t0 + a + d, t1 - r));
    env.gain.linearRampToValueAtTime(0, t1);
    node = node.connect(env);
    if (v.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = v.pan;
      node = node.connect(p);
    }
    node.connect(dry);
    src.start(t0);
    src.stop(t1);
  }
  return normalize(await ctx.startRendering(), recipe.volume ?? TARGET_PEAK);
}

/** Every sound lands at the same peak, so the library plays at consistent levels (no clipping, no whispers). */
const TARGET_PEAK = 0.89;
function normalize(buf: AudioBuffer, peak: number): AudioBuffer {
  let max = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) for (const x of buf.getChannelData(c)) max = Math.max(max, Math.abs(x));
  if (max < 1e-4) return buf;
  const k = peak / max;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i]! *= k;
  }
  return buf;
}

/** 16-bit PCM WAV for upload and playback anywhere. */
export function toWav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + n * ch * 2, true);
  str(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, chans[c]![i]!));
      out.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  return new Blob([out], { type: "audio/wav" });
}

/** Play a buffer right away (library previews). */
let previewCtx: AudioContext | null = null;
export function playBuffer(buf: AudioBuffer) {
  previewCtx ??= new AudioContext();
  const s = previewCtx.createBufferSource();
  s.buffer = buf;
  s.connect(previewCtx.destination);
  s.start();
}
