import { useEffect, useRef, useState } from "react";
import type { MediaItem } from "@motionily/protocol";
import { OpName } from "@motionily/protocol";
import type { SfxCue } from "../../audio/sfxPlayer";
import type { MusicTrack } from "../../audio/music";
import type { EditSelection } from "./EditTimeline";
import { AUDIO_LAYER, ClipKind, freshId, type EditClip, type GraphicsBlock } from "./tracks";
import { engineHost } from "../../engine/host";
import { compoundOps, decomposeOps } from "./tracks";
import type { SceneView } from "../sceneView";
import { AudioFxControls } from "./AudioFxControls";
import { SPEED_RAMPS, speedRampKeys, type AudioFx } from "@motionily/protocol";
import type { EditActions } from "./useEditActions";
import type { EditOps } from "./useEditOps";
import { useAgentName } from "../../agentName";
import { ColorTab } from "./ColorTab";

/** Range of the song-start slider when the song's length is unknown (s). */
const DEFAULT_SONG_RANGE = 180;

const KIND_LABEL: Record<NonNullable<EditSelection>["kind"], string> = { clip: "Clip", block: "Motion graphics", cue: "Sound effect", music: "Music", many: "Selection" };

/** Settings of what is selected in the timeline, as a card on top of the Claude panel (nothing when nothing is selected). */
export function Inspector({ selection, ops, edits, songLength, clipIds, luts, onClose, onStabilize }: { selection: EditSelection; ops: EditOps; edits: EditActions; songLength: number | null; clipIds: string[]; luts: MediaItem[]; onClose: () => void; onStabilize?: (clip: EditClip) => Promise<void> }) {
  if (!selection) return null;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-neutral-500">{KIND_LABEL[selection.kind]}</span>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-md px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-white">
          ×
        </button>
      </div>
      {selection.kind === "clip" ? (
        <ClipInspector onStabilize={onStabilize} clip={selection.clip} ops={ops} edits={edits} clipIds={clipIds} luts={luts} />
      ) : selection.kind === "block" ? (
        <BlockInspector block={selection.block} ops={ops} />
      ) : selection.kind === "cue" ? (
        <CueInspector cue={selection.cue} edits={edits} ops={ops} />
      ) : selection.kind === "many" ? (
        <ManyInspector selection={selection} edits={edits} ops={ops} />
      ) : (
        <MusicInspector music={selection.music} edits={edits} ops={ops} songLength={songLength} />
      )}
    </div>
  );
}

function Slider({ label, value, min, max, step, format, onChange, onDone }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void; onDone: () => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-neutral-400">
      <span className="flex justify-between">
        {label} <span className="text-neutral-200 tabular-nums">{format(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={onDone} onKeyUp={onDone} className="accent-white" />
    </label>
  );
}

/**
 * Position, rotation and opacity of a clip or picture (picture in picture, overlays). Animated values
 * are left alone: they live on the keyframes, which Pro mode edits.
 */
function TransformControls({ clipId, change, done }: { clipId: string; change: (o: Parameters<EditActions["preview"]>[0]) => void; done: (what: string) => void }) {
  const layer = engineHost.layer(clipId) ?? {};
  const [w, h] = engineHost.sceneSize();
  const n = (k: string, d: number) => (typeof layer[k] === "number" ? (layer[k] as number) : layer[k] === undefined ? d : null);
  const x = n("x", w / 2);
  const y = n("y", h / 2);
  const rotation = n("rotation", 0);
  const opacity = n("opacity", 1);
  const prop = (p: string, v: number) => change([{ op: OpName.SetProp, id: clipId, prop: p, value: Math.round(v * 100) / 100 }]);
  return (
    <div className="flex flex-col gap-3">
      <span className="flex items-center justify-between text-[11px] text-neutral-500">
        Transform
        {(x !== w / 2 || y !== h / 2) && x !== null && y !== null && (
          <button
            type="button"
            onClick={() => {
              change([
                { op: OpName.SetProp, id: clipId, prop: "x", value: w / 2 },
                { op: OpName.SetProp, id: clipId, prop: "y", value: h / 2 },
              ]);
              done(`Centers ${clipId}`);
            }}
            className="text-neutral-400 hover:text-white"
          >
            Center
          </button>
        )}
      </span>
      {x !== null && <Slider label="Position X" value={x} min={-w / 2} max={w * 1.5} step={1} format={(v) => `${Math.round(v)} px`} onChange={(v) => prop("x", v)} onDone={() => done(`Position of ${clipId}`)} />}
      {y !== null && <Slider label="Position Y" value={y} min={-h / 2} max={h * 1.5} step={1} format={(v) => `${Math.round(v)} px`} onChange={(v) => prop("y", v)} onDone={() => done(`Position of ${clipId}`)} />}
      {rotation !== null && <Slider label="Rotation" value={rotation} min={-180} max={180} step={0.5} format={(v) => `${v.toFixed(1)}°`} onChange={(v) => prop("rotation", v)} onDone={() => done(`Rotation of ${clipId}`)} />}
      {opacity !== null && <Slider label="Opacity" value={opacity} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => prop("opacity", v)} onDone={() => done(`Opacity of ${clipId}`)} />}
      {[x, y, rotation, opacity].includes(null) && <p className="text-[11px] text-neutral-500">Animated values are keyframed: edit them in Pro mode.</p>}
    </div>
  );
}

