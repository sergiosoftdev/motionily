const PEAK_COUNT = 2000;
const cache = new Map<string, Promise<{ peaks: Float32Array; duration: number }>>();

/** Peak amplitude per bucket (0..1) of an audio file, for drawing its waveform. */
export function loadPeaks(url: string) {
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      const ctx = new AudioContext();
      try {
        const buffer = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
        const data = buffer.getChannelData(0);
        const peaks = new Float32Array(PEAK_COUNT);
        const size = Math.max(1, Math.floor(data.length / PEAK_COUNT));
        let max = 0;
        for (let i = 0; i < PEAK_COUNT; i++) {
          let m = 0;
          for (let j = i * size; j < Math.min(data.length, (i + 1) * size); j++) m = Math.max(m, Math.abs(data[j]!));
          peaks[i] = m;
          max = Math.max(max, m);
        }
        if (max > 0) for (let i = 0; i < PEAK_COUNT; i++) peaks[i]! /= max;
        return { peaks, duration: buffer.duration };
      } finally {
        void ctx.close();
      }
    })();
    cache.set(url, p);
  }
  return p;
}
