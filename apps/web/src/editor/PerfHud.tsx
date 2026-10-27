import { useEffect, useState } from "react";
import { perf, type PerfSnapshot } from "../engine/perf";
import { workerViewer } from "../engine/workerViewer";
import { nativeViewer } from "../native/viewer";

const PREF_KEY = "motionily.perfHud";
const REFRESH_MS = 250;

function readPref() {
  try {
    return localStorage.getItem(PREF_KEY) === "on";
  } catch {
    return false;
  }
}

function writePref(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    // Not critical: the HUD just starts hidden next time.
  }
}

let toggleHud: () => void = () => {};
/** Show or hide the performance HUD (keyboard shortcut, menus). */
export const togglePerfHud = () => toggleHud();
/** ⌥⇧P (Alt+Shift+P): the default shortcut. */
export const isPerfHudKey = (e: KeyboardEvent) => e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === "KeyP";

const ms = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

/**
 * The preview's own numbers, over the last 2 s: frames of the video shown per second and display
 * frames that came late while playing, the engine's render call, clip decoding and upload, memory.
 */
export function PerfHud() {
  const [on, setOn] = useState(readPref);
  const [s, setS] = useState<PerfSnapshot | null>(null);

  useEffect(() => {
    toggleHud = () =>
      setOn((v) => {
        writePref(!v);
        return !v;
      });
    const onKey = (e: KeyboardEvent) => {
      if (!isPerfHudKey(e)) return;
      e.preventDefault();
      toggleHud();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      toggleHud = () => {};
    };
  }, []);

  useEffect(() => {
    perf.watchGpu = on;
    if (!on) return;
    const tick = () => setS(perf.snapshot());
    tick();
    const id = window.setInterval(tick, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [on]);

  if (!on || !s) return null;
  const row = (label: string, value: string, warn = false) => (
    <div className="flex justify-between gap-4">
      <span className="text-neutral-400">{label}</span>
      <span className={`tabular-nums ${warn ? "text-amber-300" : "text-white"}`}>{value}</span>
    </div>
  );
  return (
    <div className="pointer-events-none absolute top-2 left-2 z-30 w-56 rounded-lg bg-black/75 px-3 py-2 font-mono text-[11px] leading-5 shadow-lg ring-1 ring-white/10" aria-live="off">
      <div className="mb-1 flex justify-between text-neutral-300">
        <span>Performance</span>
        <span>{s.playing ? "playing" : "paused"}</span>
      </div>
      {row("video fps", s.playing ? s.fps.toFixed(0) : "–")}
      {row("drawn by", !s.playing ? "–" : nativeViewer.active ? "native viewer" : workerViewer.active ? "worker" : "main thread")}
      {row("late frames (2 s)", String(s.dropped), s.dropped > 0)}
      {row("render cpu p50/p95", s.render.count ? `${ms(s.render.p50)} / ${ms(s.render.p95)} ms` : "–", s.render.p95 > 16)}
      {row("frame gpu p50/p95", s.gpu.count ? `${ms(s.gpu.p50)} / ${ms(s.gpu.p95)} ms` : "–", s.gpu.p95 > 33)}
      {row("decode p50 / p95", s.decode.count ? `${ms(s.decode.p50)} / ${ms(s.decode.p95)} ms` : "–", s.decode.p95 > 33)}
      {row("upload p50", s.upload.count ? `${ms(s.upload.p50)} ms` : "–")}
      {row("JS heap", s.heapMB === null ? "n/a" : `${s.heapMB.toFixed(0)} MB`)}
      {row("engine memory", s.wasmMB === null ? "–" : `${s.wasmMB.toFixed(0)} MB`)}
      {row("render cache", `${s.cacheMB.toFixed(0)} MB`)}
      <div className="mt-1 text-[10px] text-neutral-500">⌥⇧P to hide</div>
    </div>
  );
}
