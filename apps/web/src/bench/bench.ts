/**
 * The browser side of the render benchmark: the editor's own engine host plays each stress scene
 * frame by frame on a 540×960 canvas and reports the engine's render call (CPU: building and
 * submitting the GPU work), the whole frame until the GPU has drawn it, and the time between
 * displayed frames. Driven by scripts/bench.mjs
 * through `window.runBench`.
 */
import { engineHost } from "../engine/host";
import { perf } from "../engine/perf";
import { EngineStatus, useEditor } from "../store";
import { SCENES } from "./scenes";

type Row = { scene: string; adapter: string; renderP50: number; renderP95: number; gpuP50: number; gpuP95: number; frameP50: number; frameP95: number };

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
const pct = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor((v.length - 1) * p + 0.5))] ?? 0;

async function runBench(frames = 60): Promise<Row[]> {
  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  const rows: Row[] = [];
  for (const [name, make] of Object.entries(SCENES)) {
    await engineHost.mount(canvas, JSON.stringify(make()));
    if (useEditor.getState().engineStatus !== EngineStatus.Ready) throw new Error(`engine: ${useEditor.getState().engineError}`);
    // Warm up (pipelines, glyph atlases), then measure.
    for (let i = 0; i < 5; i++) {
      engineHost.seek(i / 30);
      await nextFrame();
    }
    perf.reset();
    const gaps: number[] = [];
    const renders: number[] = [];
    const gpu: number[] = [];
    let last = await nextFrame();
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      engineHost.seek((6 * i) / frames);
      renders.push(performance.now() - t0);
      await engineHost.gpuIdle();
      gpu.push(performance.now() - t0);
      const now = await nextFrame();
      gaps.push(now - last);
      last = now;
    }
    rows.push({ scene: name, adapter: String(useEditor.getState().adapter ?? ""), renderP50: pct(renders, 0.5), renderP95: pct(renders, 0.95), gpuP50: pct(gpu, 0.5), gpuP95: pct(gpu, 0.95), frameP50: pct(gaps, 0.5), frameP95: pct(gaps, 0.95) });
    engineHost.unmount();
  }
  return rows;
}

(window as unknown as { runBench: typeof runBench }).runBench = runBench;
document.title = "bench ready";
