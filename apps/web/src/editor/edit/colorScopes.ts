import type { ScopeStats } from "@motionily/protocol";

/** Scopes a colorist reads, as in Resolve's Color page. */
export const ScopeMode = { Waveform: "waveform", Parade: "parade", Vectorscope: "vectorscope", Histogram: "histogram" } as const;
export type ScopeMode = (typeof ScopeMode)[keyof typeof ScopeMode];
export const SCOPE_LABEL: Record<ScopeMode, string> = { waveform: "Waveform", parade: "Parade", vectorscope: "Vectorscope", histogram: "Histogram" };

type Rgb = [number, number, number];
const luma709 = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** Rec.709 color difference (vectorscope axes), each in −0.5..0.5. */
const cb709 = (r: number, g: number, b: number) => -0.1146 * r - 0.3854 * g + 0.5 * b;
const cr709 = (r: number, g: number, b: number) => 0.5 * r - 0.4542 * g - 0.0458 * b;

const SHADOWS = 0.25;
const HIGHLIGHTS = 0.75;
const CRUSHED = 0.02;
const CLIPPED = 0.98;
const NEUTRAL_CAST = 0.01;
const BINS = 256;

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const percentile = (hist: Uint32Array, total: number, q: number) => {
  const want = q * total;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]!;
    if (acc >= want) return i / (hist.length - 1);
  }
  return 1;
};

/** Hue name of a tint (an rgb offset around 0), by the hue it pushes a mid grey toward. */
function hueName([r, g, b]: Rgb): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 1e-6) return "neutral";
  let h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  const names: [number, string][] = [[15, "red"], [45, "orange"], [70, "yellow"], [160, "green"], [200, "cyan"], [260, "blue"], [330, "magenta"], [360, "red"]];
  return names.find(([end]) => h < end)![1];
}

/** The numbers behind the scopes of one frame (see ScopeStats). */
export function scopeStats(img: ImageData, t: number): ScopeStats {
  const d = img.data;
  const lumaHist = new Uint32Array(BINS);
  const chromaHist = new Uint32Array(BINS);
  const sum: Rgb = [0, 0, 0];
  const band = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  let n = 0;
  let lumaSum = 0;
  let chromaSum = 0;
  let black = 0;
  let white = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! === 0) continue;
    const r = d[i]! / 255;
    const g = d[i + 1]! / 255;
    const b = d[i + 2]! / 255;
    const y = luma709(r, g, b);
    const c = Math.max(r, g, b) - Math.min(r, g, b);
    n++;
    lumaSum += y;
    chromaSum += c;
    lumaHist[Math.min(BINS - 1, Math.round(y * (BINS - 1)))]!++;
    chromaHist[Math.min(BINS - 1, Math.round(c * (BINS - 1)))]!++;
    if (y < CRUSHED) black++;
    if (y > CLIPPED) white++;
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
    const k = y < SHADOWS ? 0 : y > HIGHLIGHTS ? 2 : 1;
    const bb = band[k]!;
    bb[0]! += r;
    bb[1]! += g;
    bb[2]! += b;
    bb[3]!++;
  }
  const total = Math.max(1, n);
  const mean = (b: number[]): Rgb | null => (b[3]! ? [r3(b[0]! / b[3]!), r3(b[1]! / b[3]!), r3(b[2]! / b[3]!)] : null);
  const mid = mean(band[1]!) ?? (sum.map((v) => v / total) as Rgb);
  const m = (mid[0] + mid[1] + mid[2]) / 3;
  const tint = mid.map((v) => v - m) as Rgb;
  const strength = Math.max(...tint.map(Math.abs));
  return {
    t: r3(t),
    luma: { p1: r3(percentile(lumaHist, total, 0.01)), p5: r3(percentile(lumaHist, total, 0.05)), p50: r3(percentile(lumaHist, total, 0.5)), p95: r3(percentile(lumaHist, total, 0.95)), p99: r3(percentile(lumaHist, total, 0.99)), mean: r3(lumaSum / total) },
    clipped: { black: r3(black / total), white: r3(white / total) },
    rgb: sum.map((v) => r3(v / total)) as Rgb,
    shadows: mean(band[0]!),
    midtones: mean(band[1]!),
    highlights: mean(band[2]!),
    saturation: { mean: r3(chromaSum / total), p95: r3(percentile(chromaHist, total, 0.95)) },
    cast: { hue: strength < NEUTRAL_CAST ? "neutral" : hueName(tint), strength: r3(strength) },
  };
}

const TRACE = { luma: [235, 235, 235], r: [255, 90, 90], g: [90, 230, 120], b: [90, 140, 255] } as const;

