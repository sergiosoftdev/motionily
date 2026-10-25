// Lookahead peak limiter (AudioWorklet), the same in the preview and in exports (OfflineAudioContext):
// the sound is delayed 5 ms; the gain each sample needs to stay under the ceiling is known that far
// ahead, so the gain comes down before a peak arrives (smoothly, over the lookahead) and recovers
// with an 80 ms release. A final clamp catches what smoothing leaves over the ceiling.
const LOOKAHEAD_S = 0.005;
const RELEASE_S = 0.08;

class Limiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "ceiling", defaultValue: 0.891, minValue: 0.0001, maxValue: 1, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    this.n = Math.max(1, Math.round(LOOKAHEAD_S * sampleRate));
    /** Delay lines per channel, and the gain needed per sample over the lookahead window. */
    this.delay = [];
    this.need = new Float32Array(this.n);
    this.pos = 0;
    this.gain = 1;
    this.attack = 1 - Math.exp(Math.log(0.01) / this.n);
    this.release = 1 - Math.exp(-1 / (RELEASE_S * sampleRate));
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output.length) return true;
    const ceiling = params.ceiling[0];
    const channels = output.length;
    while (this.delay.length < channels) this.delay.push(new Float32Array(this.n));
    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      // The loudest channel of the incoming sample sets the gain it will need.
      let peak = 0;
      for (let c = 0; c < channels; c++) peak = Math.max(peak, Math.abs(input[c]?.[i] ?? input[0]?.[i] ?? 0));
      this.need[this.pos] = peak > ceiling ? ceiling / peak : 1;
      let target = 1;
      for (let k = 0; k < this.n; k++) if (this.need[k] < target) target = this.need[k];
      this.gain += (target - this.gain) * (target < this.gain ? this.attack : this.release);
      for (let c = 0; c < channels; c++) {
        const line = this.delay[c];
        const out = line[this.pos] * this.gain;
        line[this.pos] = input[c]?.[i] ?? input[0]?.[i] ?? 0;
        output[c][i] = Math.max(-ceiling, Math.min(ceiling, out));
      }
      this.pos = (this.pos + 1) % this.n;
    }
    return true;
  }
}

registerProcessor("motionily-limiter", Limiter);
