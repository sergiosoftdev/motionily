import { useEffect, useRef, useState } from "react";
import { OpName } from "@motionily/protocol";
import type { SfxCue } from "../../audio/sfxPlayer";
import type { MusicTrack } from "../../audio/music";
import type { EditSelection } from "./EditTimeline";
import type { EditClip, GraphicsBlock } from "./tracks";
import type { EditActions } from "./useEditActions";
import type { EditOps } from "./useEditOps";

/** Range of the song-start slider when the song's length is unknown (s). */
const DEFAULT_SONG_RANGE = 180;

const KIND_LABEL: Record<NonNullable<EditSelection>["kind"], string> = { clip: "Clip", block: "Motion graphics", cue: "Sound effect", music: "Music", many: "Selection" };

/** Settings of what is selected in the timeline, as a card on top of the Claude panel (nothing when nothing is selected). */
export function Inspector({ selection, ops, edits, songLength, onClose }: { selection: EditSelection; ops: EditOps; edits: EditActions; songLength: number | null; onClose: () => void }) {
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
        <ClipInspector clip={selection.clip} ops={ops} edits={edits} />
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

function ClipInspector({ clip, ops, edits }: { clip: EditClip; ops: EditOps; edits: EditActions }) {
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
  const fileOut = clip.out ?? clip.in + (clip.end - clip.start) * clip.speed;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="truncate text-sm font-semibold">{clip.name}</p>
        <p className="text-xs text-neutral-500 tabular-nums">
          {clip.start.toFixed(2)}–{clip.end.toFixed(2)} s on the video · file {clip.in.toFixed(2)}–{fileOut.toFixed(2)} s
        </p>
      </div>
      {clip.volumeKeys ? (
        // Keyed volume lives on the clip's volume line; a slider here would flatten it.
        <div className="flex flex-col gap-1 text-xs text-neutral-400">
          <span className="flex justify-between">
            Volume <span className="text-neutral-200 tabular-nums">{clip.volumeKeys.length} keyframes</span>
          </span>
          <p className="text-[11px] text-neutral-500">Drag the volume line on the clip; double-click a point to remove it.</p>
          <button
            type="button"
            onClick={() => edits.apply([{ op: OpName.Patch, id: clip.id, fields: { volume: clip.volume } }], `Volume of ${clip.id}: one level`, true)}
            className="self-start text-[11px] text-neutral-400 hover:text-white"
          >
            Use one level instead
          </button>
        </div>
      ) : (
        <Slider label="Volume" value={clip.volume} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => change([{ op: OpName.Patch, id: clip.id, fields: { volume: v } }])} onDone={() => done(`Volume of ${clip.id}`, true)} />
      )}
      <Slider label="Zoom" value={clip.scale} min={1} max={1.6} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => change([{ op: OpName.SetProp, id: clip.id, prop: "scale", value: v }])} onDone={() => done(`Zoom of ${clip.id}`)} />
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
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>
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
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="truncate text-sm font-semibold">{block.label}</p>
        <p className="text-xs text-neutral-500 tabular-nums">
          Motion graphics · {block.start.toFixed(2)}–{block.end.toFixed(2)} s · {block.ids.length} layers
        </p>
      </div>
      <p className="text-xs text-neutral-500">Tell Claude below what to change in it. Drag it on the timeline to move it in time.</p>
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
