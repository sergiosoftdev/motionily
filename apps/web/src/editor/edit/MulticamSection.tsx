import { useState } from "react";
import type { FootageClip } from "@motionily/protocol";
import { engineHost } from "../../engine/host";
import { useEditor } from "../../store";
import { angleName, multicamOf } from "./multicam";
import { makeMulticam, switchAngle } from "./multicamActions";
import type { EditActions } from "./useEditActions";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The clip inspector's Multicam: make the clip one angle of several cameras (the others picked from the
 * clips, lined up by their sound), then switch angles at the playhead here, in the angle viewer or with
 * the number keys while it plays.
 */
export function MulticamSection({ clipId, footage, edits }: { clipId: string; footage: FootageClip[]; edits: EditActions }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const layer = engineHost.layer(clipId) as { id: string; type: string; src?: string; multicam?: unknown } | null;
  if (!layer) return null;
  const mc = multicamOf({ ...layer, type: String(layer.type) }, engineHost.duration());
  const own = footage.find((f) => f.url === layer.src);

  const make = async () => {
    setBusy(true);
    setNote(null);
    try {
      const angles = footage.filter((f) => picked.has(f.id)).map((f) => ({ src: f.url, name: f.name }));
      const r = await makeMulticam(clipId, angles, own?.name);
      edits.apply(r.ops, `Makes ${clipId} multicam (${angles.length + 1} angles)`, true);
      setNote(r.lines.join(" · "));
      setPicked(new Set());
    } catch (e) {
      setNote(message(e));
    } finally {
      setBusy(false);
    }
  };

  const go = (k: number) => {
    try {
      const r = switchAngle(k, useEditor.getState().time, footage, clipId);
      if (r.ops.length) edits.apply(r.ops, r.text, false);
      setNote(r.text);
    } catch (e) {
      setNote(message(e));
    }
  };

  if (!mc) {
    const others = footage.filter((f) => f.url !== layer.src);
    if (!others.length) return null;
    return (
      <div className="flex flex-col gap-1.5 text-xs text-neutral-400">
        <span className="font-semibold text-neutral-200">Multicam</span>
        <span className="text-[11px] text-neutral-500">Other cameras of the same moment: lined up with this clip by their sound.</span>
        {others.map((f) => (
          <label key={f.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={picked.has(f.id)}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(f.id);
                else next.delete(f.id);
                setPicked(next);
              }}
            />
            <span className="truncate">{f.name}</span>
          </label>
        ))}
        <button type="button" disabled={busy || !picked.size} onClick={() => void make()} className="self-start rounded-md bg-neutral-800 px-3 py-1.5 text-neutral-100 hover:bg-neutral-700 disabled:opacity-50">
          {busy ? "Syncing…" : "Make multicam"}
        </button>
        {note && <p className="text-[11px] text-neutral-500">{note}</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 text-xs text-neutral-400">
      <span className="font-semibold text-neutral-200">Multicam · {mc.multicam.group}</span>
      <div className="flex flex-wrap gap-1">
        {mc.multicam.angles.map((a, k) => (
          <button
            key={`${a.src}-${k}`}
            type="button"
            onClick={() => go(k)}
            title={`${a.src.split("/").pop()} · offset ${a.offset >= 0 ? "+" : ""}${a.offset.toFixed(3)} s`}
            className={`rounded-md px-2 py-1 ${k === mc.multicam.angle ? "bg-white text-black" : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700"}`}
          >
            {k + 1} · {angleName(mc.multicam, k)}
          </button>
        ))}
      </div>
      <span className="text-[11px] text-neutral-500">Cuts at the playhead. Keys 1–{Math.min(9, mc.multicam.angles.length)} switch while it plays.</span>
      {note && <p className="text-[11px] text-neutral-500">{note}</p>}
    </div>
  );
}
