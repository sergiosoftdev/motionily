import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { DEFAULT_TARGET_LUFS, GRADE_NEUTRAL, LOOKS, OpName, PEAK_CEILING_DB, SideFile, normalization, type ScopeStats, OutputCodec, OUTPUT_SHORT_SIDES, effectsWithGrade, effectsWithGradeOf, EXPORT_PRESETS, limitedNormalization, SPEED_RAMPS, speedRampKeys, type RampPoint, type Mix, type FootageClip, type Grade, type MediaItem, type Op, type Project } from "@motionily/protocol";
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

const rgb = (v: [number, number, number] | null) => (v ? v.join(" ") : "-");

/** One line per measured frame, then what the columns mean. */
export function scopeLines(rows: ScopeStats[]): string {
  if (!rows.length) return "Nothing to measure (the video is empty).";
  const lines = rows.map(
    (s) =>
      `t=${s.t} | luma p1 ${s.luma.p1} p5 ${s.luma.p5} p50 ${s.luma.p50} p95 ${s.luma.p95} p99 ${s.luma.p99} | crushed ${s.clipped.black} clipped ${s.clipped.white} | rgb ${rgb(s.rgb)} | shadows ${rgb(s.shadows)} | mids ${rgb(s.midtones)} | highs ${rgb(s.highlights)} | sat ${s.saturation.mean} (p95 ${s.saturation.p95}) | cast ${s.cast.hue} ${s.cast.strength}`,
  );
  return `Scopes (values 0..1, Rec.709 luma; band rgb = mean r g b):\n${lines.join("\n")}`;
}

const lookNames = LOOKS.map((l) => l.name) as [string, ...string[]];

