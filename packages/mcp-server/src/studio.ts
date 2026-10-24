import { z } from "zod";
import { GRADE_NEUTRAL, LOOKS, OpName, OutputCodec, OUTPUT_SHORT_SIDES, effectsWithGrade, type FootageClip, type Grade, type MediaItem, type Op, type Project } from "@motionily/protocol";
import type { ProjectApi } from "./api.js";
import type { EditorBridge } from "./bridge.js";

/**
 * The editor-pro tools: what a person does in Edit mode's media pool, Project settings, Export and
 * Color tab, so an agent can do the same (docs/plans/resolve-parity.md, phase 0).
 */

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
type Server = { registerTool: (name: string, config: { description: string; inputSchema: z.ZodRawShape }, cb: (args: never) => Promise<Text>) => unknown };

export type StudioDeps = {
  api: () => ProjectApi;
  bridge: () => EditorBridge;
  guard: <A>(fn: (args: A) => Promise<Text>) => (args: A) => Promise<Text>;
  text: (t: string) => Text;
  /** The account agent opens the video a folder became (null for project tokens). */
  openVideo: ((id: string) => Promise<Project>) | null;
  /** Account calls for open_project_folder (null for project tokens). */
  accountCall: (<T>(method: string, path: string, body?: unknown) => Promise<T>) | null;
};

/** Video clips the agent may lay on the timeline (footage) and the pool's sounds and pictures. */
export function mediaLines(project: Pick<Project, "footage">, media: MediaItem[], scene?: string | null): string {
  const used = (url: string) => (scene?.includes(url) ? " | in the edit" : "");
  const clips = (project.footage ?? []).map((c: FootageClip) => `${c.id} | video | ${c.url} | ${c.name} | ${c.duration?.toFixed(2) ?? "?"} s | ${c.width ?? "?"}x${c.height ?? "?"}${used(c.url)}`);
  const items = media.map((m) => `${m.id} | ${m.kind} | ${m.url} | ${m.name} | ${m.duration != null ? `${m.duration.toFixed(2)} s` : "-"} | ${m.width ? `${m.width}x${m.height}` : "-"}${used(m.url)}`);
  const rows = [...clips, ...items];
  return rows.length ? `Media pool (id | kind | src | name | length | size):\n${rows.join("\n")}` : "Media pool: empty (import_media brings files in).";
}

const lookNames = LOOKS.map((l) => l.name) as [string, ...string[]];

