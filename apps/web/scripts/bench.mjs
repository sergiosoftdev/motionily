#!/usr/bin/env node
/**
 * Browser render benchmark: starts Vite, opens bench.html in Chrome with the real GPU (WebGPU when the
 * browser has it), plays each stress scene frame by frame and prints the engine's render call and the
 * time between displayed frames.
 *
 *   pnpm --filter @motionily/web bench [--frames 60] [--json out.json] [--baseline old.json] [--chrome PATH]
 *
 * With --baseline it fails when a scene's median GPU-finished frame got more than 25% slower.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const REGRESSION = 1.25;
const PORT = 5299;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const frames = Number(arg("--frames") ?? 60);
const chrome = arg("--chrome") ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((p) => existsSync(p));

const vite = spawn(join(root, "node_modules/.bin/vite"), ["--port", String(PORT), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const stop = () => vite.kill();
process.on("exit", stop);

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("vite did not start")), 30000);
    vite.stdout.on("data", (d) => String(d).includes("Local:") && (clearTimeout(timer), resolve()));
    vite.on("exit", (code) => reject(new Error(`vite exited (${code})`)));
  });
  const browser = await chromium.launch({
    ...(chrome ? { executablePath: chrome } : {}),
    headless: !args.includes("--headed"),
    args: ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-vsync", "--disable-frame-rate-limit"],
  });
  const page = await browser.newPage({ viewport: { width: 560, height: 980 } });
  page.on("pageerror", (e) => console.error("page:", e.message));
  await page.goto(`http://localhost:${PORT}/bench.html`);
  await page.waitForFunction(() => document.title === "bench ready", null, { timeout: 60000 });
  const rows = await page.evaluate((n) => window.runBench(n), frames);
  await browser.close();

  console.log(`adapter: ${rows[0]?.adapter || "unknown"}`);
  console.log(`${"scene".padEnd(16)} ${"cpu p50".padStart(9)} ${"cpu p95".padStart(9)} ${"gpu p50".padStart(9)} ${"gpu p95".padStart(9)} ${"frame p50".padStart(10)}`);
  for (const r of rows)
    console.log(`${r.scene.padEnd(16)} ${r.renderP50.toFixed(2).padStart(9)} ${r.renderP95.toFixed(2).padStart(9)} ${r.gpuP50.toFixed(2).padStart(9)} ${r.gpuP95.toFixed(2).padStart(9)} ${r.frameP50.toFixed(2).padStart(10)}`);
  const out = arg("--json");
  if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
  const baseline = arg("--baseline");
  if (baseline) {
    const base = JSON.parse(readFileSync(baseline, "utf8"));
    const slower = rows.flatMap((r) => {
      const b = base.find((x) => x.scene === r.scene);
      return b && r.gpuP50 > b.gpuP50 * REGRESSION ? [`${r.scene} ${b.gpuP50.toFixed(2)} → ${r.gpuP50.toFixed(2)} ms`] : [];
    });
    if (slower.length) {
      console.error(`slower than the baseline (> ${Math.round((REGRESSION - 1) * 100)}%):\n  ${slower.join("\n  ")}`);
      process.exitCode = 1;
    }
  }
} finally {
  stop();
}
