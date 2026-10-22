import { memo, useEffect, useRef, useState } from "react";
import { loadPeaks } from "../../timeline/waveform";
import { gridKey, gridStep, posterImage, SHEET_COLS, SHEET_ROWS, thumbFile } from "./thumbs";

/**
 * What the Edit timeline draws inside its blocks: a clip's frames (filmstrip) and a sound's
 * waveform. Both draw only the part of the block on screen into one canvas, and are memoized on
 * plain numbers, so playback (which re-renders the timeline every frame) never redraws them.
 */

/** Narrowest a filmstrip tile gets (px). */
const MIN_TILE = 12;
/** Peaks read per waveform column at most (zoomed far out, the rest are skipped). */
const MAX_PEAKS_PER_PX = 64;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Canvas sized to `w` × `h` CSS px on a HiDPI screen; returns its context in CSS px. */
function sized(c: HTMLCanvasElement, w: number, h: number) {
  const dpr = devicePixelRatio || 1;
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}

/**
 * Frames of a video clip along its block, CapCut style. `from` is the scene second at the block's
 * left edge; tiles show the file second `in + (t − start) × speed` at their middle, so they follow
 * trims, speed and moves. The footage's contact sheet stands in until real frames are decoded.
 */
export const Filmstrip = memo(function Filmstrip(p: {
  src: string;
  poster: string | null;
  fileDuration: number | null;
  /** Width / height of the footage when known, until the decoder says. */
  aspect: number;
  clipStart: number;
  clipIn: number;
  speed: number;
  from: number;
  pps: number;
  /** Block-local px range on screen. */
  visL: number;
  visR: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  const file = thumbFile(p.src);
  useEffect(() => {
    const redraw = () => setTick((n) => n + 1);
    file.listeners.add(redraw);
    return () => void file.listeners.delete(redraw);
  }, [file]);
  const x0 = Math.max(0, Math.floor(p.visL));
  const x1 = Math.max(x0, Math.ceil(p.visR));

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const h = p.height;
    const g = sized(c, x1 - x0, h);
    const tw = Math.max(MIN_TILE, h * (file.aspect ?? p.aspect));
    const step = gridStep((tw / p.pps) * p.speed);
    const sheet = p.poster ? posterImage(p.poster, () => setTick((n) => n + 1)) : null;
    const missing: number[] = [];
    for (let k = Math.floor(x0 / tw); k * tw < x1; k++) {
      const t = p.from + ((k + 0.5) * tw) / p.pps;
      const f = p.clipIn + (t - p.clipStart) * p.speed;
      const key = gridKey(f, step);
      if (!file.frames.has(key)) missing.push(key);
      const frame = file.near(key, step);
      const dx = k * tw - x0;
      if (frame) g.drawImage(frame, dx, 0, tw, h);
      else if (sheet && p.fileDuration) {
        // Contact sheet tile i shows file second duration × (i + 0.5) / 12.
        const i = clamp(Math.floor((f / p.fileDuration) * SHEET_COLS * SHEET_ROWS), 0, SHEET_COLS * SHEET_ROWS - 1);
        const sw = sheet.naturalWidth / SHEET_COLS;
        const sh = sheet.naturalHeight / SHEET_ROWS;
        g.drawImage(sheet, (i % SHEET_COLS) * sw, Math.floor(i / SHEET_COLS) * sh, sw, sh, dx, 0, tw, h);
      }
    }
    if (missing.length) file.request(missing);
  }, [file, tick, x0, x1, p.from, p.pps, p.clipIn, p.clipStart, p.speed, p.height, p.poster, p.fileDuration, p.aspect]);

  return <canvas ref={ref} className="pointer-events-none absolute top-0" style={{ left: x0, width: x1 - x0, height: p.height }} />;
});

type Peaks = { peaks: Float32Array; duration: number };

/** Peaks of an audio (or video) file, null while loading or when it has no sound. */
export function usePeaks(url: string | null): Peaks | null {
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  useEffect(() => {
    setPeaks(null);
    if (!url) return;
    let live = true;
    loadPeaks(url).then(
      (p) => live && setPeaks(p),
      () => live && setPeaks(null),
    );
    return () => void (live = false);
  }, [url]);
  return peaks;
}

/**
 * A sound's waveform along a block: block-local px `x` plays file second `fileAt0 + x × rate`
 * (rate = file seconds per px), so it follows trims, speed and offsets. Bars mirror around the middle.
 */
export const Waveform = memo(function Waveform(p: { peaks: Peaks; fileAt0: number; rate: number; visL: number; visR: number; top: number; height: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const x0 = Math.max(0, Math.floor(p.visL));
  const x1 = Math.max(x0, Math.ceil(p.visR));
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const h = p.height;
    const g = sized(c, x1 - x0, h);
    g.fillStyle = p.color;
    const { peaks, duration } = p.peaks;
    const n = peaks.length;
    for (let x = x0; x < x1; x++) {
      const fa = p.fileAt0 + x * p.rate;
      const fb = fa + p.rate;
      if (fb <= 0 || fa >= duration) continue;
      const i0 = clamp(Math.floor((fa / duration) * n), 0, n - 1);
      const i1 = clamp(Math.ceil((fb / duration) * n), i0 + 1, n);
      const stride = Math.max(1, Math.floor((i1 - i0) / MAX_PEAKS_PER_PX));
      let m = 0;
      for (let i = i0; i < i1; i += stride) m = Math.max(m, peaks[i]!);
      const bar = Math.max(1, m * h * 0.9);
      g.fillRect(x - x0, (h - bar) / 2, 1, bar);
    }
  }, [p.peaks, p.fileAt0, p.rate, x0, x1, p.height, p.color]);
  return <canvas ref={ref} className="pointer-events-none absolute" style={{ left: x0, top: p.top, width: x1 - x0, height: p.height }} />;
});

/** A clip's own sound under its frames: a dark band with the waveform, once the file's peaks are in (nothing for a silent file). */
export const SoundWave = memo(function SoundWave(p: { url: string; fileAt0: number; rate: number; visL: number; visR: number; top: number; height: number; color: string }) {
  const peaks = usePeaks(p.url);
  if (!peaks) return null;
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 bg-black/50" style={{ top: p.top, height: p.height }} />
      <Waveform peaks={peaks} fileAt0={p.fileAt0} rate={p.rate} visL={p.visL} visR={p.visR} top={p.top} height={p.height} color={p.color} />
    </>
  );
});
