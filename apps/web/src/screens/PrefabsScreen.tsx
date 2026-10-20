import { useEffect, useRef, useState } from "react";
import { OpName } from "@motionily/protocol";
import { api, PrefabKind, type PrefabSummary } from "../api/client";
import { engineHost } from "../engine/host";
import { agentBridge } from "../bridge";
import { EngineStatus, useEditor } from "../store";
import { MotionilyLayout } from "../shell/MotionilyLayout";
import { GenerateEventKind, GenerateStatus, loadPrefs, TOOL_LABEL, type GenerateState } from "../components/GeneratePanel";

const KIND_LABEL: Record<PrefabKind, string> = { [PrefabKind.Object]: "Objeto", [PrefabKind.Character]: "Personaje", [PrefabKind.Space]: "Espacio" };
const POLL_MS = 1500;
const TURNTABLE_SECONDS = 8;

/** Turntable scene for one prefab: it sits on a floor while the camera circles it. */
function turntable(name: string | null, kind: PrefabKind) {
  return JSON.stringify({
    width: 1080,
    height: 1080,
    fps: 30,
    duration: TURNTABLE_SECONDS,
    layers: [],
    stage: {
      floor: "surface",
      camera: { fov: 30 },
      // One slow orbit framing whatever the prefab is, whatever its size.
      shots: [{ start: 0, end: TURNTABLE_SECONDS, kind: "orbit", target: "all", yaw: 20, sweep: 360, ease: "linear", pitch: kind === PrefabKind.Space ? 30 : 14, framing: 1.15 }],
      props: name ? [{ id: "preview", prefab: name }] : [],
    },
  });
}

/** The user's prefab library: browse, preview in 3D, reshape by prompt, duplicate, delete. */
export function PrefabsScreen() {
  const [prefabs, setPrefabs] = useState<PrefabSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** A "create with AI" run in progress: the studio shows the empty turntable it builds on. */
  const [creating, setCreating] = useState(false);
  const [idea, setIdea] = useState("");
  const reload = () => api.myPrefabs().then((p) => {
    setPrefabs(p);
    setSelected((s) => s ?? p[0]?.name ?? null);
  });

  useEffect(() => {
    void reload();
  }, []);

  const current = prefabs?.find((p) => p.name === selected) ?? null;
  const listed = !creating && !!prefabs && prefabs.length > 0;
  return (
    <MotionilyLayout
      title="Prefabs"
      description="Objects, characters and spaces the agent has built. They're reused across all your projects."
      sidebar={
        listed &&
        prefabs.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => setSelected(p.name)}
            className={`flex w-full flex-col rounded-lg px-3 py-2 text-left ${p.name === selected ? "bg-neutral-800" : "hover:bg-neutral-900"}`}
          >
            <span className="text-sm font-medium">{p.name}</span>
            <span className="text-xs text-neutral-500">
              {KIND_LABEL[p.kind]} · v{p.version}
              {p.parent ? ` · de ${p.parent}` : ""}
            </span>
          </button>
        ))
      }
    >
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (idea.trim()) setCreating(true);
        }}
      >
        <input
          value={idea}
          disabled={creating}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="Create with AI: “stick figure in a lab coat”, “electric treatment table”, “clinic front desk”…"
          className="flex-1 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
        />
        <button type="submit" disabled={creating || !idea.trim()} className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-40">
          Create
        </button>
      </form>
      {creating && (
        <PrefabDetail
          prefab={null}
          idea={idea}
          onChanged={() => void reload()}
          onGone={() => {
            setCreating(false);
            setIdea("");
            void api.myPrefabs().then((p) => {
              setPrefabs(p);
              setSelected(p[0]?.name ?? null);
            });
          }}
        />
      )}
      {!creating && prefabs?.length === 0 && (
        <p className="rounded-xl border border-dashed border-neutral-800 p-10 text-center text-sm text-neutral-400">
          Aún no hay prefabs. Pídele a un vídeo algo en 3D (una camilla, una fisio, una consulta) y el agente los irá guardando aquí.
        </p>
      )}
      {listed && current && <PrefabDetail key={current.name} prefab={current} idea={null} onChanged={() => void reload()} onGone={() => { setSelected(null); void reload(); }} />}
    </MotionilyLayout>
  );
}

