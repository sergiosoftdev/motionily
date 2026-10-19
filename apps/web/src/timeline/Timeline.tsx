import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { OpName } from "@motionily/protocol";
import { commit, preview } from "../editing/direct";
import { retimeGroupOps } from "../editing/groups";
import { engineHost } from "../engine/host";
import { agentBridge } from "../bridge";
import { useEditor } from "../store";
import { loadPeaks } from "./waveform";

const LayerDrag = {
  Move: "move",
  TrimIn: "trim_in",
  TrimOut: "trim_out",
} as const;
type LayerDrag = (typeof LayerDrag)[keyof typeof LayerDrag];
/** Shortest a layer can be trimmed to, in seconds. */
const MIN_LAYER = 0.1;

type AudioTrack = { start: number; trim_in: number; trim_out: number | null };
type SceneView = {
  duration: number;
  layers: {
    id: string;
    type: string;
    text?: string;
    group?: string;
    start?: number;
    end?: number | null;
  }[];
  captions?: {
    words: { text: string; start: number; end: number; emphasis?: boolean }[];
  } | null;
  audio?: AudioTrack | null;
};

const LABEL_W = 92;
const TRACK_H = 26;

const AudioDrag = {
  Move: "move",
  TrimIn: "trim_in",
  TrimOut: "trim_out",
} as const;
type AudioDrag = (typeof AudioDrag)[keyof typeof AudioDrag];

