import { useEffect, useMemo, useRef, useState } from "react";
import { FORMAT_SIZE, OpName, type VideoFormat, type Brick, type Build, type Op, type Project } from "@motionily/protocol";
import { api, ApiError, mediaUrl } from "../api/client";
import { engineHost } from "../engine/host";
import { agentBridge } from "../bridge";
import { ActivitySource, logActivity, useEditor } from "../store";
import { useGenerate } from "../components/useGenerate";
import { useVoicePipeline } from "../captions/voiceCaptions";
import type { EditorProps } from "../editor/context";
import { EditorMode, useEditorMode } from "../editor/mode";
import { SimpleEditor } from "../editor/SimpleEditor";
import { ProEditor } from "../editor/pro/ProEditor";
import { EditEditor } from "../editor/edit/EditEditor";
import { OpenElsewhere } from "../editor/OpenElsewhere";

const SAVE_DEBOUNCE_MS = 800;

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
  // One engine canvas for the whole screen: each mode's viewer adopts it, so switching modes
  // never restarts the engine or reloads the scene.
  const [canvasEl] = useState(() => {
    const c = document.createElement("canvas");
    // The preview flies from its place in one mode to its place in the next (see editor/mode.tsx).
    c.dataset.modePiece = "preview";
    return c;
  });
  const canvas = useRef(canvasEl);
  const revision = useRef(0);
  const [project, setProject] = useState<Project | null>(null);
  const [bricks, setBricks] = useState<Brick[]>([]);
  const prefabs = useRef<PrefabRow[]>([]);
  const generation = useGenerate(id);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useEditorMode();
  const captioning = useVoicePipeline(project, setProject);

  const byKey = useMemo(() => new Map(bricks.map((b) => [b.key, b])), [bricks]);

  // Load project + its catalog, then start the engine on its scene.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.project(id), api.projectBricks(id), api.prefabs(id)])
      .then(async ([p, b, pf]) => {
        prefabs.current = pf;
        if (cancelled || !canvas.current) return;
        setProject(p);
        setBricks(b);
        revision.current = p.sceneRevision;
        await engineHost.mount(canvas.current, p.scene ? JSON.stringify(p.scene) : null);
        if (cancelled || !engineHost.ready) return;
        engineHost.setBuildOps(buildToOps(p.build, new Map(b.map((x) => [x.key, x])), p.format, prefabs.current));
        agentBridge.setProject(id);
        // Once analysed, the agent's summary lists the beats it can sync to.
        void engineHost.setAudio(p.audio ? mediaUrl(p.audio.url) : null).then(() => agentBridge.sceneChanged());
        // The conversation and log belong to this video, not the one open before.
        useEditor.setState({ selectedLayerId: null, selectedGroup: null, pinnedMoment: false, activity: [] });
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
  /** Saves the waiting change right away (null when nothing waits). */
  const flush = useRef<(() => Promise<void>) | null>(null);
  /** The save in flight; saves run one after another so each sends the latest revision. */
  const saving = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = async () => {
      try {
        const res = await api.saveScene(id, JSON.parse(engineHost.sceneJson()), revision.current);
        revision.current = res.sceneRevision;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          // Another tab or the agent's editor saved since this one loaded. Working on in this stale copy would drop
          // every later change (the user's and the agent's) without a word: load the saved scene instead.
          const latest = await api.project(id).catch(() => null);
          if (latest?.scene && engineHost.ready) {
            revision.current = latest.sceneRevision;
            engineHost.loadScene(JSON.stringify(latest.scene));
            agentBridge.sceneChanged();
          }
          logActivity(ActivitySource.System, "The scene changed somewhere else: loaded the saved version");
        }
      }
    };
    const off = engineHost.onSceneChange(() => {
      clearTimeout(timer);
      flush.current = () => {
        clearTimeout(timer);
        flush.current = null;
        return (saving.current = saving.current.then(save));
      };
      timer = setTimeout(() => void flush.current?.(), SAVE_DEBOUNCE_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
      flush.current = null;
    };
  }, [id]);

  /** Save now if a change is waiting, then report the revision the server holds (what a render shows). */
  const flushScene = async () => {
    await (flush.current?.() ?? saving.current);
    return revision.current;
  };

  const rename = async (name: string) => {
    if (!project || name === project.name) return;
    setProject(await api.updateProject(id, { name }));
  };
  const changeFormat = async (format: VideoFormat) => {
    if (!project || format === project.format) return;
    const p = await api.updateProject(id, { format });
    setProject(p);
    engineHost.setBuildOps(buildToOps(p.build, byKey, p.format, prefabs.current));
    agentBridge.sceneChanged();
    logActivity(ActivitySource.User, `Format: ${format}`);
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

  const ed: EditorProps = {
    id,
    project,
    error,
    canvas,
    g: generation,
    captioning,
    flushScene,
    mode,
    setMode,
    rename: (name) => void rename(name),
    changeFormat: (f) => void changeFormat(f),
    saveBrief: (b) => void saveBrief(b),
    saveReferences: (references) => void api.updateProject(id, { references }).then(setProject),
    setProject,
  };
  return (
    <>
      {mode === EditorMode.Pro ? <ProEditor ed={ed} /> : mode === EditorMode.Edit ? <EditEditor ed={ed} /> : <SimpleEditor ed={ed} />}
      <OpenElsewhere />
    </>
  );
}