function PrefabDetail({
  prefab,
  idea,
  onChanged,
  onGone,
}: {
  /** null while creating a new one from `idea`. */
  prefab: PrefabSummary | null;
  idea: string | null;
  onChanged: () => void;
  onGone: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const status = useEditor((s) => s.engineStatus);
  const [instruction, setInstruction] = useState("");
  const [run, setRun] = useState<(GenerateState & { videoId: string }) | null>(null);
  const running = run?.status === GenerateStatus.Running;

  // Live preview: this page acts as the editor of the user's hidden workshop video,
  // so the agent sees (render_frames) and changes (define_prefab) what is on screen.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [{ videoId }, all] = await Promise.all([api.prefabWorkshop(), api.myPrefabTrees()]);
      if (cancelled || !canvas.current) return;
      await engineHost.mount(canvas.current, turntable(prefab?.name ?? null, prefab?.kind ?? PrefabKind.Object));
      if (cancelled || !engineHost.ready) return;
      engineHost.setBuildOps([{ op: OpName.SetLibrary, library: { prefabs: Object.fromEntries(all.map((p) => [p.name, p.node])) } }]);
      engineHost.loop = true;
      engineHost.play();
      agentBridge.setProject(videoId);
      // Create mode: start the agent once the studio is live, so it can show what it builds.
      if (!prefab && idea) setRun(await api.createPrefab(idea, loadPrefs()));
    })();
    return () => {
      cancelled = true;
      agentBridge.setProject(null);
      engineHost.unmount();
    };
  }, [prefab?.name, prefab?.kind, idea]);

  useEffect(() => {
    if (!running || !run) return;
    const timer = setInterval(
      () =>
        void api.generateStatus(run.videoId).then((s) => {
          setRun({ ...s, videoId: run.videoId });
          if (s.status !== GenerateStatus.Running) (prefab ? onChanged : onGone)();
        }),
      POLL_MS,
    );
    return () => clearInterval(timer);
  }, [running, run?.videoId]);

  const edit = async () => {
    if (!prefab || !instruction.trim()) return;
    setRun(await api.editPrefab(prefab.name, instruction.trim(), loadPrefs()));
    setInstruction("");
  };

  const duplicate = async () => {
    if (!prefab) return;
    const name = prompt("Name of the copy (snake_case)", `${prefab.name}_v2`);
    if (!name) return;
    await api.clonePrefab(prefab.name, name).then(onChanged, (e: Error) => alert(e.message));
  };

  const remove = async () => {
    if (!prefab) return;
    if (!confirm(`Delete the prefab "${prefab.name}"? Videos that use it will stop showing it.`)) return;
    await api.deletePrefab(prefab.name);
    onGone();
  };

  const steps = (run?.events ?? []).filter((e) => e.kind !== GenerateEventKind.Text).slice(-4);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <div className="relative aspect-square max-h-[520px] w-full max-w-[520px] overflow-hidden rounded-xl bg-neutral-900">
        <canvas ref={canvas} className="size-full" />
        {status === EngineStatus.Loading && <p className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">Loading 3D view…</p>}
      </div>
      <div className="flex max-w-[520px] flex-col gap-1">
        <h2 className="font-semibold">{prefab?.name ?? "Creando…"}</h2>
        <p className="text-sm text-neutral-400">{prefab ? prefab.description || "No description." : idea}</p>
      </div>
      {prefab && (
      <form
        className="flex max-w-[520px] gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void edit();
        }}
      >
        <input
          value={instruction}
          disabled={running}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={running ? "The agent is on it…" : "Ask for a change: “taller”, “with wheels”, “blue version”…"}
          className="flex-1 rounded-lg bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
        />
        <button type="submit" disabled={running || !instruction.trim()} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-40">
          Aplicar
        </button>
      </form>
      )}
      {run && (
        <div className="flex max-w-[520px] flex-col gap-1 text-xs">
          {running && (
            <span className="flex items-center gap-2 text-neutral-300">
              <span className="size-2 animate-pulse rounded-full bg-emerald-400" /> {prefab ? "The agent is changing the prefab…" : "The agent is designing your prefab…"}
            </span>
          )}
          {steps.map((e, i) => (
            <span key={i} className={e.kind === GenerateEventKind.Error ? "text-red-400" : "text-neutral-500"}>
              {TOOL_LABEL[e.text] ?? e.text}
            </span>
          ))}
          {!running && run.summary && <span className="text-neutral-400">{run.summary}</span>}
        </div>
      )}
      {prefab && (
      <div className="flex gap-4 text-xs">
        <button type="button" onClick={() => void duplicate()} className="text-neutral-400 hover:text-white">
          Duplicate
        </button>
        <button type="button" onClick={() => void remove()} className="text-neutral-500 hover:text-red-400">
          Delete
        </button>
      </div>
      )}
    </div>
  );
}
