import type { FootageClip } from "@motionily/protocol";
import { mediaUrl } from "../../api/client";
import { decodeAudio } from "../../audio/decode";
import { engineHost } from "../../engine/host";
import { resample, syncOffset } from "./audioSync";
import { angleName, createMulticamOps, freshGroup, multicamAt, multicamOf, switchAngleOps, type MulticamAngle, type MulticamClip } from "./multicam";
import { freshId } from "./tracks";

type SceneLayer = { id: string; type: string; src?: string; start?: number; end?: number | null; in?: number; out?: number | null; speed?: number; volume?: unknown; track?: string; multicam?: unknown };
type Scene = { layers: SceneLayer[]; duration: number; fps?: number };
type Op = { op: string; [k: string]: unknown };

/** How far apart (s) the cameras may have started rolling. */
const SYNC_REACH = 60;
const RATE = 8000;

const scene = () => JSON.parse(engineHost.sceneJson()) as Scene;

async function monoOf(src: string): Promise<Float32Array> {
  const b = await decodeAudio(mediaUrl(src), true);
  if (!b) throw new Error(`${src.split("/").pop()} has no sound to sync by`);
  return resample(b.getChannelData(0), b.sampleRate, RATE);
}

/**
 * Make clip `id` multicam with `angles` (other files, usually the other cameras' clips): each is lined up
 * with the clip's own file by their sound. Returns the ops and a line per angle on how sure the match is.
 */
export async function makeMulticam(id: string, angles: { src: string; name?: string }[], name?: string): Promise<{ ops: Op[]; lines: string[] }> {
  const s = scene();
  const l = s.layers.find((x) => x.id === id);
  if (!l || l.type !== "video" || !l.src) throw new Error(`${id} is not a video clip`);
  if (multicamOf(l, s.duration)) throw new Error(`${id} is already multicam`);
  if (Math.abs((l.speed ?? 1) - 1) > 1e-3) throw new Error("multicam works on clips at normal speed (set speed 1 first)");
  const others = angles.filter((a) => a.src !== l.src);
  if (!others.length) throw new Error("give at least one other camera's file");
  const ref = await monoOf(l.src);
  const synced: MulticamAngle[] = [];
  const lines: string[] = [];
  for (const a of others) {
    const m = syncOffset(ref, await monoOf(a.src), RATE, SYNC_REACH, 0);
    synced.push({ src: a.src, offset: m.offset, ...(a.name ? { name: a.name } : {}) });
    const sure = m.score >= 0.5 && m.margin >= 1.15;
    lines.push(`${a.name ?? a.src.split("/").pop()}: ${m.offset >= 0 ? "+" : ""}${m.offset.toFixed(3)} s (${sure ? "clear match" : "weak match: check it"})`);
  }
  const taken = new Set(s.layers.map((x) => x.id));
  const volume = typeof l.volume === "number" ? l.volume : 1;
  const ops = createMulticamOps(
    { id, src: l.src, start: l.start ?? 0, end: l.end ?? s.duration, in: l.in ?? 0, out: l.out ?? null, speed: 1, volume },
    synced,
    { group: freshGroup(s.layers), audioId: freshId("snd", taken), name, size: engineHost.sceneSize() },
  );
  return { ops, lines };
}

/** The multicam clip `id`, or the one under timeline second `at`. */
export function multicamClip(at: number, id?: string): MulticamClip | null {
  if (!engineHost.ready) return null;
  const s = scene();
  if (id) {
    const l = s.layers.find((x) => x.id === id);
    return l ? multicamOf(l, s.duration) : null;
  }
  return multicamAt(s.layers, at, s.duration);
}

/** Switch to angle `k` (0-based) at `at`: the ops, and a line saying what happened. Throws when it cannot. */
export function switchAngle(k: number, at: number, footage: FootageClip[], id?: string): { ops: Op[]; text: string } {
  const c = multicamClip(at, id);
  if (!c) throw new Error(id ? `${id} is not a multicam clip` : `no multicam clip at ${at.toFixed(2)} s`);
  const s = scene();
  const lengths = new Map(footage.map((f) => [f.url, f.duration]));
  const ops = switchAngleOps(c, k, at, s.fps ?? 30, freshId(`${c.id}_`, new Set(s.layers.map((x) => x.id))), (src) => lengths.get(src) ?? null);
  const where = ops[0]?.op === "split_layer" ? `from ${at.toFixed(2)} s` : `for all of ${c.id}`;
  return { ops, text: ops.length ? `${angleName(c.multicam, k)} ${where}` : `${c.id} already shows ${angleName(c.multicam, k)}` };
}
