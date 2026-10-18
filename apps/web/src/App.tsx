import { useEffect, useRef } from "react";
import { engineHost } from "./engine/host";
import { agentBridge } from "./bridge";
import { EngineStatus, useEditor } from "./store";
import { Transport } from "./components/Transport";
import { StylePicker } from "./components/StylePicker";
import { CaptionPicker } from "./components/CaptionPicker";
import { FeedbackBox } from "./components/FeedbackBox";
import { ActivityLog } from "./components/ActivityLog";

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const status = useEditor((s) => s.engineStatus);
  const error = useEditor((s) => s.engineError);
  const adapter = useEditor((s) => s.adapter);
  const agentConnected = useEditor((s) => s.agentConnected);

  useEffect(() => {
    if (!canvasRef.current) return;
    void engineHost.mount(canvasRef.current).then(() => {
      if (engineHost.ready) agentBridge.start();
    });
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between px-5 py-3">
        <span className="text-[15px] font-semibold">Motionily</span>
        <div className="flex items-center gap-4 text-xs text-neutral-400">
          {adapter && <span className="hidden sm:inline">{adapter}</span>}
          <span className="flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${agentConnected ? "bg-emerald-400" : "bg-neutral-600"}`} />
            {agentConnected ? "Agente conectado" : "Esperando al agente"}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-4">
          <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
            <canvas
              ref={canvasRef}
              className="aspect-[9/16] h-full max-h-full max-w-full rounded-xl shadow-2xl shadow-black/50"
            />
            {status === EngineStatus.Loading && (
              <p className="absolute text-sm text-neutral-400">Arrancando motor…</p>
            )}
            {status === EngineStatus.Failed && (
              <p className="absolute max-w-sm text-center text-sm text-red-400">
                No se pudo iniciar el motor de render: {error}
              </p>
            )}
          </div>
          <Transport />
        </main>

        <aside className="flex w-full flex-col gap-8 overflow-y-auto px-5 py-4 lg:w-80">
          <StylePicker />
          <CaptionPicker />
          <FeedbackBox />
          <ActivityLog />
        </aside>
      </div>
    </div>
  );
}
