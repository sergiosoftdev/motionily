// Loudness and peak meter (AudioWorklet): every sample of the preview's output, K-weighted with the
// BS.1770 filters (coefficients from loudness.ts, for this sample rate), summed in 100 ms blocks. Each
// block posts the K-weighted mean square and the sample peak of every channel; the main thread builds
// momentary (400 ms), short-term (3 s) and integrated loudness from them, as BS.1770 does.
const BLOCK_S = 0.1;

class Meter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    /** [[b0, b1, b2, a1, a2] shelf, [...] high pass] */
    this.coeffs = options.processorOptions.coeffs;
    this.block = Math.round(BLOCK_S * sampleRate);
    this.count = 0;
    /** Per channel: filter states (x1, x2, y1, y2 per stage), sum of squares, peak. */
    this.ch = [];
  }

  state(c) {
    while (this.ch.length <= c) this.ch.push({ s: [new Float64Array(4), new Float64Array(4)], sum: 0, peak: 0 });
    return this.ch[c];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const frames = input?.[0]?.length ?? 128;
    for (let c = 0; c < (input?.length ?? 0); c++) {
      const x = input[c];
      const st = this.state(c);
      let { sum, peak } = st;
      for (let i = 0; i < x.length; i++) {
        let v = x[i];
        const a = Math.abs(v);
        if (a > peak) peak = a;
        for (let k = 0; k < 2; k++) {
          const [b0, b1, b2, a1, a2] = this.coeffs[k];
          const z = st.s[k];
          const y = b0 * v + b1 * z[0] + b2 * z[1] - a1 * z[2] - a2 * z[3];
          z[1] = z[0];
          z[0] = v;
          z[3] = z[2];
          z[2] = y;
          v = y;
        }
        sum += v * v;
      }
      st.sum = sum;
      st.peak = peak;
    }
    // Pass the sound through untouched (the node feeds a muted gain, so it keeps being processed).
    const out = outputs[0];
    if (out && input) for (let c = 0; c < out.length; c++) if (input[c]) out[c].set(input[c]);
    this.count += frames;
    if (this.count >= this.block) {
      this.port.postMessage({ ms: this.ch.map((c) => c.sum / this.count), peak: this.ch.map((c) => c.peak) });
      for (const c of this.ch) (c.sum = 0), (c.peak = 0);
      this.count = 0;
    }
    return true;
  }
}

registerProcessor("motionily-meter", Meter);
