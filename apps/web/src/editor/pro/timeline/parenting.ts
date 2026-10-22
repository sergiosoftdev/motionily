import { OpName, type Op } from "@motionily/protocol";
import { shift, scale } from "../../../editing/direct";
import { engineHost } from "../../../engine/host";
import { isExpr, isKeys, setProp, type Anim } from "../keys";
import type { TimelineLayer, TimelineScene } from "./contract";

/**
 * Parenting that keeps the child where it is on screen, like AE. The engine composes a parent as
 * world = parent.origin + R(parent.rotation) · parent.scale · child center (layer.rs `world`/`place`),
 * rotation and scale add up / multiply, and depth z adds up. So re-parenting rewrites the child's
 * x/y, rotation, scale and z with the old and new parents' transforms at the current time.
 */

type Xf = { ox: number; oy: number; rot: number; s: number; z: number };
const IDENTITY: Xf = { ox: 0, oy: 0, rot: 0, s: 1, z: 0 };
const MAX_DEPTH = 16;
const RAD = Math.PI / 180;

const rotate = ([x, y]: [number, number], deg: number): [number, number] => {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return [x * c - y * s, x * s + y * c];
};

/** Local center the engine places: x/y moved by the pivot as the layer turns and scales around it. */
function localCenter(l: TimelineLayer, v: Record<string, number>): [number, number] {
  const [px, py] = l.pivot ?? [0, 0];
  const s = v.scale ?? 1;
  const [mx, my] = rotate([px * s, py * s], v.rotation ?? 0);
  return [(v.x ?? 0) + px - mx, (v.y ?? 0) + py - my];
}

/** World transform of layer `id` itself (its parent chain included), now. */
function worldOf(scene: TimelineScene, id: string | null | undefined, depth = 0): Xf {
  const l = id ? scene.layers.find((x) => x.id === id) : undefined;
  if (!l || depth > MAX_DEPTH) return IDENTITY;
  const up = worldOf(scene, l.parent, depth + 1);
  const v = engineHost.propValues(l.id) ?? {};
  const [cx, cy] = rotate(localCenter(l, v), up.rot);
  return { ox: up.ox + cx * up.s, oy: up.oy + cy * up.s, rot: up.rot + (v.rotation ?? 0), s: up.s * (v.scale ?? 1), z: up.z + (v.z ?? 0) };
}

/** Layers that can't be `id`'s parent: itself and everything parented under it. */
export function descendants(scene: TimelineScene, id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of scene.layers)
      if (l.parent && out.has(l.parent) && !out.has(l.id)) {
        out.add(l.id);
        grew = true;
      }
  }
  return out;
}

/** Ops that parent `id` to `parent` (null = no parent) without moving it on screen. */
export function parentOps(scene: TimelineScene, id: string, parent: string | null): Op[] {
  const l = scene.layers.find((x) => x.id === id);
  if (!l || (parent && descendants(scene, id).has(parent))) return [];
  const from = worldOf(scene, l.parent);
  const to = worldOf(scene, parent);
  const v = engineHost.propValues(id) ?? {};
  const s = v.scale ?? 1;
  const r = v.rotation ?? 0;

  // Where the child sits in the world now, and the local center that lands it there under `to`.
  const [lx, ly] = localCenter(l, v);
  const [wx, wy] = rotate([lx * from.s, ly * from.s], from.rot);
  const world: [number, number] = [from.ox + wx, from.oy + wy];
  const r2 = r + from.rot - to.rot;
  const s2 = to.s ? (s * from.s) / to.s : s;
  const [nx, ny] = rotate([(world[0] - to.ox) / (to.s || 1), (world[1] - to.oy) / (to.s || 1)], -to.rot);
  const [px, py] = l.pivot ?? [0, 0];
  const [mx, my] = rotate([px * s2, py * s2], r2);
  const x2 = nx - px + mx;
  const y2 = ny - py + my;

  const ops: Op[] = [{ op: OpName.Patch, id, fields: { parent } }];
  const x = l.x as Anim | undefined;
  const y = l.y as Anim | undefined;
  if (isKeys(x) || isKeys(y)) {
    // Animated position: map every key through the old → new parent transform (other axis sampled now).
    const k = s2 && s ? (from.s / (to.s || 1)) : 1;
    const turn = from.rot - to.rot;
    const [cx, cy] = [x2 - rotate([(v.x ?? 0) * k, (v.y ?? 0) * k], turn)[0], y2 - rotate([(v.x ?? 0) * k, (v.y ?? 0) * k], turn)[1]];
    const map = (px0: number, py0: number) => {
      const [a, b] = rotate([px0 * k, py0 * k], turn);
      return [a + cx, b + cy] as const;
    };
    if (!isExpr(x)) ops.push(setProp(id, "x", isKeys(x) ? x.map((key) => ({ ...key, v: map(key.v, v.y ?? 0)[0] })) : x2));
    if (!isExpr(y)) ops.push(setProp(id, "y", isKeys(y) ? y.map((key) => ({ ...key, v: map(v.x ?? 0, key.v)[1] })) : y2));
  } else {
    if (!isExpr(x)) ops.push(setProp(id, "x", round(x2)));
    if (!isExpr(y)) ops.push(setProp(id, "y", round(y2)));
  }
  if (Math.abs(r2 - r) > 1e-4 && !isExpr(l.rotation)) ops.push(setProp(id, "rotation", shift(l.rotation as never, r2 - r)));
  if (Math.abs(s2 - s) > 1e-6 && s && !isExpr(l.scale)) ops.push(setProp(id, "scale", scale(l.scale as never, s2 / s, 1)));
  if (Math.abs(from.z - to.z) > 1e-4 && !isExpr(l.z)) ops.push(setProp(id, "z", shift(l.z as never, from.z - to.z)));
  return ops;
}

const round = (n: number) => Math.round(n * 100) / 100;
