import { useState } from "react";
import { MAX_FADER, MixChannel, OpName, TrackKind, type AudioFx, type Mix, type MixStrip, type Op, type Track } from "@motionily/protocol";
import { AudioFxControls } from "./AudioFxControls";
import type { FootageClip } from "@motionily/protocol";
import type { SceneView } from "../sceneView";
import { hasSound } from "../../engine/video";
import { editTracks, trackFieldsOps } from "./tracks";
import type { EditActions } from "./useEditActions";

const CHANNEL_LABEL: Record<MixChannel, string> = { voice: "Voice-over", music: "Music", effects: "Effects" };

/** A fader's linear gain as dB. */
const db = (v: number) => (v <= 0.0001 ? "−∞" : `${v >= 1 ? "+" : ""}${(20 * Math.log10(v)).toFixed(1)} dB`);
const panLabel = (p: number) => (Math.abs(p) < 0.01 ? "C" : `${p < 0 ? "L" : "R"}${Math.round(Math.abs(p) * 100)}`);

type Strip = { key: string; label: string; volume: number; pan: number; muted: boolean; solo: boolean; ops: (fields: MixStrip) => Op[]; fx?: AudioFx | null };

/**
 * The mixer: a strip per track with sound (A1…, and video tracks whose clips play sound) and for the
 * voice-over, the music and the effects. Fader (−∞..+6 dB), pan, mute and solo, written to the scene's
 * tracks and `mix.channels`, so the preview, the exports and the agent hear the same mix.
 */
export function MixerSection({ scene, footage, edits }: { scene: SceneView; footage: FootageClip[]; edits: EditActions }) {
  const t = editTracks(scene, footage);
  const layers = (scene.layers ?? []) as { track?: string; type?: string; volume?: unknown }[];
  const sounding = (tr: Track) => tr.kind === TrackKind.Audio || layers.some((l) => l.track === tr.id && hasSound(l.volume));
  const trackStrips: Strip[] = [...t.videoTracks, ...t.audioTracks].filter(sounding).map((tr) => ({
    key: tr.id,
    label: tr.name ? `${tr.id} · ${tr.name}` : tr.id,
    volume: tr.volume ?? 1,
    pan: tr.pan ?? 0,
    muted: !!tr.muted,
    solo: !!tr.solo,
    ops: (f) => trackFieldsOps(t, tr.id, f),
  }));
  const mix = scene.mix as Mix | null | undefined;
  const present: Record<MixChannel, boolean> = { voice: !!scene.audio, music: !!scene.music, effects: !!scene.sfx?.length };
  const channelStrips: Strip[] = Object.values(MixChannel)
    .filter((c) => present[c])
    .map((c) => {
      const cur = mix?.channels?.[c] ?? {};
      return {
        key: c,
        label: CHANNEL_LABEL[c],
        volume: cur.volume ?? 1,
        pan: cur.pan ?? 0,
        muted: !!cur.muted,
        solo: !!cur.solo,
        fx: cur.fx ?? null,
        ops: (f) => {
          const strip = clean({ ...cur, ...f });
          const channels = { ...mix?.channels, [c]: strip };
          if (!strip) delete channels[c];
          const keep = Object.keys(channels).length ? { channels } : {};
          const { channels: _old, ...rest } = mix ?? { master_db: 0 };
          return [{ op: OpName.SetMix, mix: { ...rest, ...keep } }];
        },
      };
    });
  const strips = [...trackStrips, ...channelStrips];
  if (!strips.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-neutral-400">Mixer</span>
      {strips.map((s) => (
        <StripRow key={s.key} strip={s} edits={edits} />
      ))}
    </div>
  );
}

/** Neutral fields left out (null = a neutral strip, dropped). */
function clean(s: MixStrip): MixStrip | null {
  const out: MixStrip = {};
  if (s.volume != null && Math.abs(s.volume - 1) > 1e-4) out.volume = s.volume;
  if (s.pan != null && Math.abs(s.pan) > 1e-4) out.pan = s.pan;
  if (s.muted) out.muted = true;
  if (s.solo) out.solo = true;
  if (s.fx) out.fx = s.fx;
  return Object.keys(out).length ? out : null;
}

function StripRow({ strip: s, edits }: { strip: Strip; edits: EditActions }) {
  const [open, setOpen] = useState(false);
  const live = (f: MixStrip) => edits.preview(s.ops(f));
  const toggle = (on: boolean, field: "muted" | "solo", label: string) => (
    <button
      type="button"
      onClick={() => edits.apply(s.ops({ [field]: !on }), `${on ? "Un" : ""}${label.toLowerCase()}s ${s.label}`, false)}
      className={`size-5 rounded text-[10px] font-semibold ${on ? (field === "muted" ? "bg-amber-500 text-black" : "bg-emerald-500 text-black") : "bg-neutral-800 text-neutral-400 hover:text-white"}`}
      title={label}
    >
      {label[0]}
    </button>
  );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-xs text-neutral-400">
      <span className="truncate text-neutral-300">{s.label}</span>
      <span className="flex gap-1">
        {s.fx !== undefined && (
          <button type="button" onClick={() => setOpen(!open)} className={`h-5 rounded px-1.5 text-[10px] font-semibold ${s.fx ? "bg-sky-500 text-black" : "bg-neutral-800 text-neutral-400 hover:text-white"}`} title="EQ and compressor">
            FX
          </button>
        )}
        {toggle(s.muted, "muted", "Mute")}
        {toggle(s.solo, "solo", "Solo")}
      </span>
      <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_3.5rem_4rem_2.5rem] items-center gap-2">
        <input
          type="range"
          min={0}
          max={MAX_FADER}
          step={0.01}
          value={s.volume}
          onPointerDown={() => edits.begin()}
          onChange={(e) => live({ volume: Number(e.target.value) })}
          onPointerUp={() => edits.end(`Fader of ${s.label}`, false)}
          onDoubleClick={() => edits.apply(s.ops({ volume: 1 }), `Resets the fader of ${s.label}`, false)}
          className="accent-white"
          aria-label={`${s.label} volume`}
        />
        <span className="text-right text-neutral-200 tabular-nums">{db(s.volume)}</span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={s.pan}
          onPointerDown={() => edits.begin()}
          onChange={(e) => live({ pan: Number(e.target.value) })}
          onPointerUp={() => edits.end(`Pan of ${s.label}`, false)}
          onDoubleClick={() => edits.apply(s.ops({ pan: 0 }), `Centers ${s.label}`, false)}
          className="accent-white"
          aria-label={`${s.label} pan`}
        />
        <span className="text-neutral-200 tabular-nums">{panLabel(s.pan)}</span>
      </label>
      {open && s.fx !== undefined && (
        <div className="col-span-2 pl-2">
          <AudioFxControls fx={s.fx} label={s.label} edits={edits} opsFor={(fx) => s.ops({ fx: fx ?? undefined })} />
        </div>
      )}
    </div>
  );
}
