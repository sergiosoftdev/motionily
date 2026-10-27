import { useEffect, useRef, useState } from "react";
import { OpName } from "@motionily/protocol";
import { engineHost } from "../../engine/host";
import type { EditActions } from "./useEditActions";

const KeyMode = { Off: "off", Chroma: "chroma", Luma: "luma" } as const;
type KeyMode = (typeof KeyMode)[keyof typeof KeyMode];
type Key = { mode: KeyMode; color: string; tolerance: number; softness: number; spill: number; invert: boolean };

/** Screens people shoot on (chroma key green and blue). */
const SCREENS = [
  ["Green screen", "#00b140"],
  ["Blue screen", "#0047bb"],
] as const;
const DEFAULT: Key = { mode: KeyMode.Off, color: "#00b140", tolerance: 0.25, softness: 0.1, spill: 0.6, invert: false };

const SLIDERS: { field: "tolerance" | "softness" | "spill"; label: string; chromaOnly?: boolean }[] = [
  { field: "tolerance", label: "Tolerance" },
  { field: "softness", label: "Softness" },
  { field: "spill", label: "Spill removal", chromaOnly: true },
];

function readKey(clipId: string): Key {
  const fx = ((engineHost.layer(clipId)?.effects as Record<string, unknown>[] | undefined) ?? []).find((e) => e.fx === "key");
  if (!fx) return DEFAULT;
  const n = (v: unknown, d: number) => (typeof v === "number" ? v : d);
  return {
    mode: fx.mode === KeyMode.Luma ? KeyMode.Luma : KeyMode.Chroma,
    color: typeof fx.color === "string" ? fx.color : DEFAULT.color,
    tolerance: n(fx.tolerance, DEFAULT.tolerance),
    softness: n(fx.softness, DEFAULT.softness),
    spill: n(fx.spill, DEFAULT.spill),
    invert: fx.invert === true,
  };
}

/** The clip's effects with its keyer replaced (first: it keys the clip's own colors, before any grade). */
function withKey(clipId: string, k: Key): unknown[] {
  const rest = ((engineHost.layer(clipId)?.effects as Record<string, unknown>[] | undefined) ?? []).filter((e) => e.fx !== "key");
  if (k.mode === KeyMode.Off) return rest;
  const fx = k.mode === KeyMode.Chroma ? { fx: "key", color: k.color, tolerance: k.tolerance, softness: k.softness, spill: k.spill, ...(k.invert ? { invert: true } : {}) } : { fx: "key", mode: "luma", tolerance: k.tolerance, softness: k.softness, ...(k.invert ? { invert: true } : {}) };
  return [fx, ...rest];
}

/**
 * Keyer of a clip: chroma (a green or blue screen goes transparent, its spill taken out of the subject)
 * or luma (the dark end goes: fire, smoke, light leaks shot on black). Writes the clip's `key` effect.
 */
export function KeySection({ clipId, edits }: { clipId: string; edits: EditActions }) {
  const [k, setK] = useState(() => readKey(clipId));
  const dragging = useRef(false);
  useEffect(() => setK(readKey(clipId)), [clipId]);

  const apply = (next: Key, what: string) => {
    setK(next);
    edits.apply([{ op: OpName.Patch, id: clipId, fields: { effects: withKey(clipId, next) } }], `${what} on ${clipId}`, false);
  };
  const slide = (next: Key) => {
    if (!dragging.current) edits.begin();
    dragging.current = true;
    setK(next);
    edits.preview([{ op: OpName.Patch, id: clipId, fields: { effects: withKey(clipId, next) } }]);
  };
  const done = (what: string) => {
    if (!dragging.current) return;
    dragging.current = false;
    edits.end(`Key ${what} of ${clipId}`, false);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-200">Keyer</span>
        <select
          value={k.mode}
          onChange={(e) => apply({ ...k, mode: e.target.value as KeyMode }, e.target.value === KeyMode.Off ? "No keyer" : `${e.target.value === KeyMode.Chroma ? "Chroma" : "Luma"} key`)}
          aria-label="Keyer"
          className="rounded-md bg-neutral-900 px-2 py-1 text-xs focus:outline-none"
        >
          <option value={KeyMode.Off}>Off</option>
          <option value={KeyMode.Chroma}>Chroma key</option>
          <option value={KeyMode.Luma}>Luma key</option>
        </select>
      </div>
      {k.mode === KeyMode.Chroma && (
        <div className="flex items-center gap-2">
          <input type="color" value={k.color} onChange={(e) => apply({ ...k, color: e.target.value }, "Key color")} aria-label="Key color" className="h-6 w-8 cursor-pointer rounded bg-transparent" />
          {SCREENS.map(([label, color]) => (
            <button key={color} type="button" onClick={() => apply({ ...k, color }, label)} className="rounded-md px-2 py-0.5 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:text-white">
              {label}
            </button>
          ))}
        </div>
      )}
      {k.mode !== KeyMode.Off && (
        <>
          {SLIDERS.filter((s) => !s.chromaOnly || k.mode === KeyMode.Chroma).map(({ field, label }) => (
            <label key={field} className="flex flex-col gap-1 text-xs text-neutral-400">
              <span className="flex justify-between">
                {label}
                <span className="tabular-nums text-neutral-300">{Math.round(k[field] * 100)}</span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={k[field]}
                onChange={(e) => slide({ ...k, [field]: Number(e.target.value) })}
                onPointerUp={() => done(label.toLowerCase())}
                onKeyUp={() => done(label.toLowerCase())}
                className="accent-white"
              />
            </label>
          ))}
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <input type="checkbox" checked={k.invert} onChange={(e) => apply({ ...k, invert: e.target.checked }, e.target.checked ? "Inverted key" : "Key")} />
            {k.mode === KeyMode.Luma ? "Keep the dark end instead" : "Keep only the key color"}
          </label>
        </>
      )}
    </div>
  );
}