/** Sections of a clip's inspector, like CapCut's: what it shows, what it sounds like, its color. */
const ClipTab = { Video: "video", Audio: "audio", Color: "color" } as const;
type ClipTab = (typeof ClipTab)[keyof typeof ClipTab];
const CLIP_TAB_LABEL: Record<ClipTab, string> = { video: "Video", audio: "Audio", color: "Color" };
const TABS_OF: Record<EditClip["kind"], ClipTab[]> = {
  [ClipKind.Video]: [ClipTab.Video, ClipTab.Audio, ClipTab.Color],
  [ClipKind.Image]: [ClipTab.Video, ClipTab.Color],
  [ClipKind.Audio]: [ClipTab.Audio],
  [ClipKind.Compound]: [],
};
const FADES = [0, 0.25, 0.5, 1, 2];
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** Fade in/out read back from volume keys written by `fadeKeys` (0 when there is none). */
function readFades(c: EditClip): { fadeIn: number; fadeOut: number } {
  const k = c.volumeKeys;
  if (!k || k.length < 2) return { fadeIn: 0, fadeOut: 0 };
  const len = c.end - c.start;
  return { fadeIn: k[0]!.v === 0 && k[0]!.t === 0 ? k[1]!.t : 0, fadeOut: k.at(-1)!.v === 0 && Math.abs(k.at(-1)!.t - len) < 0.01 ? len - k.at(-2)!.t : 0 };
}

/** Volume keys (seconds from the clip's start) for a level with fades at both ends. */
function fadeKeys(level: number, len: number, fadeIn: number, fadeOut: number): { t: number; v: number; ease?: string }[] | number {
  if (!fadeIn && !fadeOut) return level;
  const i = Math.min(fadeIn, len / 2);
  const o = Math.min(fadeOut, len / 2);
  const r = (t: number) => Math.round(t * 1000) / 1000;
  return [
    ...(i ? [{ t: 0, v: 0, ease: "linear" }, { t: r(i), v: level }] : [{ t: 0, v: level }]),
    ...(o ? [{ t: r(len - o), v: level, ease: "linear" }, { t: r(len), v: 0 }] : []),
  ];
}

/**
 * Speed ramps (Resolve's retime curves): the clip's `time` remap written from a ramp, the speed easing
 * between points so the picture never jumps. The clip keeps its length on the timeline.
 */
function RampControl({ clip, fileEnd, edits }: { clip: EditClip; fileEnd: number; edits: EditActions }) {
  const time = engineHost.layer(clip.id)?.time;
  const ramped = Array.isArray(time);
  const length = clip.end - clip.start;
  const apply = (name: string) => {
    if (!name) return edits.apply([{ op: OpName.Patch, id: clip.id, fields: { time: null } }], `No speed ramp on ${clip.id}`, true);
    const ramp = SPEED_RAMPS.find((r) => r.name === name)!;
    const { keys } = speedRampKeys(length, ramp.points);
    edits.apply([{ op: OpName.Patch, id: clip.id, fields: { time: keys } }], `${ramp.name} on ${clip.id}`, true);
  };
  const plays = (name: string) => speedRampKeys(length, SPEED_RAMPS.find((r) => r.name === name)!.points).plays * clip.speed;
  return (
    <label className="flex flex-col gap-1 text-xs text-neutral-400">
      Speed ramp
      <select value={ramped ? "custom" : ""} onChange={(e) => e.target.value !== "custom" && apply(e.target.value)} className="rounded-md bg-neutral-800 px-2 py-1.5 text-sm text-white">
        <option value="">None</option>
        {SPEED_RAMPS.map((r) => (
          <option key={r.name} value={r.name}>
            {r.name}
            {clip.in + plays(r.name) > fileEnd + 0.05 ? " (holds the last frame)" : ""}
          </option>
        ))}
        {ramped && <option value="custom">Ramped (keys)</option>}
      </select>
    </label>
  );
}

