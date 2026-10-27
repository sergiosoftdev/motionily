import { BRIDGE_PATH, BridgeClose, EXPORT_PRESETS, SIDE_FILE_LABEL, BridgeRole, HEADLESS_PARAM, EditorMessageType, ServerMessageType, type EditorMessage, type ServerMessage, type Output, type SideFile } from "@motionily/protocol";
import { API_URL, api, mediaUrl } from "./api/client";
import { presetViolation, scenePresetViolation } from "./agentRules";
import { engineHost } from "./engine/host";
import { scopeStats } from "./editor/edit/colorScopes";
import { trackWindow } from "./editor/edit/windowTrack";
import { matchColor } from "./editor/edit/colorMatch";
import { syncAudioOps, syncClipsOf } from "./editor/edit/audioSync";
import { decodeAudio } from "./audio/decode";
import { placeImport, prepareImport } from "./editor/edit/importTimelineFile";
import type { SceneView } from "./editor/sceneView";
import { JobStatus, enqueue } from "./export/queue";
import { desktop } from "./desktop";
import { useSession } from "./session";
import { ActivitySource, logActivity, useEditor } from "./store";

/** Frames the agent asks to see: small by default (cheap), up to this width for detail checks. */
const MIN_FRAME_WIDTH = 360;
const MAX_FRAME_WIDTH = 1280;
/** Instants per layout request (it is cheap: numbers, no rendering). */
const MAX_LAYOUT_TIMES = 12;
/** Instants per scopes request, and the frame width they are measured at. */
const MAX_SCOPE_TIMES = 8;
const SCOPE_WIDTH = 320;

const RECONNECT_MS = 2000;

/**
 * Editor side of the agent link, through the API hub. Agents send ops here; the
 * Rust engine validates and applies them and we answer with the new summary.
 */
class AgentBridge {
  private ws: WebSocket | null = null;
  private projectId: string | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  /** Called when the agent changes project settings, so the editor reloads them. */
  onProjectChanged: (() => void) | null = null;
  /** The editor screen exports for an agent (it knows the project's name and audio). */
  onExport: ((output: Partial<Output> | undefined) => Promise<{ file?: string; url?: string }>) | null = null;
  /** Writes a subtitle or timeline file (set by the open editor): its text, and where the desktop app saved it. */
  onSideFile: ((kind: SideFile) => Promise<{ text: string; file?: string }>) | null = null;

  /** Connect for the project open in the editor (`null` disconnects). */
  setProject(id: string | null) {
    if (id === this.projectId) return;
    this.projectId = id;
    clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
    useEditor.setState({ agentConnected: false, openElsewhere: false });
    if (id) this.connect();
  }

  private connect() {
    const token = useSession.getState().token;
    const projectId = this.projectId;
    if (!token || !projectId) return;
    const url = new URL(BRIDGE_PATH, API_URL.replace(/^http/, "ws"));
    url.search = new URLSearchParams({ role: BridgeRole.Editor, project: projectId, token }).toString();
    // The agent's invisible editor never kicks out a real one.
    if (new URLSearchParams(location.search).has(HEADLESS_PARAM)) url.searchParams.set(HEADLESS_PARAM, "1");
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => this.hello();
    ws.onmessage = (e) => this.handle(JSON.parse(e.data) as ServerMessage);
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      if (useEditor.getState().agentConnected) logActivity(ActivitySource.System, "Agent disconnected");
      this.ws = null;
      // Another tab took the video: reconnecting would steal it back, and the two would take turns forever.
      if (e.code === BridgeClose.OpenedElsewhere) return useEditor.setState({ agentConnected: false, openElsewhere: true });
      useEditor.setState({ agentConnected: false });
      this.retry = setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }

  /** User changed something by hand: keep the agent's summary in sync. */
  sceneChanged() {
    if (!this.projectId || !engineHost.ready) return;
    this.send({ type: EditorMessageType.SceneChanged, projectId: this.projectId, scene: engineHost.sceneJson(), summary: engineHost.summary() });
  }

  private hello() {
    if (!this.projectId || !engineHost.ready) return;
    this.send({ type: EditorMessageType.Hello, projectId: this.projectId, scene: engineHost.sceneJson(), summary: engineHost.summary() });
  }

