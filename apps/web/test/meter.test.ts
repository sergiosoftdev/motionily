// Run: pnpm --filter @motionily/web test (node's own runner, types stripped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatedLoudness, kWeighting, lufsOf, measureLoudness } from "../src/audio/loudness.ts";

const RATE = 48000;

/** Run meter.worklet.js in node: the worklet globals stubbed, 128-sample render quanta. */
async function runWorklet(channels: Float32Array[]) {
  const messages: { ms: number[]; peak: number[] }[] = [];
  let Proc: new (o: unknown) => { process(i: Float32Array[][], o: Float32Array[][]): boolean; port: unknown } = null!;
  Object.assign(globalThis, {
    sampleRate: RATE,
    AudioWorkletProcessor: class {
      port = { postMessage: (m: { ms: number[]; peak: number[] }) => messages.push(m) };
    },
    registerProcessor: (_: string, cls: typeof Proc) => (Proc = cls),
  });
  await import(`../src/audio/meter.worklet.js?${Math.random()}`);
  const proc = new Proc({ processorOptions: { coeffs: kWeighting(RATE) } });
  for (let at = 0; at + 128 <= channels[0]!.length; at += 128) {
    const input = channels.map((c) => c.subarray(at, at + 128));
    proc.process([input], [channels.map(() => new Float32Array(128))]);
  }
  return messages;
}

test("the live meter reads what the offline measurement does", async () => {
  // 4 s of a 997 Hz sine at amplitude 0.25 on both channels.
  const n = RATE * 4;
  const sine = Float32Array.from({ length: n }, (_, i) => 0.25 * Math.sin((2 * Math.PI * 997 * i) / RATE));
  const blocks = await runWorklet([sine, sine]);
  assert.ok(blocks.length >= 39, `100 ms blocks: ${blocks.length}`);
  // Momentary from the last 4 blocks, integrated from 400 ms windows every 100 ms, as meter.ts does.
  const power = blocks.map((b) => b.ms.reduce((a, c) => a + c, 0));
  const windows = power.slice(3).map((_, i) => (power[i]! + power[i + 1]! + power[i + 2]! + power[i + 3]!) / 4);
  const offline = measureLoudness([sine, sine], RATE);
  assert.ok(Math.abs(lufsOf(windows.at(-1)!) - offline.lufs) < 0.1, `momentary ${lufsOf(windows.at(-1)!)} vs ${offline.lufs}`);
  assert.ok(Math.abs(gatedLoudness(windows) - offline.lufs) < 0.1, `integrated ${gatedLoudness(windows)} vs ${offline.lufs}`);
  assert.ok(Math.abs(20 * Math.log10(blocks.at(-1)!.peak[0]!) - 20 * Math.log10(0.25)) < 0.05, "sample peak per channel");
});

test("silence gates out of the integrated value", () => {
  assert.equal(gatedLoudness([0, 0, 0]), -Infinity);
  const loud = 10 ** ((-14 + 0.691) / 10);
  assert.ok(Math.abs(gatedLoudness([loud, loud, 1e-12, 1e-12]) - -14) < 1e-9, "quiet blocks under −70 LUFS do not pull it down");
});
