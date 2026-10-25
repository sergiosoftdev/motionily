import { useEffect, useRef, useState } from "react";
import { engineHost } from "../../engine/host";
import { useEditor } from "../../store";
import { SCOPE_LABEL, ScopeMode, drawScope } from "./colorScopes";

const MODE_KEY = "motionily.scopeMode";
/** Frame width the scopes sample (enough detail, cheap to read back every change). */
const SAMPLE_WIDTH = 240;
const REFRESH_MS = 120;

function savedMode(): ScopeMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return (Object.values(ScopeMode) as string[]).includes(v ?? "") ? (v as ScopeMode) : ScopeMode.Waveform;
  } catch {
    return ScopeMode.Waveform;
  }
}

/** Live scopes of the frame at the playhead (grade included), refreshed as the scene or the time changes. */
export function Scopes() {
  const [mode, setMode] = useState<ScopeMode>(savedMode);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Paused only: while playing the scopes wait.
  const time = useEditor((s) => (s.playing ? -1 : s.time));
  const playing = useEditor((s) => s.playing);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    const off = engineHost.onSceneChange(() => setRev((n) => n + 1));
    return () => void off();
  }, []);
  useEffect(() => {
    if (playing) return;
    let live = true;
    const id = window.setTimeout(() => {
      void engineHost.framePixels(null, SAMPLE_WIDTH).then(([f]) => {
        if (live && f && canvas.current) drawScope(canvas.current, f.image, mode);
      });
    }, REFRESH_MS);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [mode, time, playing, rev]);

  const pick = (m: ScopeMode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* the choice just isn't remembered */
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1">
        {Object.values(ScopeMode).map((m) => (
          <button key={m} type="button" onClick={() => pick(m)} className={`rounded px-1.5 py-0.5 text-[10px] ${mode === m ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-white"}`}>
            {SCOPE_LABEL[m]}
          </button>
        ))}
      </div>
      <canvas ref={canvas} width={320} height={160} className="w-full rounded-md bg-black ring-1 ring-white/10" />
    </div>
  );
}