/** Bottom timeline: ruler, audio (waveform + trim), captions word by word, and one bar per layer. */
export function Timeline({ audioUrl }: { audioUrl: string | null }) {
  const time = useEditor((s) => s.time);
  const duration = useEditor((s) => s.duration) || 1;
  const selected = useEditor((s) => s.selectedLayerId);
  const selectedGroup = useEditor((s) => s.selectedGroup);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [scene, setScene] = useState<SceneView | null>(null);
  const [peaks, setPeaks] = useState<{
    peaks: Float32Array;
    duration: number;
  } | null>(null);
  const [draft, setDraft] = useState<AudioTrack | null>(null);
  const area = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const read = () =>
      engineHost.ready &&
      setScene(JSON.parse(engineHost.sceneJson()) as SceneView);
    read();
    const off = engineHost.onSceneChange(read);
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    setPeaks(null);
    if (audioUrl) loadPeaks(audioUrl).then(setPeaks, () => setPeaks(null));
  }, [audioUrl]);

  const pxPerSec = (w: number) => w / duration;
  const toTime = (clientX: number) => {
    const r = area.current!.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(duration, ((clientX - r.left) / r.width) * duration),
    );
  };
  const pct = (t: number) => `${(t / duration) * 100}%`;

  const scrub = (e: ReactPointerEvent) => {
    engineHost.pause();
    engineHost.seek(toTime(e.clientX));
    const move = (ev: PointerEvent) => engineHost.seek(toTime(ev.clientX));
    const up = () => window.removeEventListener("pointermove", move);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const audio: AudioTrack | null =
    draft ??
    scene?.audio ??
    (audioUrl ? { start: 0, trim_in: 0, trim_out: null } : null);
  const fileDuration = peaks?.duration ?? 0;
  const audioOut = audio ? (audio.trim_out ?? fileDuration) : 0;

  const dragAudio = (kind: AudioDrag) => (e: ReactPointerEvent) => {
    if (!audio || !area.current) return;
    e.stopPropagation();
    const width = area.current.getBoundingClientRect().width;
    const x0 = e.clientX;
    const base = { ...audio, trim_out: audio.trim_out ?? fileDuration };
    let last = base;
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / pxPerSec(width);
      if (kind === AudioDrag.Move)
        last = { ...base, start: Math.max(0, base.start + dt) };
      if (kind === AudioDrag.TrimIn) {
        const trimIn = Math.min(
          Math.max(0, base.trim_in + dt),
          (base.trim_out ?? fileDuration) - 0.2,
        );
        last = {
          ...base,
          trim_in: trimIn,
          start: Math.max(0, base.start + (trimIn - base.trim_in)),
        };
      }
      if (kind === AudioDrag.TrimOut)
        last = {
          ...base,
          trim_out: Math.min(
            fileDuration,
            Math.max(base.trim_in + 0.2, base.trim_out! + dt),
          ),
        };
      setDraft(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      setDraft(null);
      engineHost.applyOps([{ op: OpName.SetAudio, audio: last }]);
      agentBridge.sceneChanged();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  /** Move a layer in time or trim its in/out, by hand (no agent). Keyframes ride along with `start`. */
  const dragLayer =
    (id: string, start: number, end: number, kind: LayerDrag) =>
    (e: ReactPointerEvent) => {
      e.stopPropagation();
      if (!area.current) return;
      const width = area.current.getBoundingClientRect().width;
      const x0 = e.clientX;
      let last: [number, number] = [start, end];
      let moved = false;
      const move = (ev: PointerEvent) => {
        const dt = (ev.clientX - x0) / pxPerSec(width);
        if (!moved && Math.abs(ev.clientX - x0) < 3) return;
        moved = true;
        if (kind === LayerDrag.Move) {
          const s = Math.min(Math.max(0, start + dt), duration - (end - start));
          last = [s, s + (end - start)];
        }
        if (kind === LayerDrag.TrimIn)
          last = [Math.min(Math.max(0, start + dt), end - MIN_LAYER), end];
        if (kind === LayerDrag.TrimOut)
          last = [
            start,
            Math.max(start + MIN_LAYER, Math.min(duration, end + dt)),
          ];
        preview([{ op: OpName.SetTiming, id, start: last[0], end: last[1] }]);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        if (moved)
          commit(
            `Tiempo de ${id}: ${last[0].toFixed(2)}–${last[1].toFixed(2)} s`,
          );
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    };

  type SceneLayerView = SceneView["layers"][number];
  const layerRow = (l: SceneLayerView, nested: boolean) => {
    const start = l.start ?? 0;
    const end = l.end ?? duration;
    const isSel = l.id === selected;
    return (
      <Track key={l.id} label={l.id} indent={nested}>
        <button
          type="button"
          onPointerDown={dragLayer(l.id, start, end, LayerDrag.Move)}
          onClick={() => {
            useEditor.setState({ selectedLayerId: l.id, selectedGroup: null });
            // Land a bit after the start, once entrance animations have revealed it.
            if (time < start || time >= end)
              engineHost.seek(Math.min(start + 0.6, (start + end) / 2));
          }}
          className={`absolute inset-y-0.5 overflow-hidden rounded-md px-2 text-left whitespace-nowrap ${
            isSel
              ? "bg-white text-neutral-900"
              : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
          }`}
          style={{ left: pct(start), width: pct(Math.max(0.05, end - start)) }}
        >
          {l.type === "text" && l.text ? `“${l.text}”` : l.id}
          <span
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-sky-400/60"
            onPointerDown={dragLayer(l.id, start, end, LayerDrag.TrimIn)}
          />
          <span
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-sky-400/60"
            onPointerDown={dragLayer(l.id, start, end, LayerDrag.TrimOut)}
          />
        </button>
      </Track>
    );
  };

  /** Drag a whole group's bar in time. */
  const dragGroup = (group: string) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    if (!area.current) return;
    const width = area.current.getBoundingClientRect().width;
    const x0 = e.clientX;
    const base = layers.map((l) => ({ ...l }));
    let dt = 0;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) < 3) return;
      dt = (ev.clientX - x0) / pxPerSec(width);
      preview(retimeGroupOps(group, dt, base, duration));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      if (dt)
        commit(
          `Mueve el grupo ${group} ${dt > 0 ? "+" : ""}${dt.toFixed(2)} s`,
        );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const ticks = useMemo(() => {
    const step = duration > 30 ? 5 : duration > 10 ? 2 : 1;
    return Array.from(
      { length: Math.floor(duration / step) + 1 },
      (_, i) => i * step,
    );
  }, [duration]);

  const words = scene?.captions?.words ?? [];
  const layers = scene?.layers ?? [];
  // Grouped layers collapse under one row per group, in stack order of the group's first layer.
  const entries: { group?: string; layers: SceneView["layers"] }[] = [];
  for (const l of layers) {
    if (!l.group) entries.push({ layers: [l] });
    else {
      const e = entries.find((x) => x.group === l.group);
      if (e) e.layers.push(l);
      else entries.push({ group: l.group, layers: [l] });
    }
  }

  return (
    <div className="flex max-h-[38vh] min-h-0 flex-col overflow-y-auto border-t border-neutral-900 bg-neutral-950 text-[11px] select-none">
      <div className="flex">
        <div style={{ width: LABEL_W }} className="shrink-0" />
        <div
          ref={area}
          className="relative h-6 flex-1 cursor-ew-resize"
          onPointerDown={scrub}
        >
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute top-1 -translate-x-1/2 text-neutral-500 tabular-nums"
              style={{ left: pct(t) }}
            >
              {t}s
            </span>
          ))}
        </div>
        <div className="w-3 shrink-0" />
      </div>

      <Track label="Audio">
        {audio && audioUrl ? (
          <div
            className="absolute inset-y-0.5 flex cursor-grab overflow-hidden rounded-md bg-sky-500/20 ring-1 ring-sky-400/40 active:cursor-grabbing"
            style={{
              left: pct(audio.start),
              width: pct(Math.max(0.1, audioOut - audio.trim_in)),
            }}
            onPointerDown={dragAudio(AudioDrag.Move)}
          >
            {peaks && (
              <Waveform
                peaks={peaks.peaks}
                from={audio.trim_in / peaks.duration}
                to={audioOut / peaks.duration}
              />
            )}
            <span
              className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-sky-300/70"
              onPointerDown={dragAudio(AudioDrag.TrimIn)}
            />
            <span
              className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-sky-300/70"
              onPointerDown={dragAudio(AudioDrag.TrimOut)}
            />
          </div>
        ) : (
          <span className="absolute inset-y-0 left-2 flex items-center text-neutral-600">
            Sube una voz en «Voz y subtítulos»
          </span>
        )}
      </Track>

      <Track label="Subtítulos">
        {words.map((w, i) => (
          <button
            key={i}
            type="button"
            title={w.text}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => engineHost.seek(w.start)}
            className={`absolute inset-y-0.5 overflow-hidden rounded px-1 text-left whitespace-nowrap ${
              w.emphasis
                ? "bg-amber-400/30 text-amber-100"
                : "bg-neutral-800 text-neutral-300"
            }`}
            style={{
              left: pct(w.start),
              width: pct(Math.max(0.05, w.end - w.start)),
            }}
          >
            {w.text}
          </button>
        ))}
      </Track>

      {entries.map((e) =>
        e.group ? (
          <div key={`g-${e.group}`}>
            <GroupTrack
              name={e.group}
              open={open.has(e.group)}
              onToggle={() =>
                setOpen((o) => {
                  const n = new Set(o);
                  if (n.has(e.group!)) n.delete(e.group!);
                  else n.add(e.group!);
                  return n;
                })
              }
            >
              {(() => {
                const start = Math.min(...e.layers.map((l) => l.start ?? 0));
                const end = Math.max(...e.layers.map((l) => l.end ?? duration));
                return (
                  <button
                    type="button"
                    onPointerDown={dragGroup(e.group!)}
                    onClick={() => {
                      useEditor.setState({
                        selectedGroup: e.group!,
                        selectedLayerId: null,
                      });
                      if (time < start || time >= end)
                        engineHost.seek(
                          Math.min(start + 0.6, (start + end) / 2),
                        );
                    }}
                    className={`absolute inset-y-0.5 overflow-hidden rounded-md px-2 text-left font-medium whitespace-nowrap ${
                      selectedGroup === e.group
                        ? "bg-violet-300 text-neutral-900"
                        : "bg-violet-500/25 text-violet-100 hover:bg-violet-500/40"
                    }`}
                    style={{
                      left: pct(start),
                      width: pct(Math.max(0.05, end - start)),
                    }}
                  >
                    ▣ {e.group} · {e.layers.length}
                  </button>
                );
              })()}
            </GroupTrack>
            {open.has(e.group) && e.layers.map((l) => layerRow(l, true))}
          </div>
        ) : (
          layerRow(e.layers[0]!, false)
        ),
      )}

      {/* Playhead over every track. */}
      <div
        className="pointer-events-none sticky bottom-0 -mt-px flex"
        style={{ height: 0 }}
      >
        <div style={{ width: LABEL_W }} className="shrink-0" />
        <div className="relative flex-1">
          <span
            className="absolute bottom-0 w-px bg-white"
            style={{ left: pct(time), height: 9999 }}
          />
        </div>
        <div className="w-3 shrink-0" />
      </div>
    </div>
  );
}