export function registerStudioTools(server: Server, d: StudioDeps) {
  server.registerTool(
    "list_media",
    {
      description:
        "The video's media pool, as the user sees it in Edit mode: their clips (ids c1…, use them in video layers or edit_footage) and the sounds and pictures they imported (ids m1…). `src` is what a layer's src takes.",
      inputSchema: {},
    },
    d.guard(async () => {
      const api = d.api();
      const [project, media] = await Promise.all([api.project(), api.route<MediaItem[]>("GET", "/media")]);
      return d.text(mediaLines(project, media, d.bridge().currentScene));
    }),
  );

  server.registerTool(
    "import_media",
    {
      description:
        "Bring a file into the media pool from an http(s) URL (or, in the desktop app, an absolute path on this machine): sounds (mp3, wav, m4a, ogg, flac) and pictures (png, jpg, webp, gif) join the pool, videos (mp4, mov, webm) become the user's clips. Returns its id and src; then place it with add_layers (`id audio START-END src=… volume=1`, an image layer, or a video layer).",
      inputSchema: { source: z.string().min(1), name: z.string().max(200).optional() },
    },
    d.guard(async ({ source, name }: { source: string; name?: string }) => {
      const r = await d.api().route<MediaItem | { footage: string }>("POST", "/media/import", { source, name });
      if ("footage" in r) {
        const clip = (await d.api().project()).footage.find((c) => c.id === r.footage);
        return d.text(`Imported as clip ${r.footage}: src=${clip?.url} (${clip?.duration?.toFixed(2) ?? "?"} s, ${clip?.width}x${clip?.height}). The editor transcribes it when it opens it.`);
      }
      return d.text(`Imported ${r.id} (${r.kind}): src=${r.url}${r.duration != null ? `, ${r.duration.toFixed(2)} s` : ""}${r.width ? `, ${r.width}x${r.height}` : ""}.`);
    }),
  );

  server.registerTool(
    "remove_media",
    {
      description: "Take a sound or picture (m1…) out of the media pool. Layers that still use it keep working until you remove them.",
      inputSchema: { id: z.string().regex(/^m\d+$/) },
    },
    d.guard(async ({ id }: { id: string }) => {
      await d.api().route("DELETE", `/media/${id}`);
      return d.text(`Removed ${id} from the media pool.`);
    }),
  );

  server.registerTool(
    "export_video",
    {
      description:
        "Render the finished video, as the user's Export button does, with the scene's output settings (set_output) or these overrides. In the desktop app it is written to disk (up to 8K, H.264, HEVC, ProRes, ProRes 4444 / VP9 with transparency) and you get the path; in the browser editor (1080p H.264 at most) you get a URL. Needs the editor (the user's or the headless one). Long videos take minutes.",
      inputSchema: {
        short_side: z.number().int().refine((v) => (OUTPUT_SHORT_SIDES as readonly number[]).includes(v), "720, 1080, 1440, 2160 or 4320").optional(),
        codec: z.enum(Object.values(OutputCodec) as [OutputCodec, ...OutputCodec[]]).optional(),
        range: z.tuple([z.number().min(0), z.number().positive()]).optional(),
      },
    },
    d.guard(async (o: { short_side?: number; codec?: OutputCodec; range?: [number, number] }) => {
      const res = await d.bridge().exportVideo(o);
      if (!res.ok) throw new Error(res.error ?? "the export failed");
      return d.text(res.file ? `Exported to ${res.file}` : `Exported: ${res.url}`);
    }),
  );

  server.registerTool(
    "save_project_folder",
    {
      description:
        "Desktop app: save this video as a folder (`<name>.motionily/` with project.json and every media file it uses) inside the absolute folder `path`, like File › Save Video as Folder…. Returns the folder.",
      inputSchema: { path: z.string().min(1) },
    },
    d.guard(async ({ path }: { path: string }) => {
      const r = await d.api().route<{ folder: string; media: number }>("POST", "/folder", { path });
      return d.text(`Saved to ${r.folder} (${r.media} media files).`);
    }),
  );

  if (d.accountCall && d.openVideo) {
    const call = d.accountCall;
    const open = d.openVideo;
    server.registerTool(
      "open_project_folder",
      {
        description: "Desktop app: open a `.motionily` project folder (absolute path) as a new video, like File › Open Project Folder…, and switch to it.",
        inputSchema: { path: z.string().min(1) },
      },
      d.guard(async ({ path }: { path: string }) => {
        const r = await call<{ id: string; name: string }>("POST", "/projects/import-folder", { path });
        await open(r.id);
        return d.text(`Opened "${r.name}" (${r.id}); every tool now works on it.`);
      }),
    );
  }

  server.registerTool(
    "list_versions",
    {
      description: "The video's version history (an automatic version every minute of editing, plus named snapshots), newest first: id, label, when, layers. restore_version brings one back.",
      inputSchema: {},
    },
    d.guard(async () => {
      const rows = await d.api().route<{ id: string; label: string; at: string; layers: number; duration: number }[]>("GET", "/versions");
      if (!rows.length) return d.text("No versions yet.");
      return d.text(`Versions (id | label | when | layers | length):\n${rows.slice(0, 40).map((v) => `${v.id} | ${v.label || "autosave"} | ${v.at} | ${v.layers} | ${v.duration} s`).join("\n")}`);
    }),
  );

  server.registerTool(
    "save_version",
    {
      description: "Keep the scene as it is now as a named version (before a risky change: a recut, a grade pass), like Save version in Project settings.",
      inputSchema: { label: z.string().max(120).optional() },
    },
    d.guard(async ({ label }: { label?: string }) => {
      const v = await d.api().route<{ id: string; label: string }>("POST", "/versions", { label });
      return d.text(`Saved version ${v.id} "${v.label}".`);
    }),
  );

  server.registerTool(
    "restore_version",
    {
      description: "Load a version from list_versions into the editor (the current scene is saved as a version first, so nothing is lost).",
      inputSchema: { id: z.string().regex(/^[a-f0-9]{24}$/) },
    },
    d.guard(async ({ id }: { id: string }) => {
      await d.api().route("POST", "/versions", { label: "Before restoring" });
      const v = await d.api().route<{ scene: Record<string, unknown>; label: string }>("GET", `/versions/${id}`);
      const res = await d.bridge().loadScene(JSON.stringify(v.scene));
      if (!res.ok) throw new Error(res.error ?? "the editor did not load it");
      return d.text(`Restored version ${id}${v.label ? ` "${v.label}"` : ""}.`);
    }),
  );

  server.registerTool(
    "apply_look",
    {
      description: `Grade clips with one of the editor's looks (the same values as the Color tab): ${LOOKS.map((l) => l.name).join(", ")}. Without ids it grades every video clip and picture clip. It replaces each layer's color effect (other effects stay); refine with a patch of the color effect after (docs: Color correction).`,
      inputSchema: { look: z.enum(lookNames), ids: z.array(z.string()).optional() },
    },
    d.guard(async ({ look, ids }: { look: string; ids?: string[] }) => {
      const preset = LOOKS.find((l) => l.name === look)!;
      const grade: Grade = { ...GRADE_NEUTRAL, ...preset.grade };
      const bridge = d.bridge();
      const scene = JSON.parse(await bridge.freshScene()) as { layers?: { id: string; type: string; group?: string; effects?: unknown[] }[] };
      const layers = (scene.layers ?? []).filter((l) => (ids ? ids.includes(l.id) : l.type === "video" || (l.type === "image" && l.group === "footage")));
      if (!layers.length) throw new Error(ids ? `none of ${ids.join(", ")} is in the scene` : "the video has no clips to grade");
      const ops: Op[] = layers.map((l) => ({ op: OpName.Patch, id: l.id, fields: { effects: effectsWithGrade(l.effects, grade) } }));
      const res = await bridge.applyOps(ops);
      if (!res.ok) throw new Error(res.error ?? "the look did not apply");
      return d.text(`Look "${look}" on ${layers.map((l) => l.id).join(", ")}.`);
    }),
  );
}