export function registerStudioTools(server: Server, d: StudioDeps) {
  server.registerTool(
    "list_media",
    {
      description:
        "The video's media pool, as the user sees it in Edit mode: their clips (ids c1…, use them in video layers or edit_footage) and the sounds, pictures and LUTs they imported (ids m1…). `src` is what a layer's src takes.",
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
        "Bring a file into the media pool from an http(s) URL (or, in the desktop app, an absolute path on this machine): sounds (mp3, wav, m4a, ogg, flac), pictures (png, jpg, webp, gif) and LUTs (.cube, for the color effect's `lut`) join the pool, videos (mp4, mov, webm) become the user's clips. Returns its id and src; then place it with add_layers (`id audio START-END src=… volume=1`, an image layer, or a video layer), or grade with a LUT: a patch of the clip's color effect with `\"lut\":src`.",
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
    "clean_audio",
    {
      description:
        "Clean a sound, non-destructively, with ffmpeg: `mode` denoise (FFT noise reduction, `strength` 0..1 = 6..36 dB, default 0.5: steady hiss, hum, fans) or voice (RNNoise speech isolation: keeps the voice, drops everything else; `strength` below 1 mixes the original back in). `source` is a sound (src from list_media), a clip's src (its sound), or `voice` for the voice-over. A sound or clip gives a new pool sound (WAV) to place (`id audio START-END src=… volume=1` at the clip's start/in/out, and the clip's own volume to 0); the voice-over is replaced in place (same length: timing, words and cuts stay) and its original joins the pool.",
      inputSchema: { source: z.string().min(1).max(200), mode: z.enum(["denoise", "voice"]), strength: z.number().min(0).max(1).optional() },
    },
    d.guard(async ({ source, mode, strength }: { source: string; mode: "denoise" | "voice"; strength?: number }) => {
      const r = await d.api().route<MediaItem | { voice: string; original: MediaItem }>("POST", "/media/clean", { source, mode, strength });
      if ("voice" in r) return d.text(`The voice-over is now ${r.voice} (${mode === "voice" ? "voice isolated" : "denoised"}); the original is ${r.original.id} (src=${r.original.url}) in the pool.`);
      return d.text(`Cleaned into ${r.id}: src=${r.url}${r.duration != null ? `, ${r.duration.toFixed(2)} s` : ""}. Place it where the original plays.`);
    }),
  );

  server.registerTool(
    "speed_ramp",
    {
      description: `Ramp a video clip's speed like the clip inspector's Speed ramp: its \`time\` remap is written so the speed eases (smoothstep) between points and the clip keeps its length on the timeline. \`ramp\` names one (${SPEED_RAMPS.map((r) => r.name).join("; ")}) or \`points\` gives your own: [{at: 0..1 of the clip, speed: × its speed}], e.g. [{"at":0,"speed":1},{"at":0.5,"speed":0.3},{"at":1,"speed":1}]. \`ramp: "none"\` removes it. Past the file's end the last frame holds.`,
      inputSchema: { id: z.string().min(1), ramp: z.string().optional(), points: z.array(z.object({ at: z.number().min(0).max(1), speed: z.number().min(0.05).max(16) })).min(1).max(12).optional() },
    },
    d.guard(async ({ id, ramp, points }: { id: string; ramp?: string; points?: RampPoint[] }) => {
      const bridge = d.bridge();
      const scene = JSON.parse(await bridge.freshScene()) as { layers?: { id: string; type: string; start?: number; end?: number | null; in?: number; speed?: number }[]; duration: number };
      const layer = scene.layers?.find((l) => l.id === id);
      if (!layer || layer.type !== "video") throw new Error(`${id} is not a video clip`);
      if (ramp === "none") {
        const res = await bridge.applyOps([{ op: OpName.Patch, id, fields: { time: null } }]);
        if (!res.ok) throw new Error(res.error ?? "it did not apply");
        return d.text(`No speed ramp on ${id}.`);
      }
      const chosen = points ?? SPEED_RAMPS.find((r) => r.name.toLowerCase() === (ramp ?? "").toLowerCase())?.points;
      if (!chosen) throw new Error(`name a ramp (${SPEED_RAMPS.map((r) => r.name).join("; ")}) or give points`);
      const length = (layer.end ?? scene.duration) - (layer.start ?? 0);
      const { keys, plays } = speedRampKeys(length, chosen);
      const res = await bridge.applyOps([{ op: OpName.Patch, id, fields: { time: keys } }]);
      if (!res.ok) throw new Error(res.error ?? "the ramp did not apply");
      return d.text(`Ramped ${id}: its ${length.toFixed(2)} s play ${(plays * (layer.speed ?? 1)).toFixed(2)} s of the file from ${(layer.in ?? 0).toFixed(2)} s.`);
    }),
  );

  server.registerTool(
    "stabilize_clip",
    {
      description:
        "Stabilize a shaky video clip (ffmpeg vid.stab, two passes: the motion measured, the camera path smoothed, the borders filled by a slight zoom; deshake where vid.stab is missing). `strength` 0..1 (default 0.5 ≈ a 1 s smoothing window; 1 = a locked-off look). The stabilized copy becomes a new clip with the same timing, sound and transcript, and the layer `id` switches to it (the original stays in the pool).",
      inputSchema: { id: z.string().min(1), strength: z.number().min(0).max(1).optional() },
    },
    d.guard(async ({ id, strength }: { id: string; strength?: number }) => {
      const bridge = d.bridge();
      const scene = JSON.parse(await bridge.freshScene()) as { layers?: { id: string; type: string; src?: string }[] };
      const layer = scene.layers?.find((l) => l.id === id);
      if (!layer || layer.type !== "video" || !layer.src) throw new Error(`${id} is not a video clip`);
      const r = await d.api().route<{ footage: string; url: string; method: string }>("POST", "/media/stabilize", { source: layer.src, strength });
      const res = await bridge.applyOps([{ op: OpName.Patch, id, fields: { src: r.url } }]);
      if (!res.ok) throw new Error(res.error ?? "the clip did not switch to the stabilized copy");
      return d.text(`Stabilized ${id} (${r.method}): it now plays clip ${r.footage} (src=${r.url}).`);
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
    "queue_export",
    {
      description: `Render several versions one after the other, like Export › Queue: presets ${EXPORT_PRESETS.map((p) => `"${p.name}" (${p.output.short_side} short side, ${p.output.codec}${p.desktop ? ", desktop app" : ""})`).join(", ")}, each in the video's own format and export range. Answers when all are done, with each file's path (desktop app) or URL. Long videos take minutes per preset.`,
      inputSchema: { presets: z.array(z.string().min(1)).min(1).max(EXPORT_PRESETS.length) },
    },
    d.guard(async ({ presets }: { presets: string[] }) => {
      const res = await d.bridge().queueExport(presets);
      if (!res.ok) throw new Error(res.error ?? "the exports failed");
      return d.text(res.text ?? "Exported.");
    }),
  );

  server.registerTool(
    "export_file",
    {
      description:
        "Export the video's subtitles or its Edit timeline for another editor, like the Export dialog's extra files: srt / vtt (captions cue by cue as on screen; the export range applies), fcpxml (Final Cut Pro, DaVinci Resolve, Premiere), otio (OpenTimelineIO) or edl (CMX3600: V1, A1, A2). Timelines carry every clip, picture clip, audio layer, the music and the voice-over with their track, position and file in/out (graphics and speed changes stay in Motionily). The desktop app saves it next to the exports and you get the path; `path` (absolute) writes it there too; otherwise you get the text.",
      inputSchema: { kind: z.enum(Object.values(SideFile) as [SideFile, ...SideFile[]]), path: z.string().min(1).optional() },
    },
    d.guard(async ({ kind, path }: { kind: SideFile; path?: string }) => {
      const res = await d.bridge().sideFile(kind);
      if (!res.ok || res.text == null) throw new Error(res.error ?? "the editor did not write it");
      if (path) {
        await writeFile(path, res.text, "utf8");
        return d.text(`Wrote ${path} (${res.text.length} characters).`);
      }
      if (res.file) return d.text(`Saved to ${res.file}.`);
      return d.text(res.text);
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
    "color_scopes",
    {
      description:
        "Read the color scopes of the rendered video (grade included) as numbers, like a colorist reads the waveform, parade, vectorscope and histogram in the Color tab. Without times it measures the middle of every clip. Per frame: luma percentiles, crushed/clipped share, mean RGB overall and in shadows/midtones/highlights, saturation, and the midtones' color cast. Use it before and after grading, and to match clips (docs: Color correction).",
      inputSchema: { times: z.array(z.number().min(0)).max(8).optional() },
    },
    d.guard(async ({ times }: { times?: number[] }) => {
      const res = await d.bridge().scopes(times);
      if (!res.ok) throw new Error(res.error ?? "the editor did not measure the frames");
      return d.text(scopeLines(res.scopes ?? []));
    }),
  );

  server.registerTool(
    "track_window",
    {
      description:
        "Make a color window follow the picture, like the Color tab's Track button: from second `at` (default the playhead) forward and back across its clip, the detail under the window's center is followed frame by frame and the window's x / y are keyed on it (15 keys a second, linear). Put the window on the subject at `at` first (a patch of its x / y). Windows are adjustment shapes attached to a clip (docs: Color correction › Windows).",
      inputSchema: { id: z.string().min(1), at: z.number().min(0).optional() },
    },
    d.guard(async ({ id, at }: { id: string; at?: number }) => {
      const res = await d.bridge().trackWindow(id, at);
      if (!res.ok) throw new Error(res.error ?? "the editor did not track it");
      return d.text(res.text ?? "Tracked.");
    }),
  );

  server.registerTool(
    "sync_audio",
    {
      description:
        "Line a separately recorded sound (an audio layer: a lav, a recorder) up with a video clip by their waveforms, like Resolve's auto sync: both are cross-correlated within 30 s of where they sit now and refined to the sample. The sound then plays the matching moment under the clip (its start, in and end follow the clip) and the clip's own sound is muted. Answers with the offset and how clear the match is. Both clips at normal speed.",
      inputSchema: { video: z.string().min(1), audio: z.string().min(1) },
    },
    d.guard(async ({ video, audio }: { video: string; audio: string }) => {
      const res = await d.bridge().syncAudio(video, audio);
      if (!res.ok) throw new Error(res.error ?? "the editor did not sync them");
      return d.text(res.text ?? "Synced.");
    }),
  );

  server.registerTool(
    "match_color",
    {
      description:
        "Match clips' color to another clip, like the Color tab's Match: the middle frame of each clip in `to` is brought to the middle frame of `from` (each clip measured alone, inside its box) by transferring the mean and spread of every channel, written as its color effect's `gain` and `offset` wheels and corrected on the real render 3 times. Answers with the ΔE (CIELAB) of the mean color before → after (under 2 reads as the same). Refine with color_scopes and a patch of the color effect.",
      inputSchema: { from: z.string().min(1), to: z.array(z.string().min(1)).min(1) },
    },
    d.guard(async ({ from, to }: { from: string; to: string[] }) => {
      const res = await d.bridge().matchColor(from, to);
      if (!res.ok) throw new Error(res.error ?? "the editor did not match them");
      return d.text(res.text ?? "Matched.");
    }),
  );

  server.registerTool(
    "copy_grade",
    {
      description:
        "Copy a clip's whole grade onto other clips, like the Color tab's Copy grade / Paste grade (⌥⌘C / ⌥⌘V): every color effect of `from` (sliders, wheels, curves, LUT) replaces the color effects of each clip in `to`; their other effects stay.",
      inputSchema: { from: z.string().min(1), to: z.array(z.string().min(1)).min(1) },
    },
    d.guard(async ({ from, to }: { from: string; to: string[] }) => {
      const bridge = d.bridge();
      const scene = JSON.parse(await bridge.freshScene()) as { layers?: { id: string; effects?: unknown[] }[] };
      const layers = scene.layers ?? [];
      const source = layers.find((l) => l.id === from);
      if (!source) throw new Error(`no layer ${from}`);
      const missing = to.filter((id) => !layers.some((l) => l.id === id));
      if (missing.length) throw new Error(`no layer ${missing.join(", ")}`);
      const ops: Op[] = to.map((id) => ({ op: OpName.Patch, id, fields: { effects: effectsWithGradeOf(layers.find((l) => l.id === id)!.effects, source.effects) } }));
      const res = await bridge.applyOps(ops);
      if (!res.ok) throw new Error(res.error ?? "the grade did not apply");
      return d.text(`Grade of ${from} on ${to.join(", ")}.`);
    }),
  );

  server.registerTool(
    "normalize_loudness",
    {
      description: `Measure the whole mix as it exports (voice, music, effects, clips; ITU-R BS.1770 integrated loudness and sample peak, master at 0 dB) and set the master level (set_mix) so it lands on \`target_lufs\` (default ${DEFAULT_TARGET_LUFS}: Reels, TikTok, YouTube; -16 podcasts; -23 broadcast) with peaks under ${PEAK_CEILING_DB} dBFS (with a master limiter, \`master_fx\` in set_mix, it measures through it and reaches the target). \`apply=false\` only measures. Run it last, after the sound is final.`,
      inputSchema: { target_lufs: z.number().min(-40).max(-5).optional(), apply: z.boolean().optional() },
    },
    d.guard(async ({ target_lufs, apply }: { target_lufs?: number; apply?: boolean }) => {
      const bridge = d.bridge();
      const res = await bridge.loudness();
      if (!res.ok) throw new Error(res.error ?? "the editor did not measure the mix");
      if (!res.loudness) return d.text("The mix is silent: nothing to normalize.");
      const target = target_lufs ?? DEFAULT_TARGET_LUFS;
      const mix = (JSON.parse(await bridge.freshScene()) as { mix?: Mix | null }).mix ?? null;
      // A master limiter holds the peaks: measure through it at the level being tried until it lands.
      const n = mix?.master_fx?.limiter
        ? await limitedNormalization(res.loudness, target, async (db) => {
            const at = await bridge.loudness(db);
            if (!at.ok) throw new Error(at.error ?? "the editor did not measure the mix");
            return at.loudness ?? null;
          })
        : normalization(res.loudness, target);
      const measured = `Mix at 0 dB: ${n.lufs.toFixed(1)} LUFS, peak ${n.peakDb.toFixed(1)} dBFS.`;
      if (apply === false) return d.text(`${measured} Reaching ${target} LUFS needs a master of ${n.masterDb} dB${n.peakLimited ? " (held by the peak ceiling)" : ""}.`);
      // The mixer's channels and the master effects stay as they are.
      const done = await bridge.applyOps([{ op: OpName.SetMix, mix: { ...mix, master_db: n.masterDb, target_lufs: target } }]);
      if (!done.ok) throw new Error(done.error ?? "the master level did not apply");
      return d.text(
        `${measured} Master set to ${n.masterDb} dB: the export plays at ${n.lufsAfter.toFixed(1)} LUFS${n.peakAfter != null ? `, peak ${n.peakAfter.toFixed(1)} dBFS through the master limiter` : ""}${n.peakLimited ? `; peaks held it under ${target} LUFS (add a master limiter, {"master_fx":{"limiter":{}}} in set_mix, or lower the loudest parts, then run it again)` : ""}.`,
      );
    }),
  );

  server.registerTool(
    "apply_look",
    {
      description: `Grade clips with one of the editor's looks (the same values as the Color tab): ${LOOKS.map((l) => l.name).join(", ")}. Without ids it grades every video clip and picture clip. It sets the grade's sliders on each layer's color effect (its wheels, curves and other effects stay); refine with a patch of the color effect after (docs: Color correction).`,
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
