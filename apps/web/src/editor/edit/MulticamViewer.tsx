import { useEffect, useMemo, useRef } from "react";
import type { FootageClip } from "@motionily/protocol";
import { engineHost } from "../../engine/host";
import { ActivitySource, logActivity, useEditor, usePlayheadTime } from "../../store";
import { angleName, angleTime, type MulticamClip } from "./multicam";
import { multicamClip, switchAngle } from "./multicamActions";
import type { EditActions } from "./useEditActions";

/** Off by more than this (s) while playing, an angle jumps back in step. */
const DRIFT = 0.2;

/** One camera, muted, kept at the moment the program shows. */
function Angle({ clip, k, footage, onPick }: { clip: MulticamClip; k: number; footage: FootageClip[]; onPick: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const angle = clip.multicam.angles[k]!;
  const live = k === clip.multicam.angle;
  const length = footage.find((f) => f.url === angle.src)?.duration ?? Infinity;
  useEffect(
    () =>
      useEditor.subscribe((s) => {
        const v = video.current;
        if (!v) return;
        const at = angleTime(clip, k, s.time);
        const off = at < 0 || at > length;
        v.style.opacity = off ? "0.15" : "1";
        if (off) return v.pause();
        if (s.playing) {
          if (Math.abs(v.currentTime - at) > DRIFT) v.currentTime = at;
          if (v.paused) void v.play().catch(() => undefined);
        } else {
          if (!v.paused) v.pause();
          if (Math.abs(v.currentTime - at) > 0.01) v.currentTime = at;
        }
      }),
    [clip, k, length],
  );
  useEffect(() => {
    const v = video.current;
    if (v) v.currentTime = Math.max(0, angleTime(clip, k, useEditor.getState().time));
  }, [clip, k]);
  return (
    <button type="button" onClick={onPick} title={`Cut to ${angleName(clip.multicam, k)} at the playhead (${k + 1})`} className={`relative overflow-hidden rounded-md bg-black ring-2 ${live ? "ring-red-500" : "ring-transparent hover:ring-white/40"}`}>
      <video ref={video} src={engineHost.previewSrc(angle.src)} muted playsInline preload="auto" className="h-16 w-auto max-w-[8rem] object-contain" />
      <span className="absolute left-1 top-0.5 rounded bg-black/60 px-1 text-[10px] text-white">
        {k + 1} · {angleName(clip.multicam, k)}
      </span>
    </button>
  );
}

/**
 * The angle viewer of Edit, under the program: every camera of the multicam clip at the playhead, the one
 * on air outlined. Click one (or press its number) to cut to it there, during playback too.
 */
export function MulticamViewer({ footage, edits, version }: { footage: FootageClip[]; edits: EditActions; version: unknown }) {
  const t = usePlayheadTime();
  void version;
  const found = multicamClip(t);
  // The same clip piece keeps its players (a new object every tick would reseek them).
  const key = found ? [found.id, found.start, found.in, found.speed, found.multicam.angle, ...found.multicam.angles.map((a) => `${a.src}@${a.offset}`)].join("|") : "";
  const clip = useMemo(() => found, [key]);
  if (!clip) return null;
  const pick = (k: number) => {
    try {
      const r = switchAngle(k, useEditor.getState().time, footage);
      if (r.ops.length) edits.apply(r.ops, r.text, false);
    } catch (e) {
      logActivity(ActivitySource.System, e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="flex max-w-full gap-1.5 overflow-x-auto px-1" aria-label="Multicam angles">
      {clip.multicam.angles.map((a, k) => (
        <Angle key={`${clip.multicam.group}-${k}-${a.src}`} clip={clip} k={k} footage={footage} onPick={() => pick(k)} />
      ))}
    </div>
  );
}