/** Stabilize a shaky clip: a steadied copy (ffmpeg vid.stab) takes its place; the original stays in the pool. */
function StabilizeButton({ clip, onStabilize }: { clip: EditClip; onStabilize: (clip: EditClip) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      await onStabilize(clip);
      setNote("Stabilized: the clip plays the steadied copy (the original is still in the pool).");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <button type="button" disabled={busy} onClick={() => void run()} className="self-start rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-700 disabled:opacity-50">
        {busy ? "Stabilizing…" : "Stabilize"}
      </button>
      {note && <p className="text-[11px] text-neutral-500">{note}</p>}
    </div>
  );
}

/** A compound clip: several clips moved and trimmed as one (Resolve's), broken back apart in place. */
function CompoundInspector({ clip, edits }: { clip: EditClip; edits: EditActions }) {
  return (
    <div className="flex flex-col gap-3 text-xs text-neutral-400">
      <div>
        <p className="text-sm font-semibold text-neutral-100">{clip.name}</p>
        <p className="tabular-nums text-neutral-500">
          {clip.start.toFixed(2)}–{clip.end.toFixed(2)} s · moves and trims as one clip
        </p>
      </div>
      <button type="button" onClick={() => edits.apply(decomposeOps(clip.id), `Breaks ${clip.id} apart`, true)} className="self-start rounded-md bg-neutral-800 px-3 py-1.5 text-neutral-100 hover:bg-neutral-700">
        Break apart
      </button>
      <p className="text-[11px] text-neutral-500">Its clips come back on the timeline where they play, to edit one by one.</p>
    </div>
  );
}

