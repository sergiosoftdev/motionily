import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { engineHost } from "../engine/host";
import { useEditor } from "../store";
import { clock, groupEntries, landingTime, useSceneView } from "./sceneView";

/** A group spanning nearly the whole video is a backdrop, not a moment: the strip leaves it out. */
const BACKDROP_SHARE = 0.85;
const MAX_LANES = 3;

/**
 * Simple mode's timeline: play, scrub, and the video's moments (its groups) as chapters.
 * Clicking a moment selects it; clicking anywhere else picks that second for the next request.
 */
export function SceneStrip() {
  const scene = useSceneView();
  const time = useEditor((s) => s.time);
  const duration = useEditor((s) => s.duration) || 1;
  const playing = useEditor((s) => s.playing);
  const selectedGroup = useEditor((s) => s.selectedGroup);
  const track = useRef<HTMLDivElement>(null);

  // Chapters packed into lanes so overlapping moments stay readable.
  const lanes = useMemo(() => {
    const out: { group: string; start: number; end: number }[][] = [];
    const chapters = groupEntries(scene?.layers ?? [])
      .filter((e) => e.group)
      .map((e) => ({
        group: e.group!,
        start: Math.min(...e.layers.map((l) => l.start ?? 0)),
        end: Math.max(...e.layers.map((l) => l.end ?? duration)),
      }))
      .filter((c) => c.end - c.start < duration * BACKDROP_SHARE)
      .sort((a, b) => a.start - b.start);
    for (const c of chapters) {
      const lane = out.find((l) => l.at(-1)!.end <= c.start + 0.01) ?? (out.length < MAX_LANES ? null : out.at(-1)!);
      if (lane) lane.push(c);
      else out.push([c]);
    }
    return out;
  }, [scene, duration]);

  const toTime = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };
  const scrub = (e: ReactPointerEvent) => {
    engineHost.pause();
    engineHost.seek(toTime(e.clientX));
    useEditor.setState({ selectedLayerId: null, selectedGroup: null, pinnedMoment: true });
    const move = (ev: PointerEvent) => engineHost.seek(toTime(ev.clientX));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
  };
  const pct = (t: number) => `${(t / duration) * 100}%`;

  return (
    <div className="flex w-full items-center gap-4">
      <button
        type="button"
        onClick={() => (playing ? engineHost.pause() : engineHost.play())}
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-neutral-950 hover:bg-neutral-200"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <svg viewBox="0 0 16 16" className="size-3.5 fill-current"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" className="ml-0.5 size-3.5 fill-current"><path d="M4 2.5v11a.5.5 0 0 0 .77.42l8.5-5.5a.5.5 0 0 0 0-.84l-8.5-5.5A.5.5 0 0 0 4 2.5Z" /></svg>
        )}
      </button>
      <div ref={track} onPointerDown={scrub} className="relative flex min-w-0 flex-1 cursor-pointer flex-col gap-1 py-1.5 select-none">
        <div className="h-1 rounded-full bg-neutral-800">
          <div className="h-full rounded-full bg-white/70" style={{ width: pct(time) }} />
        </div>
        {lanes.map((lane, i) => (
          <div key={i} className="relative h-6">
            {lane.map((c) => (
              <button
                key={c.group}
                type="button"
                title={`${c.group} · ${clock(c.start)}–${clock(c.end)}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  useEditor.setState({ selectedGroup: c.group, selectedLayerId: null, pinnedMoment: false });
                  engineHost.pause();
                  engineHost.seek(landingTime(c.start, c.end));
                }}
                className={`absolute inset-y-0 truncate rounded-md px-2 text-left text-xs ${
                  selectedGroup === c.group ? "bg-white text-neutral-900" : "bg-neutral-800/80 text-neutral-300 hover:bg-neutral-700"
                }`}
                style={{ left: pct(c.start), width: `calc(${pct(c.end - c.start)} - 2px)` }}
              >
                {c.group}
              </button>
            ))}
          </div>
        ))}
        <span className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-white" style={{ left: pct(time) }} />
      </div>
      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-neutral-400">
        {clock(time)} / {clock(duration)}
      </span>
    </div>
  );
}
