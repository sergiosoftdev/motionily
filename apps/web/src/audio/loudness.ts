/**
 * Integrated loudness (ITU-R BS.1770-4 / EBU R128) and peak of a mix, so normalizing to a target
 * (−14 LUFS for Reels, TikTok and YouTube) measures exactly what the export will contain.
 */
import type { Loudness } from "@motionily/protocol";

const BLOCK_S = 0.4;
const STEP_S = 0.1;
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;

/** Biquad coefficients [b0, b1, b2, a1, a2] of the K-weighting at `rate` (BS.1770 Annex 1, bilinear form). */
function kWeighting(rate: number): [number, number, number, number, number][] {
  // Stage 1: high shelf (+4 dB above ~1.7 kHz), the head's effect.
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / rate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  const a0 = 1 + K / Q + K * K;
  const shelf: [number, number, number, number, number] = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  // Stage 2: high pass (RLB), ~38 Hz.
  const f1 = 38.13547087602444;
  const Q1 = 0.5003270373238773;
  const K1 = Math.tan((Math.PI * f1) / rate);
  const a01 = 1 + K1 / Q1 + K1 * K1;
  const hp: [number, number, number, number, number] = [1, -2, 1, (2 * (K1 * K1 - 1)) / a01, (1 - K1 / Q1 + K1 * K1) / a01];
  return [shelf, hp];
}

function filter(x: Float32Array, [b0, b1, b2, a1, a2]: [number, number, number, number, number]): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

const toDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

/** Loudness of `channels` (1 or 2, same length) sampled at `rate`. */
export function measureLoudness(channels: Float32Array[], rate: number): Loudness {
  const coeffs = kWeighting(rate);
  const weighted = channels.map((c) => coeffs.reduce((x, k) => filter(x, k), c));
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]!));
  const block = Math.round(BLOCK_S * rate);
  const step = Math.round(STEP_S * rate);
  const n = weighted[0]?.length ?? 0;
  // Running sums of squares make every 400 ms block O(1).
  const sums = weighted.map((w) => {
    const s = new Float64Array(w.length + 1);
    for (let i = 0; i < w.length; i++) s[i + 1] = s[i]! + w[i]! * w[i]!;
    return s;
  });
  const powers: number[] = [];
  for (let at = 0; at + block <= n; at += step) powers.push(sums.reduce((acc, s) => acc + (s[at + block]! - s[at]!) / block, 0));
  const lk = (p: number) => -0.691 + 10 * Math.log10(p);
  const loud = powers.filter((p) => p > 0 && lk(p) > ABSOLUTE_GATE);
  if (!loud.length) return { lufs: -Infinity, peakDb: toDb(peak) };
  const relative = lk(loud.reduce((a, b) => a + b, 0) / loud.length) + RELATIVE_GATE;
  const gated = loud.filter((p) => lk(p) > relative);
  return { lufs: lk(gated.reduce((a, b) => a + b, 0) / gated.length), peakDb: toDb(peak) };
}