function ClipInspector({ clip, ops, edits, clipIds, luts, onStabilize }: { clip: EditClip; ops: EditOps; edits: EditActions; clipIds: string[]; luts: MediaItem[]; onStabilize?: (clip: EditClip) => Promise<void> }) {
  if (clip.kind === ClipKind.Compound) return <CompoundInspector clip={clip} edits={edits} />;
  const tabs = TABS_OF[clip.kind];
  const [tab, setTab] = useState<ClipTab>(tabs[0]!);
  useEffect(() => {
    if (!tabs.includes(tab)) setTab(tabs[0]!);
  }, [clip.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = (o: Parameters<EditActions["preview"]>[0]) => edits.preview(o);
  const started = useRef(false);
  const change = (o: Parameters<EditActions["preview"]>[0]) => {
    if (!started.current) edits.begin();
    started.current = true;
    live(o);
  };
  const done = (what: string, recaption = false) => {
    if (!started.current) return;
    started.current = false;
    edits.end(what, recaption);
  };
  const still = clip.kind === ClipKind.Image;
  const fileOut = clip.out ?? clip.in + (clip.end - clip.start) * clip.speed;
  const len = clip.end - clip.start;
  const { fadeIn, fadeOut } = readFades(clip);
  const level = clip.volumeKeys ? Math.max(...clip.volumeKeys.map((k) => k.v)) : clip.volume;
  const customKeys = !!clip.volumeKeys && !fadeIn && !fadeOut;
  const setFades = (i: number, o: number) =>
    edits.apply([{ op: OpName.Patch, id: clip.id, fields: { volume: fadeKeys(level || 1, len, i, o) } }], `Fades of ${clip.id}: in ${i} s, out ${o} s`, clip.kind === ClipKind.Video);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="truncate text-sm font-semibold">{clip.name}</p>
        <p className="text-xs text-neutral-500 tabular-nums">
          {clip.start.toFixed(2)}–{clip.end.toFixed(2)} s{still ? ` · ${len.toFixed(2)} s on screen` : ` on the video · file ${clip.in.toFixed(2)}–${fileOut.toFixed(2)} s`}
        </p>
      </div>
      {tabs.length > 1 && (
        <div className="grid gap-1 rounded-lg bg-neutral-950 p-1" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
          {tabs.map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={`rounded-md py-1 text-xs ${tab === t ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-white"}`}>
              {CLIP_TAB_LABEL[t]}
            </button>
          ))}
        </div>
      )}
      {tab === ClipTab.Video && (
        <>
          <Slider label="Zoom" value={clip.scale} min={1} max={1.6} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => change([{ op: OpName.SetProp, id: clip.id, prop: "scale", value: v }])} onDone={() => done(`Zoom of ${clip.id}`)} />
          <TransformControls clipId={clip.id} change={change} done={done} />
          {still && (
            <Slider
              label="Duration"
              value={len}
              min={0.5}
              max={15}
              step={0.1}
              format={(v) => `${v.toFixed(1)} s`}
              onChange={(v) => change([{ op: OpName.SetTiming, id: clip.id, start: clip.start, end: Math.round((clip.start + v) * 1000) / 1000 }])}
              onDone={() => done(`Duration of ${clip.id}`)}
            />
          )}
        </>
      )}
      {tab === ClipTab.Audio && (
        <>
          {customKeys ? (
            // Keyed volume lives on the clip's volume line; a slider here would flatten it.
            <div className="flex flex-col gap-1 text-xs text-neutral-400">
              <span className="flex justify-between">
                Volume <span className="text-neutral-200 tabular-nums">{clip.volumeKeys!.length} keyframes</span>
              </span>
              <p className="text-[11px] text-neutral-500">Drag the volume line on the clip; double-click a point to remove it.</p>
              <button
                type="button"
                onClick={() => edits.apply([{ op: OpName.Patch, id: clip.id, fields: { volume: level } }], `Volume of ${clip.id}: one level`, true)}
                className="self-start text-[11px] text-neutral-400 hover:text-white"
              >
                Use one level instead
              </button>
            </div>
          ) : (
            <Slider
              label="Volume"
              value={level}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => change([{ op: OpName.Patch, id: clip.id, fields: { volume: fadeKeys(v, len, fadeIn, fadeOut) } }])}
              onDone={() => done(`Volume of ${clip.id}`, true)}
            />
          )}
          {(clip.kind === ClipKind.Audio || clip.volume > 0 || clip.volumeKeys) && typeof (engineHost.layer(clip.id)?.pan ?? 0) === "number" && (
            <Slider
              label="Pan"
              value={Number(engineHost.layer(clip.id)?.pan ?? 0)}
              min={-1}
              max={1}
              step={0.05}
              format={(v) => (Math.abs(v) < 0.01 ? "Center" : `${v < 0 ? "L" : "R"} ${Math.round(Math.abs(v) * 100)}`)}
              onChange={(v) => change([{ op: OpName.Patch, id: clip.id, fields: { pan: Math.abs(v) < 0.01 ? 0 : v } }])}
              onDone={() => done(`Pan of ${clip.id}`, false)}
            />
          )}
          {(clip.kind === ClipKind.Audio || clip.volume > 0 || clip.volumeKeys) && (
            <details className="text-xs text-neutral-400">
              <summary className="cursor-pointer select-none">Audio effects{engineHost.layer(clip.id)?.audio_fx ? " · on" : ""}</summary>
              <div className="pt-2">
                <AudioFxControls fx={engineHost.layer(clip.id)?.audio_fx as AudioFx | undefined} label={clip.id} edits={edits} opsFor={(fx) => [{ op: OpName.Patch, id: clip.id, fields: { audio_fx: fx } }]} />
              </div>
            </details>
          )}
          {clip.kind === ClipKind.Video && (clip.volume > 0 || clip.volumeKeys) && (
            <button
              type="button"
              onClick={() => {
                // The sound goes to the audio track as its own clip (same window, speed and levels); the picture goes quiet.
                const layers = (JSON.parse(engineHost.sceneJson()) as { layers: { id: string }[] }).layers;
                const id = freshId(`${clip.id}_snd`, new Set(layers.map((l) => l.id)));
                const [w, h] = engineHost.sceneSize();
                const volume = clip.volumeKeys ?? clip.volume;
                edits.apply(
                  [
                    { op: OpName.AddLayer, layer: { id, type: AUDIO_LAYER, src: clip.src, start: clip.start, end: clip.end, in: clip.in, ...(clip.out != null ? { out: clip.out } : {}), speed: clip.speed, volume, x: w / 2, y: h / 2, w: 2, h: 2 } },
                    { op: OpName.Patch, id: clip.id, fields: { volume: 0 } },
                  ],
                  `Detaches the sound of ${clip.id}`,
                  false,
                );
              }}
              className="self-start rounded-md bg-neutral-800 px-2.5 py-1.5 text-xs hover:bg-neutral-700"
            >
              Detach audio to its own track
            </button>
          )}
          <div className="grid grid-cols-2 gap-2">
            {([["Fade in", fadeIn, (v: number) => setFades(v, fadeOut)], ["Fade out", fadeOut, (v: number) => setFades(fadeIn, v)]] as const).map(([label, value, set]) => (
              <label key={label} className="flex flex-col gap-1 text-xs text-neutral-400">
                {label}
                <select value={value} onChange={(e) => set(Number(e.target.value))} className="rounded-md bg-neutral-800 px-2 py-1.5 text-sm text-white">
                  {[...new Set([...FADES, Math.round(value * 100) / 100])].sort((a, b) => a - b).map((f) => (
                    <option key={f} value={f}>
                      {f ? `${f} s` : "Off"}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </>
      )}
      {(tab === ClipTab.Video || clip.kind === ClipKind.Audio) && !still && (
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Speed
          <select
            value={clip.speed}
            onChange={(e) => {
              const speed = Number(e.target.value);
              const end = Math.round((clip.start + (fileOut - clip.in) / speed) * 1000) / 1000;
              edits.apply([{ op: OpName.Patch, id: clip.id, fields: { speed } }, { op: OpName.SetTiming, id: clip.id, start: clip.start, end }], `Speed of ${clip.id}: ${speed}×`, true);
            }}
            className="rounded-md bg-neutral-800 px-2 py-1.5 text-sm text-white"
          >
            {[...new Set([...SPEEDS, clip.speed])].sort((a, b) => a - b).map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
      )}
      {tab === ClipTab.Video && clip.kind === ClipKind.Video && <RampControl clip={clip} fileEnd={clip.fileLength ?? Infinity} edits={edits} />}
      {tab === ClipTab.Video && clip.kind === ClipKind.Video && clip.footage && onStabilize && <StabilizeButton clip={clip} onStabilize={onStabilize} />}
      {tab === ClipTab.Color && <ColorTab clipId={clip.id} allClipIds={clipIds.filter((id) => id !== clip.id).concat(clip.id)} edits={edits} luts={luts} />}
      <div className="flex gap-2">
        <button type="button" onClick={() => ops.split(clip)} className="flex-1 rounded-md bg-neutral-800 px-2 py-1.5 text-xs font-semibold hover:bg-neutral-700">
          Split at playhead
        </button>
        <button type="button" onClick={() => ops.remove({ kind: "clip", clip })} className="rounded-md px-2 py-1.5 text-xs text-neutral-400 hover:text-red-400">
          Delete
        </button>
      </div>
    </div>
  );
}

function BlockInspector({ block, ops }: { block: GraphicsBlock; ops: EditOps }) {
  const agent = useAgentName();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="truncate text-sm font-semibold">{block.label}</p>
        <p className="text-xs text-neutral-500 tabular-nums">
          Motion graphics · {block.start.toFixed(2)}–{block.end.toFixed(2)} s · {block.ids.length} layers
        </p>
      </div>
      <p className="text-xs text-neutral-500">Tell {agent} below what to change in it. Drag it on the timeline to move it in time.</p>
      <button type="button" onClick={() => ops.remove({ kind: "block", block })} className="self-start text-xs text-neutral-400 hover:text-red-400">
        Delete block
      </button>
    </div>
  );
}

function CueInspector({ cue, edits, ops }: { cue: SfxCue; edits: EditActions; ops: EditOps }) {
  const [gain, setGain] = useState(cue.gain ?? 1);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-semibold">{cue.sound}</p>
        <p className="text-xs text-neutral-500 tabular-nums">Sound effect at {cue.at.toFixed(2)} s</p>
      </div>
      <Slider label="Level" value={gain} min={0.05} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={setGain} onDone={() => edits.apply([{ op: OpName.PutSfx, cue: { ...cue, gain } }], `Level of the ${cue.sound} effect`, false)} />
      <button type="button" onClick={() => ops.remove({ kind: "cue", cue })} className="self-start text-xs text-neutral-400 hover:text-red-400">
        Delete effect
      </button>
    </div>
  );
}

/** Level of the music, how far it ducks while the voice speaks, and where in the song it starts. */
function MusicInspector({ music, edits, ops, songLength }: { music: MusicTrack; edits: EditActions; ops: EditOps; songLength: number | null }) {
  /** Latest start that still leaves a second of song (an unknown length allows three minutes). */
  const maxStart = Math.max(0, (songLength ?? DEFAULT_SONG_RANGE) - 1);
  const [draft, setDraft] = useState(music);
  useEffect(() => setDraft(music), [music]);
  const save = (what: string) => edits.apply([{ op: OpName.SetMusic, music: draft }], what, false);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="truncate text-sm font-semibold">♪ Music</p>
        <p className="text-xs text-neutral-500 tabular-nums">From {music.start.toFixed(1)} s on the video · song from {music.trim_in.toFixed(1)} s</p>
      </div>
      <Slider label="Level" value={draft.gain} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(gain) => setDraft({ ...draft, gain })} onDone={() => save("Music level")} />
      <Slider label="While the voice speaks" value={draft.duck} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}% of that`} onChange={(duck) => setDraft({ ...draft, duck })} onDone={() => save("Music ducking")} />
      <Slider label="Start the song at" value={Math.min(draft.trim_in, maxStart)} min={0} max={maxStart} step={0.5} format={(v) => `${v.toFixed(1)} s`} onChange={(trim_in) => setDraft({ ...draft, trim_in })} onDone={() => save("Music start in the song")} />
      <button type="button" onClick={() => ops.remove({ kind: "music", music })} className="self-start text-xs text-neutral-400 hover:text-red-400">
        Remove music
      </button>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/**
 * Several pieces at once: one level for every selected sound effect, one volume for every selected
 * clip (each a single undo step), and Delete for all of them.
 */
function ManyInspector({ selection, edits, ops }: { selection: Extract<EditSelection, { kind: "many" }>; edits: EditActions; ops: EditOps }) {
  const { clips, blocks, cues } = selection;
  const [level, setLevel] = useState(() => mean(cues.map((c) => c.gain ?? 1)));
  const [volume, setVolume] = useState(() => mean(clips.map((c) => c.volume)));
  // A different set of pieces starts from its own average.
  const key = [...clips.map((c) => c.id), ...cues.map((c) => c.id)].join();
  useEffect(() => {
    setLevel(mean(cues.map((c) => c.gain ?? 1)));
    setVolume(mean(clips.map((c) => c.volume)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const parts = [clips.length && plural(clips.length, "clip", "clips"), blocks.length && plural(blocks.length, "graphics block", "graphics blocks"), cues.length && plural(cues.length, "effect", "effects")].filter(Boolean);
  const compound = () => {
    const scene = JSON.parse(engineHost.sceneJson()) as SceneView;
    const { ops: made, id } = compoundOps(clips.map((c) => c.id), scene);
    edits.apply(made, `Makes ${id} of ${plural(clips.length, "clip", "clips")}`, true);
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-semibold">{clips.length + blocks.length + cues.length} selected</p>
        <p className="text-xs text-neutral-500">{parts.join(" · ")}</p>
      </div>
      {cues.length > 0 && (
        <Slider
          label={cues.length > 1 ? "Level of every effect" : "Effect level"}
          value={level}
          min={0.05}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={setLevel}
          onDone={() => edits.apply(cues.map((c) => ({ op: OpName.PutSfx, cue: { ...c, gain: level } })), `Level of ${plural(cues.length, "effect", "effects")}: ${Math.round(level * 100)}%`, false)}
        />
      )}
      {clips.length > 1 && !blocks.length && !cues.length && clips.every((c) => c.kind !== ClipKind.Compound) && (
        <button type="button" onClick={compound} className="self-start rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-700" title="Join them into one clip that moves and trims as one (break it apart later)">
          Make compound clip
        </button>
      )}
      {clips.length > 0 && (
        <Slider
          label={clips.length > 1 ? "Volume of every clip" : "Clip volume"}
          value={volume}
          min={0}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={setVolume}
          onDone={() => edits.apply(clips.map((c) => ({ op: OpName.Patch, id: c.id, fields: { volume } })), `Volume of ${plural(clips.length, "clip", "clips")}: ${Math.round(volume * 100)}%`, true)}
        />
      )}
      <p className="text-[11px] text-neutral-500">Shift-click adds or removes a piece; drag on an empty lane to box-select.</p>
      <button type="button" onClick={() => ops.remove(selection)} className="self-start text-xs text-neutral-400 hover:text-red-400">
        Delete all
      </button>
    </div>
  );
}
