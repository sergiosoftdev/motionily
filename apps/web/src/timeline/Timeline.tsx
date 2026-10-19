import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { OpName } from "@motionily/protocol";
import { engineHost } from "../engine/host";
import { agentBridge } from "../bridge";
import { useEditor } from "../store";
import { loadPeaks } from "./waveform";

type AudioTrack = { start: number; trim_in: number; trim_out: number | null };
type SceneView = {
  duration: number;
  layers: { id: string; type: string; text?: string; start?: number; end?: number | null }[];
  captions?: { words: { text: string; start: number; end: number; emphasis?: boolean }[] } | null;
  audio?: AudioTrack | null;
};

const LABEL_W = 92;
const TRACK_H = 26;

const AudioDrag = { Move: "move", TrimIn: "trim_in", TrimOut: "trim_out" } as const;
type AudioDrag = (typeof AudioDrag)[keyof typeof AudioDrag];

/** Bottom timeline: ruler, audio (waveform + trim), captions word by word, and one bar per layer. */
export function Timeline({ audioUrl }: { audioUrl: string | null }) {
  const time = useEditor((s) => s.time);
  const duration = useEditor((s) => s.duration) || 1;
  const selected = useEditor((s) => s.selectedLayerId);
  const [scene, setScene] = useState<SceneView | null>(null);
  const [peaks, setPeaks] = useState<{ peaks: Float32Array; duration: number } | null>(null);
  const [draft, setDraft] = useState<AudioTrack | null>(null);
  const area = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const read = () => engineHost.ready && setScene(JSON.parse(engineHost.sceneJson()) as SceneView);
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
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
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

  const audio: AudioTrack | null = draft ?? scene?.audio ?? (audioUrl ? { start: 0, trim_in: 0, trim_out: null } : null);
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
      if (kind === AudioDrag.Move) last = { ...base, start: Math.max(0, base.start + dt) };
      if (kind === AudioDrag.TrimIn) {
        const trimIn = Math.min(Math.max(0, base.trim_in + dt), (base.trim_out ?? fileDuration) - 0.2);
        last = { ...base, trim_in: trimIn, start: Math.max(0, base.start + (trimIn - base.trim_in)) };
      }
      if (kind === AudioDrag.TrimOut) last = { ...base, trim_out: Math.min(fileDuration, Math.max(base.trim_in + 0.2, base.trim_out! + dt)) };
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

  const ticks = useMemo(() => {
    const step = duration > 30 ? 5 : duration > 10 ? 2 : 1;
    return Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step);
  }, [duration]);

  const words = scene?.captions?.words ?? [];
  const layers = scene?.layers ?? [];

  return (
    <div className="flex max-h-[38vh] min-h-0 flex-col overflow-y-auto border-t border-neutral-900 bg-neutral-950 text-[11px] select-none">
      <div className="flex">
        <div style={{ width: LABEL_W }} className="shrink-0" />
        <div ref={area} className="relative h-6 flex-1 cursor-ew-resize" onPointerDown={scrub}>
          {ticks.map((t) => (
            <span key={t} className="absolute top-1 -translate-x-1/2 text-neutral-500 tabular-nums" style={{ left: pct(t) }}>
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
            style={{ left: pct(audio.start), width: pct(Math.max(0.1, audioOut - audio.trim_in)) }}
            onPointerDown={dragAudio(AudioDrag.Move)}
          >
            {peaks && <Waveform peaks={peaks.peaks} from={audio.trim_in / peaks.duration} to={audioOut / peaks.duration} />}
            <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-sky-300/70" onPointerDown={dragAudio(AudioDrag.TrimIn)} />
            <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-sky-300/70" onPointerDown={dragAudio(AudioDrag.TrimOut)} />
          </div>
        ) : (
          <span className="absolute inset-y-0 left-2 flex items-center text-neutral-600">Sube una voz en «Voz y subtítulos»</span>
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
              w.emphasis ? "bg-amber-400/30 text-amber-100" : "bg-neutral-800 text-neutral-300"
            }`}
            style={{ left: pct(w.start), width: pct(Math.max(0.05, w.end - w.start)) }}
          >
            {w.text}
          </button>
        ))}
      </Track>

      {layers.map((l) => {
        const start = l.start ?? 0;
        const end = l.end ?? duration;
        const isSel = l.id === selected;
        return (
          <Track key={l.id} label={l.id}>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                useEditor.setState({ selectedLayerId: l.id });
                // Land a bit after the start, once entrance animations have revealed it.
                if (time < start || time >= end) engineHost.seek(Math.min(start + 0.6, (start + end) / 2));
              }}
              className={`absolute inset-y-0.5 overflow-hidden rounded-md px-2 text-left whitespace-nowrap ${
                isSel ? "bg-white text-neutral-900" : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
              }`}
              style={{ left: pct(start), width: pct(Math.max(0.05, end - start)) }}
            >
              {l.type === "text" && l.text ? `“${l.text}”` : l.id}
            </button>
          </Track>
        );
      })}

      {/* Playhead over every track. */}
      <div className="pointer-events-none sticky bottom-0 -mt-px flex" style={{ height: 0 }}>
        <div style={{ width: LABEL_W }} className="shrink-0" />
        <div className="relative flex-1">
          <span className="absolute bottom-0 w-px bg-white" style={{ left: pct(time), height: 9999 }} />
        </div>
        <div className="w-3 shrink-0" />
      </div>
    </div>
  );
}

function Track({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-stretch">
      <div style={{ width: LABEL_W }} className="shrink-0 truncate px-3 py-1.5 text-neutral-500">
        {label}
      </div>
      <div className="relative flex-1 border-t border-neutral-900" style={{ height: TRACK_H }}>
        {children}
      </div>
      <div className="w-3 shrink-0" />
    </div>
  );
}

function Waveform({ peaks, from, to }: { peaks: Float32Array; from: number; to: number }) {
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