/** Draw `mode` for `img` into a 2D canvas (traces add up, like a real scope's phosphor). */
export function drawScope(canvas: HTMLCanvasElement, img: ImageData, mode: ScopeMode) {
  const W = canvas.width;
  const H = canvas.height;
  const g = canvas.getContext("2d")!;
  const out = g.createImageData(W, H);
  const acc = new Float32Array(W * H * 3);
  const d = img.data;
  const iw = img.width;
  const add = (x: number, y: number, c: readonly number[], k: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = ((y | 0) * W + (x | 0)) * 3;
    acc[o]! += c[0]! * k;
    acc[o + 1]! += c[1]! * k;
    acc[o + 2]! += c[2]! * k;
  };
  const pixels = d.length / 4;
  // Brightness per hit so a full frame fills the scope without burning it out.
  const gain = (W * H) / Math.max(1, pixels) * 0.9;
  if (mode === ScopeMode.Histogram) {
    const hist = [new Uint32Array(W), new Uint32Array(W), new Uint32Array(W)];
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) hist[c]![Math.min(W - 1, Math.round((d[i + c]! / 255) * (W - 1)))]!++;
    const peak = Math.max(1, ...hist.flatMap((h) => Array.from(h).sort((a, b) => b - a).slice(2, 3)));
    const cols = [TRACE.r, TRACE.g, TRACE.b];
    for (let c = 0; c < 3; c++) for (let x = 0; x < W; x++) {
      const top = H - Math.min(H, (hist[c]![x]! / peak) * H * 0.92);
      for (let y = Math.floor(top); y < H; y++) add(x, y, cols[c]!, 0.45);
    }
  } else if (mode === ScopeMode.Vectorscope) {
    const R = Math.min(W, H) / 2 - 4;
    const cx = W / 2;
    const cy = H / 2;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]! / 255;
      const gg = d[i + 1]! / 255;
      const b = d[i + 2]! / 255;
      add(cx + cb709(r, gg, b) * 2 * R, cy - cr709(r, gg, b) * 2 * R, [r * 255 * 0.6 + 100, gg * 255 * 0.6 + 100, b * 255 * 0.6 + 100], gain * 2.4);
    }
  } else {
    const parade = mode === ScopeMode.Parade;
    for (let i = 0; i < d.length; i += 4) {
      const px = (i / 4) % iw;
      const r = d[i]! / 255;
      const gg = d[i + 1]! / 255;
      const b = d[i + 2]! / 255;
      if (parade) {
        const w3 = W / 3;
        add((px / iw) * w3, (1 - r) * (H - 1), TRACE.r, gain * 3);
        add(w3 + (px / iw) * w3, (1 - gg) * (H - 1), TRACE.g, gain * 3);
        add(2 * w3 + (px / iw) * w3, (1 - b) * (H - 1), TRACE.b, gain * 3);
      } else add((px / iw) * W, (1 - luma709(r, gg, b)) * (H - 1), TRACE.luma, gain);
    }
  }
  for (let p = 0; p < W * H; p++) {
    out.data[p * 4] = Math.min(255, acc[p * 3]!);
    out.data[p * 4 + 1] = Math.min(255, acc[p * 3 + 1]!);
    out.data[p * 4 + 2] = Math.min(255, acc[p * 3 + 2]!);
    out.data[p * 4 + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  // Graticule: 0/25/50/75/100 % lines, or the vectorscope's targets and skin-tone line.
  g.strokeStyle = "rgba(255,255,255,0.12)";
  g.fillStyle = "rgba(255,255,255,0.35)";
  g.font = "9px Plus Jakarta Sans, sans-serif";
  g.lineWidth = 1;
  if (mode === ScopeMode.Vectorscope) {
    const R = Math.min(W, H) / 2 - 4;
    const cx = W / 2;
    const cy = H / 2;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.moveTo(cx - R, cy);
    g.lineTo(cx + R, cy);
    g.moveTo(cx, cy - R);
    g.lineTo(cx, cy + R);
    g.stroke();
    const targets: [string, Rgb][] = [["R", [1, 0, 0]], ["Yl", [1, 1, 0]], ["G", [0, 1, 0]], ["Cy", [0, 1, 1]], ["B", [0, 0, 1]], ["Mg", [1, 0, 1]]];
    for (const [name, [r, gg, b]] of targets) {
      const x = cx + cb709(r, gg, b) * 2 * R * 0.75;
      const y = cy - cr709(r, gg, b) * 2 * R * 0.75;
      g.strokeRect(x - 3, y - 3, 6, 6);
      g.fillText(name, x + 5, y + 3);
    }
    // Skin tones sit on this line (about 123° from the blue-difference axis).
    const a = (123 * Math.PI) / 180;
    g.strokeStyle = "rgba(255,190,140,0.35)";
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * R, cy - Math.sin(a) * R);
    g.stroke();
  } else {
    for (const q of [0, 0.25, 0.5, 0.75, 1]) {
      const y = mode === ScopeMode.Histogram ? 0 : Math.round((1 - q) * (H - 1)) + 0.5;
      if (mode === ScopeMode.Histogram) {
        const x = Math.round(q * (W - 1)) + 0.5;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, H);
        g.stroke();
      } else {
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(W, y);
        g.stroke();
        g.fillText(String(Math.round(q * 100)), 2, Math.max(9, y - 2));
      }
    }
    if (mode === ScopeMode.Parade) for (const k of [1, 2]) {
      g.beginPath();
      g.moveTo((W / 3) * k + 0.5, 0);
      g.lineTo((W / 3) * k + 0.5, H);
      g.stroke();
    }
  }
}
