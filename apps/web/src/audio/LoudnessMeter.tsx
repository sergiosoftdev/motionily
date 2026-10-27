import { useEffect, useState } from "react";
import { engineHost } from "../engine/host";
import { liveMeter, type MeterReading } from "./meter";

/** dBFS shown from here up. */
const FLOOR_DB = -60;
/** Above this the bar turns amber, above the ceiling red (exports keep peaks under −1 dBFS). */
const HOT_DB = -6;
const CEILING_DB = -1;

const fmt = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : "–∞");
const pos = (db: number) => `${Math.max(0, Math.min(100, ((db - FLOOR_DB) / -FLOOR_DB) * 100))}%`;

/**
 * Live meters of what plays: L/R sample peaks with a hold, momentary / short-term / integrated LUFS
 * (integrated since playback started), and the switch for hearing the sound while scrubbing.
 */
export function LoudnessMeter({ className = "" }: { className?: string }) {
  const [r, setR] = useState<MeterReading | null>(null);
  const [scrub, setScrub] = useState(() => engineHost.scrubAudio);
  useEffect(() => liveMeter.subscribe(setR), []);
  const peaks = r?.peakDb.length ? r.peakDb : [-Infinity, -Infinity];

  return (
    <div className={`flex items-center gap-2 text-[10px] text-neutral-400 tabular-nums ${className}`}>
      <div className="flex w-28 flex-col gap-0.5" title="Sample peak per channel (dBFS), with a hold">
        {peaks.slice(0, 2).map((p, c) => (
          <div key={c} className="relative h-1.5 overflow-hidden rounded-sm bg-neutral-800">
            <div
              className={`absolute inset-y-0 left-0 ${p > CEILING_DB ? "bg-red-500" : p > HOT_DB ? "bg-amber-400" : "bg-emerald-400"}`}
              style={{ width: pos(p) }}
            />
            {r && Number.isFinite(r.holdDb[c] ?? -Infinity) && <div className="absolute inset-y-0 w-px bg-white" style={{ left: pos(r.holdDb[c]!) }} />}
          </div>
        ))}
      </div>
      <span title="Momentary (400 ms) · short-term (3 s) · integrated since play, LUFS">
        M {fmt(r?.momentary ?? -Infinity)} · S {fmt(r?.shortTerm ?? -Infinity)} · I {fmt(r?.integrated ?? -Infinity)} LUFS
      </span>
      <span title="Highest sample peak since play" className={r && r.maxPeakDb > CEILING_DB ? "text-red-400" : ""}>
        ▲ {fmt(r?.maxPeakDb ?? -Infinity)} dB
      </span>
      <button
        type="button"
        onClick={() => {
          engineHost.scrubAudio = !scrub;
          setScrub(!scrub);
        }}
        aria-pressed={scrub}
        title={scrub ? "Scrubbing plays the sound under the playhead (click to mute it)" : "Scrubbing is silent (click to hear it)"}
        className={`rounded px-1.5 py-0.5 ${scrub ? "text-sky-300 ring-1 ring-sky-300/40" : "text-neutral-500 ring-1 ring-white/10"}`}
      >
        Scrub audio
      </button>
    </div>
  );
}
