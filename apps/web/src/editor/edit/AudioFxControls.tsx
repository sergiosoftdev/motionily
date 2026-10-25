import { useState } from "react";
import { BandType, type AudioFx, type Compressor, type EqBand, type Op } from "@motionily/protocol";
import type { EditActions } from "./useEditActions";

/** The editor's EQ: a low cut and three tone controls (the agent may write any 5 bands). */
const LOW_CUTS = [0, 80, 120, 200] as const;
const TONE = [
  { key: "low", label: "Low", type: BandType.LowShelf, freq: 150 },
  { key: "mid", label: "Mid", type: BandType.Peak, freq: 1500 },
  { key: "high", label: "High", type: BandType.HighShelf, freq: 8000 },
] as const;
type ToneKey = (typeof TONE)[number]["key"];

/** Compressor presets: speech is the usual job. */
const COMPRESSORS: { name: string; c: Compressor | null }[] = [
  { name: "Off", c: null },
  { name: "Gentle", c: { threshold_db: -18, ratio: 2 } },
  { name: "Voice", c: { threshold_db: -24, ratio: 3, makeup_db: 4 } },
  { name: "Strong", c: { threshold_db: -30, ratio: 6, makeup_db: 8 } },
];

/** The simple EQ read back from bands, or null when the bands are not the editor's layout (custom). */
function simpleEq(eq: EqBand[] = []): { lowCut: number; tone: Record<ToneKey, number> } | null {
  const tone: Record<ToneKey, number> = { low: 0, mid: 0, high: 0 };
  let lowCut = 0;
  for (const b of eq) {
    const t = TONE.find((x) => x.type === b.type && x.freq === b.freq && (b.type !== BandType.Peak || (b.q ?? 1) === 1));
    if (t) tone[t.key] = b.gain_db ?? 0;
    else if (b.type === BandType.HighPass && (LOW_CUTS as readonly number[]).includes(b.freq) && b.q == null) lowCut = b.freq;
    else return null;
  }
  return { lowCut, tone };
}

function bands(lowCut: number, tone: Record<ToneKey, number>): EqBand[] {
  return [...(lowCut ? [{ type: BandType.HighPass, freq: lowCut }] : []), ...TONE.filter((t) => Math.abs(tone[t.key]) > 0.05).map((t) => ({ type: t.type, freq: t.freq, gain_db: Math.round(tone[t.key] * 10) / 10 }))];
}

/** `fx` without empty parts (null when nothing is left). */
function tidy(fx: AudioFx): AudioFx | null {
  const out: AudioFx = {};
  if (fx.eq?.length) out.eq = fx.eq;
  if (fx.compressor) out.compressor = fx.compressor;
  if (fx.limiter) out.limiter = fx.limiter;
  return Object.keys(out).length ? out : null;
}

/**
 * Audio effects of a clip, a mixer channel or the master (EQ, compressor, limiter), written as `audio_fx`
 * / `fx` / `master_fx`, which the preview and the exports run the same way. `opsFor` turns the new
 * effects into the edit that stores them.
 */
export function AudioFxControls({ fx, opsFor, edits, label, limiter = false }: { fx: AudioFx | null | undefined; opsFor: (fx: AudioFx | null) => Op[]; edits: EditActions; label: string; limiter?: boolean }) {
  const cur = fx ?? {};
  const eq = simpleEq(cur.eq);
  const [dragging, setDragging] = useState(false);
  const apply = (next: AudioFx, what: string) => edits.apply(opsFor(tidy(next)), `${what} of ${label}`, false);
  const tone = (key: ToneKey, v: number) => {
    if (!eq) return;
    if (!dragging) edits.begin();
    setDragging(true);
    edits.preview(opsFor(tidy({ ...cur, eq: bands(eq.lowCut, { ...eq.tone, [key]: v }) })));
  };
  const toneDone = (key: ToneKey) => {
    if (!dragging) return;
    setDragging(false);
    edits.end(`${TONE.find((t) => t.key === key)!.label} EQ of ${label}`, false);
  };
  const preset = COMPRESSORS.find((p) => JSON.stringify(p.c) === JSON.stringify(cur.compressor ?? null));
  return (
    <div className="flex flex-col gap-2 text-xs text-neutral-400">
      {eq ? (
        <>
          <label className="flex items-center justify-between gap-2">
            Low cut
            <select value={eq.lowCut} onChange={(e) => apply({ ...cur, eq: bands(Number(e.target.value), eq.tone) }, "Low cut")} className="rounded-md bg-neutral-900 px-2 py-1 text-neutral-200">
              {LOW_CUTS.map((f) => (
                <option key={f} value={f}>
                  {f ? `${f} Hz` : "Off"}
                </option>
              ))}
            </select>
          </label>
          {TONE.map((t) => (
            <label key={t.key} className="grid grid-cols-[3rem_minmax(0,1fr)_3.5rem] items-center gap-2">
              {t.label}
              <input type="range" min={-12} max={12} step={0.5} value={eq.tone[t.key]} onChange={(e) => tone(t.key, Number(e.target.value))} onPointerUp={() => toneDone(t.key)} onKeyUp={() => toneDone(t.key)} onDoubleClick={() => apply({ ...cur, eq: bands(eq.lowCut, { ...eq.tone, [t.key]: 0 }) }, `Resets ${t.label} EQ`)} className="accent-white" aria-label={`${t.label} EQ`} />
              <span className="text-right text-neutral-200 tabular-nums">{`${eq.tone[t.key] > 0 ? "+" : ""}${eq.tone[t.key].toFixed(1)} dB`}</span>
            </label>
          ))}
        </>
      ) : (
        <p className="flex items-center justify-between">
          <span>Custom EQ · {cur.eq?.length} bands</span>
          <button type="button" onClick={() => apply({ ...cur, eq: [] }, "Clears the EQ")} className="text-neutral-500 hover:text-white">
            Clear
          </button>
        </p>
      )}
      <label className="flex items-center justify-between gap-2">
        Compressor
        <select
          value={preset?.name ?? "custom"}
          onChange={(e) => {
            const p = COMPRESSORS.find((x) => x.name === e.target.value);
            if (p) apply({ ...cur, compressor: p.c ?? undefined }, `${p.name} compressor`);
          }}
          className="rounded-md bg-neutral-900 px-2 py-1 text-neutral-200"
        >
          {COMPRESSORS.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
          {!preset && <option value="custom">Custom ({cur.compressor?.threshold_db} dB, {cur.compressor?.ratio}:1)</option>}
        </select>
      </label>
      {limiter && (
        <label className="flex items-center justify-between gap-2">
          <span>
            Limiter
            <span className="block text-[11px] text-neutral-500">Holds peaks under the ceiling, so normalizing reaches the target</span>
          </span>
          <select
            value={cur.limiter ? String(cur.limiter.ceiling_db ?? -1) : "off"}
            onChange={(e) => apply({ ...cur, limiter: e.target.value === "off" ? undefined : { ceiling_db: Number(e.target.value) } }, e.target.value === "off" ? "Removes the limiter" : "Limiter")}
            className="rounded-md bg-neutral-900 px-2 py-1 text-neutral-200"
          >
            <option value="off">Off</option>
            {[-1, -2, -3, -6].map((c) => (
              <option key={c} value={String(c)}>
                {c} dBFS
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