function GroupTrack({
  name,
  open,
  onToggle,
  children,
}: {
  name: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-stretch">
      <button
        type="button"
        onClick={onToggle}
        style={{ width: LABEL_W }}
        className="shrink-0 truncate px-3 py-1.5 text-left text-violet-200 hover:text-white"
      >
        {open ? "▾" : "▸"} {name}
      </button>
      <div
        className="relative flex-1 border-t border-neutral-900"
        style={{ height: TRACK_H }}
      >
        {children}
      </div>
      <div className="w-3 shrink-0" />
    </div>
  );
}

function Track({ label, children, indent = false }: { label: string; children: React.ReactNode; indent?: boolean }) {
  return (
    <div className="flex items-stretch">
      <div
        style={{ width: LABEL_W }}
        className={`shrink-0 truncate py-1.5 pr-3 text-neutral-500 ${indent ? "pl-6" : "pl-3"}`}
      >
        {label}
      </div>
      <div
        className="relative flex-1 border-t border-neutral-900"
        style={{ height: TRACK_H }}
      >
        {children}
      </div>
      <div className="w-3 shrink-0" />
    </div>
  );
}

function Waveform({
  peaks,
  from,
  to,
}: {
  peaks: Float32Array;
  from: number;
  to: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = c.clientHeight * devicePixelRatio);
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, w, h);
    g.fillStyle = "rgba(186,230,253,0.75)";
    const a = Math.floor(from * peaks.length);
    const b = Math.max(a + 1, Math.floor(to * peaks.length));
    for (let x = 0; x < w; x++) {
      const p = peaks[a + Math.floor(((b - a) * x) / w)] ?? 0;
      const bar = Math.max(1, p * h * 0.9);
      g.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [peaks, from, to]);
  return <canvas ref={ref} className="pointer-events-none h-full w-full" />;
}
