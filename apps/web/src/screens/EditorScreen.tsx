import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrickSlot, EngineSupport, OpName, type Brick, type Build, type Op, type PalettePayload, type Project } from "@motionily/protocol";
import { api, ApiError } from "../api/client";
import { engineHost } from "../engine/host";
import { agentBridge } from "../bridge";
import { ActivitySource, EngineStatus, logActivity, useEditor } from "../store";
import { TopBar } from "./TopBar";
import { Transport } from "../components/Transport";
import { FeedbackBox } from "../components/FeedbackBox";
import { ActivityLog } from "../components/ActivityLog";
import { StylePanel } from "../components/style/StylePanel";
import { OptionsSheet } from "../components/style/OptionsSheet";
import { slotUi } from "../components/style/options";
import { ConnectAgent } from "../components/ConnectAgent";

const SAVE_DEBOUNCE_MS = 800;

const SidebarTab = { Video: "video", Feedback: "feedback" } as const;
type SidebarTab = (typeof SidebarTab)[keyof typeof SidebarTab];

/** Engine library from the project's bricks: every animation/transition it may use, plus the composition anchors. */
function libraryOf(build: Build, byKey: Map<string, Brick>) {
  const animations: Record<string, unknown> = {};
  const transitions: Record<string, unknown> = {};
  for (const b of byKey.values()) {
    if (b.engine !== EngineSupport.Supported) continue;
    if (b.slot === BrickSlot.Animation) animations[b.key] = { keys: b.payload.keys };
    if (b.slot === BrickSlot.Transition) transitions[b.key] = { kind: b.payload.kind };
  }
  const anchors = (byKey.get(build.composition)?.payload.anchors as Record<string, [number, number]> | undefined) ?? {};
  return { animations, transitions, anchors };
}

/** Mirror the bricks the engine already understands into scene ops. */
function buildToOps(build: Build, byKey: Map<string, Brick>): Op[] {
  const ops: Op[] = [{ op: OpName.SetLibrary, library: libraryOf(build, byKey) }];
  const palette = byKey.get(build.palette);
  if (palette) ops.push({ op: OpName.SetPalette, palette: palette.payload as PalettePayload });
  const captionId = build.captions.split("/")[1];
  const engineCaption = engineHost.captionStyles.find((c) => c === captionId);
  if (engineCaption) ops.push({ op: OpName.SetCaptionStyle, caption_style: engineCaption });
  return ops;
}

