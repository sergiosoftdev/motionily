import { useEffect, useMemo, useRef, useState } from "react";
import { FORMAT_SIZE, OpName, type VideoFormat, type Brick, type Build, type Op, type Project } from "@motionily/protocol";
import { api, ApiError, mediaUrl } from "../api/client";
import { ReferenceStrip, useReferences } from "../components/References";
import { engineHost } from "../engine/host";
import { agentBridge } from "../bridge";
import { ActivitySource, EngineStatus, logActivity, useEditor } from "../store";
import { TopBar } from "./TopBar";
import { BrandTab, href, RouteName } from "../router";
import { Transport } from "../components/Transport";
import { FeedbackBox } from "../components/FeedbackBox";
import { ActivityLog } from "../components/ActivityLog";
import { ConnectAgent } from "../components/ConnectAgent";
import { FormatPicker } from "../components/FormatPicker";
import { ExportButton } from "../export/ExportButton";
import { AgentBar } from "../components/AgentBar";
import { ChangeComposer } from "../components/ChangeComposer";
import { useGenerate } from "../components/useGenerate";
import { CaptionsPanel } from "../captions/CaptionsPanel";
import { Timeline } from "../timeline/Timeline";
import { BuildOverlay } from "../timeline/BuildOverlay";
import { SelectionOverlay } from "../timeline/SelectionOverlay";

const SAVE_DEBOUNCE_MS = 800;
/** Widest the preview gets, like a video player rather than a full-bleed canvas. */
const PREVIEW_MAX_WIDTH = 960;

const SidebarTab = { Brief: "brief", Voice: "voice", Format: "format", Log: "log" } as const;
const SIDEBAR_TABS: [SidebarTab, string][] = [
  [SidebarTab.Brief, "Brief"],
  [SidebarTab.Voice, "Voz"],
  [SidebarTab.Format, "Formato"],
  [SidebarTab.Log, "Log"],
];
type SidebarTab = (typeof SidebarTab)[keyof typeof SidebarTab];

/** Rows of the user's prefab library, as the API returns them. */
type PrefabRow = { name: string; node: Record<string, unknown> };

function libraryOf(_build: Build, _byKey: Map<string, Brick>, prefabRows: PrefabRow[]) {
  // Only the user's prefabs (made by the agent). Animations are always the agent's own work.
  return { prefabs: Object.fromEntries(prefabRows.map((p) => [p.name, p.node])) };
}

/**
 * What the editor imposes on every scene: the frame size (from the format) and the helper library
 * (animations, transitions, prefabs). The look (palette, type, finish) belongs to the scene the agent designs.
 */
function buildToOps(build: Build, byKey: Map<string, Brick>, format: VideoFormat, prefabs: PrefabRow[]): Op[] {
  const [width, height] = FORMAT_SIZE[format];
  const ops: Op[] = [
    { op: OpName.SetSize, width, height },
    { op: OpName.SetLibrary, library: libraryOf(build, byKey, prefabs) },
  ];
  return ops;
}