  private handle(msg: ServerMessage) {
    switch (msg.type) {
      case ServerMessageType.Attached:
        if (!useEditor.getState().agentConnected) logActivity(ActivitySource.System, "Agent connected");
        useEditor.setState({ agentConnected: true });
        // A new agent must start from what is on screen right now, not a cached copy.
        this.hello();
        return;
      case ServerMessageType.Detached:
        if (useEditor.getState().agentConnected) logActivity(ActivitySource.System, "Agent disconnected");
        useEditor.setState({ agentConnected: false });
        return;
      case ServerMessageType.ProjectChanged:
        logActivity(ActivitySource.Agent, "Changes the video options");
        this.onProjectChanged?.();
        return;
      case ServerMessageType.Review: {
        // Async: video frames are decoded exactly for every sampled instant.
        void engineHost.review(msg.frames).then((review) => {
          logActivity(ActivitySource.Agent, `Reviews the video (${review.issues.length} warnings)`);
          this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, review });
        }, (e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: String(e) }));
        return;
      }
      case ServerMessageType.Export: {
        const run = this.onExport;
        if (!run) {
          this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: "This editor cannot export right now (open the video in the editor)." });
          return;
        }
        logActivity(ActivitySource.Agent, "Exports the video");
        void run(msg.output).then(
          (r) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, ...r }),
          (e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
        return;
      }
      case ServerMessageType.Scopes: {
        // Default: the middle of every clip (what a colorist checks shot by shot), else the playhead.
        const times = (msg.times?.length ? msg.times : engineHost.clipMidpoints()).slice(0, MAX_SCOPE_TIMES);
        void engineHost.framePixels(times.length ? times : null, SCOPE_WIDTH).then((frames) => {
          logActivity(ActivitySource.Agent, `Reads the color scopes (${frames.length} ${frames.length === 1 ? "frame" : "frames"})`);
          this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, scopes: frames.map((f) => scopeStats(f.image, f.t)) });
        }, (e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: String(e) }));
        return;
      }
      case ServerMessageType.SideFile: {
        const run = this.onSideFile;
        if (!run) {
          this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: "This editor cannot write files right now (open the video in the editor)." });
          return;
        }
        void run(msg.kind).then(
          (r) => {
            logActivity(ActivitySource.Agent, `Exports ${SIDE_FILE_LABEL[msg.kind]}`);
            this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, ...r });
          },
          (e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
        return;
      }
      case ServerMessageType.TrackWindow: {
        void trackWindow(msg.id, msg.at ?? useEditor.getState().time).then(
          (r) => {
            engineHost.applyOps(r.ops);
            logActivity(ActivitySource.Agent, `Tracks ${msg.id}`);
            const text = `Tracked ${msg.id}: ${r.samples} points from ${r.from.toFixed(2)} to ${r.to.toFixed(2)} s, keyed on x and y${r.lost ? " (the detail was lost at the ends of that range: move the window there and track again)" : ""}.`;
            this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, text, scene: engineHost.sceneJson(), summary: engineHost.summary() });
          },
          (e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
        return;
      }
      case ServerMessageType.QueueExport: {
        const unknown = msg.presets.filter((n) => !EXPORT_PRESETS.some((p) => p.name.toLowerCase() === n.toLowerCase()));
        const usable = EXPORT_PRESETS.filter((p) => msg.presets.some((n) => n.toLowerCase() === p.name.toLowerCase()) && (desktop || !p.desktop));
        if (unknown.length || !usable.length) {
          this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: unknown.length ? `unknown presets: ${unknown.join(", ")} (${EXPORT_PRESETS.map((p) => p.name).join("; ")})` : "those presets need the desktop app" });
          return;
        }
        logActivity(ActivitySource.Agent, `Queues ${usable.map((p) => p.name).join(", ")}`);
        // The video's own range setting applies to every preset.
        const range = (JSON.parse(engineHost.sceneJson()) as { output?: { range?: [number, number] } }).output?.range;
        void enqueue(usable.map((p) => ({ label: p.name, output: { ...p.output, ...(range ? { range } : {}) } }))).then((jobs) => {
          const lines = jobs.map((j) => `${j.label}: ${j.status === JobStatus.Done ? (j.file ?? j.url) : j.status === JobStatus.Failed ? `failed (${j.error})` : j.status}`);
          this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: jobs.some((j) => j.status === JobStatus.Done), text: lines.join("\n"), error: jobs.every((j) => j.status !== JobStatus.Done) ? lines.join("; ") : undefined });
        });
        return;
      }
      case ServerMessageType.SyncAudio: {
        void (async () => {
          const [video, audio] = syncClipsOf(JSON.parse(engineHost.sceneJson()), msg.video, msg.audio);
          return syncAudioOps(video, audio, (src, isVideo) => decodeAudio(mediaUrl(src), isVideo));
        })().then(
          ({ ops, match }) => {
            engineHost.applyOps(ops);
            logActivity(ActivitySource.Agent, `Syncs ${msg.audio} to ${msg.video}`);
            const doubt = match.score < 0.5 || match.margin < 1.15 ? " The match is weak: check it by ear (they may not share a moment within 30 s of where they were)." : "";
            const text = `Synced ${msg.audio} to ${msg.video}: offset ${match.offset.toFixed(3)} s (correlation ${match.score.toFixed(2)}, ${Number.isFinite(match.margin) ? `${match.margin.toFixed(2)}× the next best` : "no other candidate"}); ${msg.audio} now plays under the clip and ${msg.video}'s own sound is muted.${doubt}`;
            this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, text, scene: engineHost.sceneJson(), summary: engineHost.summary() });
          },
          (e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
        return;
      }
      case ServerMessageType.ImportTimeline: {
        void (async () => {
          const load = () => Promise.all([api.project(msg.projectId), api.projectMedia(msg.projectId)]);
          let [project, media] = await load();
          const pending = await prepareImport(msg.text, project, media);
          if (pending.brought) {
            [project, media] = await load();
            this.onProjectChanged?.();
          }
          const r = placeImport(pending, JSON.parse(engineHost.sceneJson()) as SceneView, project, media);
          if (!r.placed) throw new Error(r.text);
          engineHost.applyOps(r.ops);
          logActivity(ActivitySource.Agent, `Imports the timeline ${pending.t.name}`);
          return r.text;
        })().then(
          (text) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, text, scene: engineHost.sceneJson(), summary: engineHost.summary() }),
          (e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
        return;
      }
      case ServerMessageType.MatchColor: {
        void matchColor(msg.from, msg.to).then(
          (r) => {
            engineHost.applyOps(r.ops);
            logActivity(ActivitySource.Agent, `Matches ${msg.to.join(", ")} to ${msg.from}`);
            const text = `Matched (ΔE of the mean color, CIELAB; under 2 is hard to tell apart): ${r.lines.join("; ")}. Their color effect's gain and offset were set.`;
            this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, text, scene: engineHost.sceneJson(), summary: engineHost.summary() });
          },
          (e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
        return;
      }
      case ServerMessageType.Loudness: {
        void engineHost.mixLoudness(msg.masterDb).then((loudness) => {
          logActivity(ActivitySource.Agent, "Measures the loudness of the mix");
          // JSON has no -Infinity: silence goes as null.
          this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, loudness: loudness && Number.isFinite(loudness.lufs) ? loudness : null });
        }, (e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: String(e) }));
        return;
      }
      case ServerMessageType.Layout: {
        const layouts = engineHost.layout(msg.times.slice(0, MAX_LAYOUT_TIMES));
        this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, layouts });
        return;
      }
      case ServerMessageType.RenderFrames: {
        const width = Math.min(MAX_FRAME_WIDTH, Math.max(MIN_FRAME_WIDTH, msg.width ?? MIN_FRAME_WIDTH));
        void engineHost.snapshots(msg.times.slice(0, 6), width).then((images) => {
          logActivity(ActivitySource.Agent, `Looks at ${images.length} ${images.length === 1 ? "frame" : "frames"}`);
          this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, images });
        }, (e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: String(e) }));
        return;
      }
    }
    try {
      switch (msg.type) {
        case ServerMessageType.ApplyOps:
          // The project's format owns the frame size; agents change it with set_format.
          {
            const why = presetViolation(msg.ops);
            if (why) throw new Error(why);
          }
          engineHost.applyOps(msg.ops);
          // An empty batch is an agent asking for the current scene: nothing to log.
          if (msg.ops.length) logActivity(ActivitySource.Agent, describeOps(msg.ops.map((o) => o.op)));
          break;
        case ServerMessageType.LoadScene: {
          const why = scenePresetViolation(JSON.parse(msg.scene) as Record<string, unknown>);
          if (why) throw new Error(why);
          engineHost.loadScene(msg.scene);
          logActivity(ActivitySource.Agent, "New scene");
          break;
        }
      }
      this.send({
        type: EditorMessageType.Result,
        requestId: msg.requestId,
        ok: true,
        scene: engineHost.sceneJson(),
        summary: engineHost.summary(),
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logActivity(ActivitySource.System, `Agent change rejected: ${error}`);
      this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error });
    }
  }

  private send(msg: EditorMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

function describeOps(names: string[]): string {
  const counts = new Map<string, number>();
  names.forEach((n) => counts.set(n, (counts.get(n) ?? 0) + 1));
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
}

export const agentBridge = new AgentBridge();
// A hot update (development) builds a fresh bridge: close this one's socket first, or the hub sees two editors in one
// tab and the stale one shows "open in another tab".
import.meta.hot?.dispose(() => agentBridge.setProject(null));