export function EditorScreen({ id }: { id: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const revision = useRef(0);
  const [project, setProject] = useState<Project | null>(null);
  const [bricks, setBricks] = useState<Brick[]>([]);
  const [openSlot, setOpenSlot] = useState<BrickSlot | null>(null);
  const [tab, setTab] = useState<SidebarTab>(SidebarTab.Video);
  const [error, setError] = useState<string | null>(null);
  const status = useEditor((s) => s.engineStatus);
  const engineError = useEditor((s) => s.engineError);
  const agentConnected = useEditor((s) => s.agentConnected);

  const byKey = useMemo(() => new Map(bricks.map((b) => [b.key, b])), [bricks]);
  const nameOf = useCallback((key: string) => byKey.get(key)?.name ?? key, [byKey]);

  // Load project + its catalog, then start the engine on its scene.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.project(id), api.projectBricks(id)])
      .then(async ([p, b]) => {
        if (cancelled || !canvasRef.current) return;
        setProject(p);
        setBricks(b);
        revision.current = p.sceneRevision;
        await engineHost.mount(canvasRef.current, p.scene ? JSON.stringify(p.scene) : null);
        if (cancelled || !engineHost.ready) return;
        engineHost.setBuildOps(buildToOps(p.build, new Map(b.map((x) => [x.key, x]))));
        agentBridge.start();
        agentBridge.setProject(id);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      agentBridge.setProject(null);
      engineHost.unmount();
    };
  }, [id]);

  // Persist every scene change (agent or user), debounced, with optimistic revisions.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = engineHost.onSceneChange(() => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const res = await api.saveScene(id, JSON.parse(engineHost.sceneJson()), revision.current);
          revision.current = res.sceneRevision;
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            logActivity(ActivitySource.System, "La escena cambió en otro sitio; recarga para ver la última");
          }
        }
      }, SAVE_DEBOUNCE_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [id]);

  const pick = async (slot: BrickSlot, value: string | string[] | null, applyKitDefaults?: boolean) => {
    try {
      const p = await api.setSlot(id, slot, value, applyKitDefaults);
      setProject(p);
      if (engineHost.ready) {
        engineHost.setBuildOps(buildToOps(p.build, byKey));
        agentBridge.sceneChanged();
      }
      const names = [value].flat().filter(Boolean).map((k) => nameOf(k as string));
      logActivity(ActivitySource.User, `${slotUi(slot).label}: ${names.join(", ") || "vacío"}`);
      if (slot !== BrickSlot.Character && slot !== BrickSlot.Animation && slot !== BrickSlot.Transition) setOpenSlot(null);
    } catch (e) {
      logActivity(ActivitySource.System, e instanceof Error ? e.message : String(e));
    }
  };

  const rename = async (name: string) => {
    if (!project || !name.trim() || name === project.name) return;
    setProject(await api.updateProject(id, { name: name.trim() }));
  };
  const saveBrief = async (brief: string) => {
    if (!project || brief === project.brief) return;
    setProject(await api.updateProject(id, { brief }));
  };

  return (
    <div className="flex h-dvh flex-col">
      <TopBar>
        {project && (
          <input
            key={project.name}
            defaultValue={project.name}
            onBlur={(e) => void rename(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="min-w-0 rounded-md bg-transparent px-2 py-1 text-sm font-medium hover:bg-neutral-900 focus:bg-neutral-900 focus:outline-none"
            aria-label="Nombre del proyecto"
          />
        )}
        <span className="ml-auto flex items-center gap-1.5 text-xs text-neutral-400">
          <span className={`size-2 rounded-full ${agentConnected ? "bg-emerald-400" : "bg-neutral-600"}`} />
          {agentConnected ? "Agente conectado" : "Esperando al agente"}
        </span>
        <ConnectAgent projectId={id} />
      </TopBar>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-4">
          <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
            <canvas ref={canvasRef} className="aspect-[9/16] h-full max-h-full max-w-full rounded-xl shadow-2xl shadow-black/50" />
            {status === EngineStatus.Loading && !error && <p className="absolute text-sm text-neutral-400">Arrancando motor…</p>}
            {(error || status === EngineStatus.Failed) && (
              <p className="absolute max-w-sm text-center text-sm text-red-400">{error ?? `No se pudo iniciar el motor: ${engineError}`}</p>
            )}
          </div>
          <Transport />
        </main>

        <aside className="relative flex w-full flex-col lg:w-96">
          <div className="flex gap-1 px-5 pt-3">
            {[
              [SidebarTab.Video, "Vídeo"],
              [SidebarTab.Feedback, "Feedback"],
            ].map(([t, label]) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t as SidebarTab)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${tab === t ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {project && tab === SidebarTab.Video && (
              <div className="flex flex-col gap-6">
                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold">¿De qué va el vídeo?</span>
                  <span className="-mt-1 text-xs text-neutral-500">El agente lo monta a partir de esto y del estilo que elijas.</span>
                  <textarea
                    key={project.id}
                    defaultValue={project.brief}
                    onBlur={(e) => void saveBrief(e.target.value)}
                    rows={4}
                    placeholder="Ej.: anuncio de 20 s de mi app de reservas para fisios, tono cercano"
                    className="resize-none rounded-lg bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
                  />
                </label>
                <StylePanel build={project.build} byKey={byKey} onOpen={setOpenSlot} />
              </div>
            )}
            {tab === SidebarTab.Feedback && (
              <div className="flex flex-col gap-8">
                <FeedbackBox projectId={id} />
                <ActivityLog />
              </div>
            )}
          </div>
          {project && openSlot && (
            <OptionsSheet
              slot={openSlot}
              build={project.build}
              bricks={bricks}
              byKey={byKey}
              onPick={(value, rebox) => void pick(openSlot, value, rebox)}
              onClose={() => setOpenSlot(null)}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
