import { useState } from "react";
import { DEFAULT_TARGET_LUFS, LOUDNESS_TARGETS, MASTER_DB_RANGE, OpName, normalization, type Mix, type Normalization } from "@motionily/protocol";
import { engineHost } from "../../engine/host";
import type { EditActions } from "./useEditActions";

const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const lufs = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)} LUFS` : "silence");

/**
 * The mix's master level and loudness normalization: measures the mix as it exports (BS.1770,
 * master at 0 dB) and sets the master so it lands on the target, as `normalize_loudness` does.
 */
export function LoudnessSection({ mix, edits }: { mix: Mix | null | undefined; edits: EditActions }) {
  const [target, setTarget] = useState<number>(mix?.target_lufs ?? DEFAULT_TARGET_LUFS);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Normalization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const master = mix?.master_db ?? 0;
  const setMaster = (v: number, what: string, extra: Partial<Mix> = {}) => {
    const next: Mix = { master_db: v, ...extra };
    edits.apply([{ op: OpName.SetMix, mix: v === 0 && next.target_lufs == null ? null : next }], what, false);
  };
  const normalize = async () => {
    setBusy(true);
    setError(null);
    try {
      const m = await engineHost.mixLoudness();
      if (!m) throw new Error("The video has no sound yet.");
      const n = normalization(m, target);
      setResult(n);
      setMaster(n.masterDb, `Normalize the mix to ${target} LUFS`, { target_lufs: target });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-neutral-400">Loudness</span>
      <label className="flex flex-col gap-1 text-xs text-neutral-400">
        <span className="flex justify-between">
          Master level
          <button type="button" onDoubleClick={() => setMaster(0, "Reset the master level")} title="Double-click to reset" className="text-neutral-200 tabular-nums">
            {db(master)}
          </button>
        </span>
        <input
          type="range"
          min={-24}
          max={MASTER_DB_RANGE[1] / 2}
          step={0.5}
          defaultValue={master}
          key={master}
          onPointerUp={(e) => setMaster(Number((e.target as HTMLInputElement).value), "Master level")}
          onKeyUp={(e) => setMaster(Number((e.target as HTMLInputElement).value), "Master level")}
          className="accent-white"
        />
      </label>
      <div className="flex gap-2">
        <select value={target} onChange={(e) => setTarget(Number(e.target.value))} className="min-w-0 flex-1 rounded-md bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200">
          {LOUDNESS_TARGETS.map((t) => (
            <option key={t.lufs} value={t.lufs}>
              {t.label}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={() => void normalize()} className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-700 disabled:opacity-50">
          {busy ? "Measuring…" : "Normalize"}
        </button>
      </div>
      {result && (
        <p className="text-[11px] text-neutral-500">
          Measured {lufs(result.lufs)}, peak {result.peakDb.toFixed(1)} dBFS · now {lufs(result.lufsAfter)}
          {result.peakLimited ? " (held back so peaks stay under −1 dBFS)" : ""}
        </p>
      )}
      {!result && mix?.target_lufs != null && <p className="text-[11px] text-neutral-500">Normalized to {mix.target_lufs} LUFS.</p>}
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
