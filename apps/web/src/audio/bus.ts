import type { AudioFx } from "@motionily/protocol";
import { fxChain, hasFx, prepareFx } from "./fx";

/**
 * The preview's mix bus: every sound (voice, music, clips, effects) plays through one master gain,
 * the scene's `mix.master_db`, as the exporters mix it. Media elements are routed through WebAudio so
 * levels above 1 (a boosted clip, a normalized master) play as they will export.
 */
class AudioBus {
  private ctx: AudioContext | null = null;
  private masterNode: GainNode | null = null;
  private level = 1;
  private nodes = new WeakMap<HTMLMediaElement, GainNode>();
  /** The master effects as set (JSON), and the chain between the master gain and the speakers. */
  private fxKey = "";
  private fxWanted: AudioFx | null = null;
  private chain: { input: AudioNode; output: AudioNode } | null = null;

  context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterNode = this.ctx.createGain();
      this.masterNode.gain.value = this.level;
      this.masterNode.connect(this.ctx.destination);
      if (this.fxWanted) void this.applyFx();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** The context if one was made (never creates or resumes it). */
  peek(): AudioContext | null {
    return this.ctx;
  }

  /** Where every sound connects. */
  get master(): GainNode {
    this.context();
    return this.masterNode!;
  }

  /** Master level from the scene (linear). */
  setMaster(gain: number) {
    this.level = gain;
    if (this.masterNode && this.ctx) this.masterNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
  }

  /** Master effects from the scene (`mix.master_fx`), after the master level, as the exports run them. */
  setMasterFx(fx: AudioFx | null | undefined) {
    const key = JSON.stringify(hasFx(fx) ? fx : null);
    if (key === this.fxKey) return;
    this.fxKey = key;
    this.fxWanted = hasFx(fx) ? fx : null;
    if (this.ctx) void this.applyFx();
  }

  private async applyFx() {
    const ctx = this.ctx!;
    const key = this.fxKey;
    const fx = this.fxWanted;
    if (fx) await prepareFx(ctx, [fx]).catch(() => undefined);
    // A newer change came in meanwhile.
    if (key !== this.fxKey) return;
    this.masterNode!.disconnect();
    this.chain?.output.disconnect();
    this.chain = fx ? fxChain(ctx, fx) : null;
    if (this.chain) {
      this.masterNode!.connect(this.chain.input);
      this.chain.output.connect(ctx.destination);
    } else this.masterNode!.connect(ctx.destination);
  }

  /** A media element for `url` that plays through the bus; set its level with `gain`. */
  element(url: string): HTMLAudioElement {
    const el = new Audio();
    // Without CORS the browser would route silence from another origin (the API's /media).
    el.crossOrigin = "anonymous";
    el.src = url;
    const ctx = this.context();
    const g = ctx.createGain();
    ctx.createMediaElementSource(el).connect(g).connect(this.master);
    this.nodes.set(el, g);
    return el;
  }

  /** Level of an element made by `element` (any value ≥ 0, unlike `volume`). */
  gain(el: HTMLMediaElement, v: number) {
    const g = this.nodes.get(el);
    if (g) g.gain.value = Math.max(0, v);
    else el.volume = Math.min(1, Math.max(0, v));
  }
}

export const audioBus = new AudioBus();