export function EditorScreen({ id }: { id: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const revision = useRef(0);
  const [project, setProject] = useState<Project | null>(null);
  const [bricks, setBricks] = useState<Brick[]>([]);
  const prefabs = useRef<PrefabRow[]>([]);
  const [tab, setTab] = useState<SidebarTab>(SidebarTab.Brief);
  const generation = useGenerate(id);
  const [error, setError] = useState<string | null>(null);
  const status = useEditor((s) => s.engineStatus);
  const engineError = useEditor((s) => s.engineError);
  const agentConnected = useEditor((s) => s.agentConnected);
  const [sceneW, sceneH] = useEditor((s) => s.sceneSize);
  const stage = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ width: number; height: number } | null>(null);

  // Fit the frame inside the stage keeping its exact aspect ratio (CSS alone stretches it
  // when both width and height are constrained). Wide formats stop at a player-like width.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => {
      const maxW = Math.min(el.clientWidth, PREVIEW_MAX_WIDTH);
      const maxH = el.clientHeight;
      const k = Math.min(maxW / sceneW, maxH / sceneH);
      setPreview({ width: Math.floor(sceneW * k), height: Math.floor(sceneH * k) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sceneW, sceneH]);

  const byKey = useMemo(() => new Map(bricks.map((b) => [b.key, b])), [bricks]);

  // Load project + its catalog, then start the engine on its scene.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.project(id), api.projectBricks(id), api.prefabs(id)])
      .then(async ([p, b, pf]) => {
        prefabs.current = pf;
        if (cancelled || !canvasRef.current) return;
        setProject(p);
        setBricks(b);
        revision.current = p.sceneRevision;
        await engineHost.mount(canvasRef.current, p.scene ? JSON.stringify(p.scene) : null);
        if (cancelled || !engineHost.ready) return;
        engineHost.setBuildOps(buildToOps(p.build, new Map(b.map((x) => [x.key, x])), p.format, prefabs.current));
        agentBridge.setProject(id);
        // Once analysed, the agent's summary lists the beats it can sync to.
        void engineHost.setAudio(p.audio ? mediaUrl(p.audio.url) : null).then(() => agentBridge.sceneChanged());
        useEditor.setState({ selectedLayerId: null, selectedGroup: null });
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      agentBridge.setProject(null);
      engineHost.unmount();
    };
  }, [id]);

  // The agent changed options or format: reload the project and re-apply them to the engine.
  useEffect(() => {
    agentBridge.onProjectChanged = () => {
      void Promise.all([api.project(id), api.projectBricks(id), api.prefabs(id)]).then(([p, b, pf]) => {
        prefabs.current = pf;
        setProject(p);
        setBricks(b);
        if (engineHost.ready) engineHost.setBuildOps(buildToOps(p.build, new Map(b.map((x) => [x.key, x])), p.format, pf));
        // A new voice-over (set_voice_script) changes what audio-reactive expressions read.
        if (engineHost.ready) void engineHost.setAudio(p.audio ? mediaUrl(p.audio.url) : null).then(() => agentBridge.sceneChanged());
      });
    };
    return () => {
      agentBridge.onProjectChanged = null;
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

  const rename = async (name: string) => {
    if (!project || !name.trim() || name === project.name) return;
    setProject(await api.updateProject(id, { name: name.trim() }));
  };
  const changeFormat = async (format: VideoFormat) => {
    if (!project || format === project.format) return;
    const p = await api.updateProject(id, { format });
    setProject(p);
    engineHost.setBuildOps(buildToOps(p.build, byKey, p.format, prefabs.current));
    agentBridge.sceneChanged();
    logActivity(ActivitySource.User, `Formato: ${format}`);
    // A new frame shape needs a new layout, not a stretched one: let the agent recompose.
    const [w, h] = FORMAT_SIZE[format];
    if (p.scene && (p.scene.layers as unknown[] | undefined)?.length) {
      void api
        .generate(id, `The user switched the format to ${w}x${h}. Recompose every beat for this frame (positions, sizes, line breaks) keeping the content; check with render_frames.`)
        .catch(() => undefined);
    }
  };
  const saveBrief = async (brief: string) => {
    if (!project || brief === project.brief) return;
    setProject(await api.updateProject(id, { brief }));
  };

  return (
    <div className="flex h-dvh flex-col">
      <TopBar>
        {project?.brandId && (
          <a href={href({ name: RouteName.Brand, id: project.brandId, tab: BrandTab.Videos })} className="text-xs text-neutral-500 hover:text-white">
            ← Proyecto
          </a>
        )}
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
        {project && <ExportButton name={project.name} audioUrl={project.audio ? mediaUrl(project.audio.url) : null} />}
        <ConnectAgent projectId={id} />
      </TopBar>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
          <div ref={stage} className="relative flex min-h-0 w-full flex-1 items-center justify-center">
            <canvas
              ref={canvasRef}
              style={preview ?? { visibility: "hidden" }}
              className="rounded-xl shadow-2xl shadow-black/50"
            />
            <BuildOverlay canvas={canvasRef} />
            <SelectionOverlay canvas={canvasRef} projectId={id} />
            {status === EngineStatus.Loading && !error && <p className="absolute text-sm text-neutral-400">Arrancando motor…</p>}
            {(error || status === EngineStatus.Failed) && (
              <p className="absolute max-w-sm text-center text-sm text-red-400">{error ?? `No se pudo iniciar el motor: ${engineError}`}</p>
            )}
          </div>
          <Transport />
          </div>
          <Timeline audioUrl={project?.audio ? mediaUrl(project.audio.url) : null} />
        </main>

        <aside className="relative flex min-h-0 w-full flex-col lg:w-96">
          {project && (
            <div className="px-5 pt-4 pb-5">
              <AgentBar g={generation} hasScene={!!project.scene} runs={project.agentRuns ?? []} />
            </div>
          )}
          <div className="flex gap-1 px-5">
            {SIDEBAR_TABS.map(([t, label]) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${tab === t ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-white"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {project && tab === SidebarTab.Brief && (
              <BriefBox key={project.id} project={project} onBrief={(b) => void saveBrief(b)} onReferences={(references) => void api.updateProject(id, { references }).then(setProject)} />
            )}
            {project && tab === SidebarTab.Voice && (
              <div className="flex flex-col gap-6">
                {project.voiceScript.trim() && <VoiceScript script={project.voiceScript} hasVoice={!!project.audio} />}
                <CaptionsPanel project={project} onProject={setProject} />
              </div>
            )}
            {project && tab === SidebarTab.Format && <FormatPicker value={project.format} onChange={(f) => void changeFormat(f)} />}
            {tab === SidebarTab.Log && (
              <div className="flex flex-col gap-8">
                <FeedbackBox projectId={id} />
                <ActivityLog />
              </div>
            )}
          </div>
          {project && (
            <div className="px-5 pt-3 pb-4">
              <ChangeComposer g={generation} hasScene={!!project.scene} />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** The ElevenLabs script the video is built on: copy it, generate the voice, upload it below. */
function VoiceScript({ script, hasVoice }: { script: string; hasVoice: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold">Guion de la voz</span>
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(script).then(() => setCopied(true))}
          className="text-xs text-neutral-400 hover:text-white"
        >
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-neutral-300">{script}</p>
      <span className="text-xs text-neutral-500">
        {hasVoice ? "Voz subida: el agente ata el vídeo a sus palabras." : "Pégalo en ElevenLabs, descarga el mp3 y súbelo en «Voz y subtítulos». Luego, Generar."}
      </span>
    </section>
  );
}

/** The brief plus its reference images (paste, drop or attach); both are what the agent builds from. */
function BriefBox({ project, onBrief, onReferences }: { project: Project; onBrief: (brief: string) => void; onReferences: (refs: string[]) => void }) {
  const refs = useReferences(project.references, onReferences);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="brief" className="text-xs text-neutral-500">
        De qué va el vídeo · Claude lo diseña entero a partir de esto
      </label>
      <textarea
        id="brief"
        defaultValue={project.brief}
        onBlur={(e) => onBrief(e.target.value)}
        rows={6}
        placeholder="Ej.: anuncio de 20 s de mi app de reservas para fisios, tono cercano"
        className="resize-none rounded-lg bg-neutral-900 px-3 py-2 text-[13px] leading-relaxed placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
        {...refs.handlers}
      />
      <span className="mt-3 text-xs text-neutral-500">Referencias · imágenes o vídeos (⌘V o arrastra)</span>
      <ReferenceStrip r={refs} />
    </div>
  );
}
