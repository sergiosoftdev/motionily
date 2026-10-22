/**
 * add_map: countries as real path layers (Natural Earth 1:50m, public domain, via world-atlas),
 * projected, framed on the places that matter and clipped to the box. Highlighted countries get
 * their own layers to fill, pulse or draw on; places come back as scene coordinates for pins,
 * labels and routes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Natural Earth at two scales: 1:110m for world views, 1:50m once a degree spans enough pixels. */
const Resolution = { Coarse: "110m", Fine: "50m" } as const;
type Resolution = (typeof Resolution)[keyof typeof Resolution];
const atlasUrl = (r: Resolution) => `https://cdn.jsdelivr.net/npm/world-atlas@2/countries-${r}.json`;
const cacheFile = (r: Resolution) => join(process.env.MOTIONILY_HOME ?? join(homedir(), ".motionily"), "maps", `countries-${r}.json`);
/** Pixels per degree from which the 1:50m data is worth its size. */
const FINE_FROM_PX_PER_DEGREE = 8;
/** Points closer than this (px) to the previous one are dropped: invisible detail, big paths. */
const SIMPLIFY_PX = 1.2;
/** Mercator stops here (the poles are infinitely far). */
const MERCATOR_LAT = 84;
/** A focus country's islands count for framing only when this big next to its largest piece (no Alaska-wide frame for "USA"). */
const FRAME_PIECE = 0.15;

export const MapProjection = { Mercator: "mercator", NaturalEarth: "natural_earth", Equirectangular: "equirectangular" } as const;
export type MapProjection = (typeof MapProjection)[keyof typeof MapProjection];

type Ring = [number, number][];
type Country = { name: string; polygons: Ring[][] };
type Topo = {
  transform: { scale: [number, number]; translate: [number, number] };
  arcs: [number, number][][];
  objects: { countries: { geometries: TopoGeometry[] }; land: { geometries: TopoGeometry[] } };
};
type TopoGeometry = { type: string; id?: string; properties?: { name: string }; arcs: number[][] | number[][][] };

/** Countries, plus the land as merged shapes (no shared borders inside: one clean fill). */
type Atlas = { countries: Country[]; land: Ring[][] };
const atlases = new Map<Resolution, Atlas>();

async function atlas(res: Resolution = Resolution.Fine): Promise<Atlas> {
  const known = atlases.get(res);
  if (known) return known;
  let topo: Topo;
  try {
    topo = JSON.parse(readFileSync(cacheFile(res), "utf8")) as Topo;
  } catch {
    const answer = await fetch(atlasUrl(res), { signal: AbortSignal.timeout(30_000) });
    if (!answer.ok) throw new Error(`map data unavailable (${answer.status})`);
    const text = await answer.text();
    topo = JSON.parse(text) as Topo;
    try {
      mkdirSync(join(cacheFile(res), ".."), { recursive: true });
      writeFileSync(cacheFile(res), text);
    } catch {
      // Cached next time, then.
    }
  }
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  const arcs = topo.arcs.map((arc) => {
    let [x, y] = [0, 0];
    return arc.map(([dx, dy]): [number, number] => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
  const ring = (ids: number[]): Ring => {
    const out: Ring = [];
    for (const i of ids) {
      const a = i >= 0 ? arcs[i]! : [...arcs[~i]!].reverse();
      out.push(...(out.length ? a.slice(1) : a));
    }
    // Rings across the antimeridian (Russia, Fiji) jump 360°: unwrap them into one continuous
    // shape, or a fill would draw a band across the whole world.
    for (let k = 1; k < out.length; k++) {
      const jump = out[k]![0] - out[k - 1]![0];
      if (Math.abs(jump) > 180) for (let j = k; j < out.length; j++) out[j] = [out[j]![0] - Math.sign(jump) * 360, out[j]![1]];
    }
    const mean = out.reduce((s, p) => s + p[0], 0) / Math.max(1, out.length);
    if (mean > 180 || mean < -180) for (let j = 0; j < out.length; j++) out[j] = [out[j]![0] - Math.sign(mean) * 360, out[j]![1]];
    return out;
  };
  const polygons = (g: TopoGeometry) => (g.type === "Polygon" ? [(g.arcs as number[][]).map(ring)] : g.type === "MultiPolygon" ? (g.arcs as number[][][]).map((p) => p.map(ring)) : []);
  const built: Atlas = {
    countries: topo.objects.countries.geometries.map((g) => ({ name: g.properties?.name ?? "", polygons: polygons(g) })),
    land: topo.objects.land.geometries.flatMap(polygons),
  };
  atlases.set(res, built);
  return built;
}

async function countries(res?: Resolution): Promise<Country[]> {
  return (await atlas(res)).countries;
}

/** Everyday names -> Natural Earth's (often abbreviated) names. */
const ALIASES: Record<string, string> = {
  usa: "United States of America", us: "United States of America", "united states": "United States of America", america: "United States of America",
  uk: "United Kingdom", britain: "United Kingdom", "great britain": "United Kingdom", england: "United Kingdom", scotland: "United Kingdom", wales: "United Kingdom",
  bosnia: "Bosnia and Herz.", "bosnia and herzegovina": "Bosnia and Herz.", drc: "Dem. Rep. Congo", "dr congo": "Dem. Rep. Congo",
  "democratic republic of the congo": "Dem. Rep. Congo", "republic of the congo": "Congo", "central african republic": "Central African Rep.",
  "dominican republic": "Dominican Rep.", "equatorial guinea": "Eq. Guinea", "south sudan": "S. Sudan", "western sahara": "W. Sahara",
  "north macedonia": "Macedonia", "czech republic": "Czechia", "ivory coast": "Côte d'Ivoire", "cote d'ivoire": "Côte d'Ivoire", swaziland: "eSwatini",
  eswatini: "eSwatini", burma: "Myanmar", holland: "Netherlands", korea: "South Korea", "republic of korea": "South Korea", "east timor": "Timor-Leste",
  "cape verde": "Cabo Verde", "antigua and barbuda": "Antigua and Barb.", "solomon islands": "Solomon Is.", "faroe islands": "Faeroe Is.",
  "falkland islands": "Falkland Is.", "french polynesia": "Fr. Polynesia", uae: "United Arab Emirates", emirates: "United Arab Emirates",
  "vatican city": "Vatican", "soviet union": "Russia", ussr: "Russia", persia: "Iran", siam: "Thailand", ceylon: "Sri Lanka",
};

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\bis\.\s*/g, "islands ").replace(/\brep\.\s*/g, "republic ").replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim();

async function find(names: string[]): Promise<{ found: Country[]; unknown: string[] }> {
  const all = await countries();
  const byName = new Map(all.map((c) => [norm(c.name), c]));
  const found: Country[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const n = norm(raw);
    const hit = byName.get(norm(ALIASES[n] ?? raw)) ?? all.find((c) => norm(c.name).startsWith(n) || n.startsWith(norm(c.name)));
    if (hit) {
      if (!found.includes(hit)) found.push(hit);
    } else unknown.push(raw);
  }
  return { found, unknown };
}

// ── projections (lon/lat degrees -> plane units, y down) ──
const RAD = Math.PI / 180;
const PROJECT: Record<MapProjection, (lon: number, lat: number) => [number, number]> = {
  [MapProjection.Mercator]: (lon, lat) => {
    const p = Math.max(-MERCATOR_LAT, Math.min(MERCATOR_LAT, lat)) * RAD;
    return [lon * RAD, -Math.log(Math.tan(Math.PI / 4 + p / 2))];
  },
  [MapProjection.Equirectangular]: (lon, lat) => [lon * RAD, -lat * RAD],
  [MapProjection.NaturalEarth]: (lon, lat) => {
    const l = lon * RAD;
    const p = lat * RAD;
    const p2 = p * p;
    const p4 = p2 * p2;
    return [l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))), -p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)))];
  },
};

type Box = [number, number, number, number];
const ringBox = (r: Ring): Box => r.reduce<Box>((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
const union = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const ringArea = (r: Ring) => Math.abs(r.reduce((s, [x0, y0], i) => s + x0 * r[(i + 1) % r.length]![1] - r[(i + 1) % r.length]![0] * y0, 0) / 2);

/** Sutherland–Hodgman against an axis-aligned box: rings become their visible part. */
function clip(ring: Ring, [x0, y0, x1, y1]: Box): Ring {
  const edges: [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  let out = ring;
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!;
      const prev = input[(i + input.length - 1) % input.length]!;
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cut(prev, cur));
    }
    if (!out.length) break;
  }
  return out;
}

export type MapOptions = {
  id: string;
  start: number;
  end?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  group: string;
  /** Countries the frame is fitted to; empty = the whole world. */
  focus: string[];
  highlight: string[];
  projection?: MapProjection;
  land: string;
  accent: string;
  /** Country borders `W:COLOR` (`none` for none). */
  borders: string;
  /** Margin around the focus, as a fraction of its size. */
  pad: number;
  points: { name: string; lon: number; lat: number }[];
};

export type MapBuild = { lines: string[]; info: string[]; unknown: string[] };

const r1 = (v: number) => +v.toFixed(1);
const slug = (s: string) => norm(s).replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");

export async function mapLines(o: MapOptions): Promise<MapBuild> {
  const all = await countries();
  const focus = await find(o.focus);
  const marked = await find(o.highlight);
  const unknown = [...focus.unknown, ...marked.unknown];
  const projection = o.projection ?? (focus.found.length ? MapProjection.Mercator : MapProjection.NaturalEarth);
  const project = PROJECT[projection];
  const projected = new Map(all.map((c) => [c, c.polygons.map((poly) => poly.map((r) => r.map(([lon, lat]) => project(lon, lat))))]));
  // Frame: the focus countries' main pieces (or the world), padded, fitted inside the box.
  let frame: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of focus.found.length ? focus.found : all) {
    const polys = projected.get(c)!;
    const biggest = Math.max(...polys.map((p) => ringArea(p[0]!)));
    for (const p of polys) if (!focus.found.length || ringArea(p[0]!) >= biggest * FRAME_PIECE) frame = union(frame, ringBox(p[0]!));
  }
  for (const pt of o.points) {
    const [px, py] = project(pt.lon, pt.lat);
    if (focus.found.length) frame = union(frame, [px, py, px, py]);
  }
  const fw = frame[2] - frame[0];
  const fh = frame[3] - frame[1];
  const padded: Box = [frame[0] - fw * o.pad, frame[1] - fh * o.pad, frame[2] + fw * o.pad, frame[3] + fh * o.pad];
  const k = Math.min(o.w / (padded[2] - padded[0]), o.h / (padded[3] - padded[1]));
  const [cx, cy] = [(padded[0] + padded[2]) / 2, (padded[1] + padded[3]) / 2];
  // Zoomed out, the coarse data looks the same at a fraction of the path size.
  const res = k * RAD >= FINE_FROM_PX_PER_DEGREE ? Resolution.Fine : Resolution.Coarse;
  const drawn = await atlas(res);
  const projectAll = (polys: Ring[][]) => polys.map((poly) => poly.map((r) => r.map(([lon, lat]) => project(lon, lat))));
  const drawnOf = (c: Country) => projectAll(drawn.countries.find((d) => d.name === c.name)?.polygons ?? c.polygons);
  const toBox = ([px, py]: [number, number]): [number, number] => [(px - cx) * k, (py - cy) * k];
  const view: Box = [-o.w / 2, -o.h / 2, o.w / 2, o.h / 2];
  const visible = (r: Ring) => {
    const b = ringBox(r);
    return !(b[2] < view[0] || b[0] > view[2] || b[3] < view[1] || b[1] > view[3]);
  };
  const thin = (pts: Ring) => {
    const kept: Ring = [];
    for (const p of pts) {
      const last = kept[kept.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= SIMPLIFY_PX) kept.push(p);
    }
    return kept;
  };
  const pt = ([x, y]: [number, number]) => `${r1(x)} ${r1(y)}`;
  /** Filled shapes: each ring clipped to the box as a polygon. */
  const fillPath = (polys: Ring[][]) => {
    const parts: string[] = [];
    for (const poly of polys)
      for (const raw of poly) {
        const r = raw.map(toBox);
        if (!visible(r)) continue;
        const kept = thin(clip(r, view));
        if (kept.length >= 3) parts.push(`M${kept.map(pt).join("L")}Z`);
      }
    return parts.join("");
  };
  /** Border lines: rings cut into the runs that lie inside the box (no lines along its edges). */
  const linePath = (polys: Ring[][]) => {
    const parts: string[] = [];
    const inside = ([x, y]: [number, number]) => x >= view[0] && x <= view[2] && y >= view[1] && y <= view[3];
    for (const poly of polys)
      for (const raw of poly) {
        const r = raw.map(toBox);
        if (!visible(r)) continue;
        let run: Ring = [];
        const flush = () => {
          const kept = thin(run);
          if (kept.length >= 2) parts.push(`M${kept.map(pt).join("L")}`);
          run = [];
        };
        for (const p of [...r, r[0]!]) {
          if (inside(p)) run.push(p);
          else flush();
        }
        flush();
      }
    return parts.join("");
  };
  const pathOf = (c: Country) => fillPath(drawnOf(c));
  const span = `${o.start}${o.end !== undefined ? `-${o.end}` : ""}`;
  const border = o.borders === "none" ? "" : ` stroke=${o.borders}`;
  const lines = [`${o.id} rect ${span} x=${r1(o.x)} y=${r1(o.y)} w=${r1(o.w)} h=${r1(o.h)} vis=0 g=${o.group}`];
  const land = fillPath(projectAll(drawn.land));
  if (land) lines.push(`${o.id}_land path ${span} parent=${o.id} x=0 y=0 g=${o.group} filled=1 fill=${o.land} "${land}"`);
  const borders = o.borders === "none" ? "" : linePath(drawn.countries.filter((c) => !marked.found.some((m) => m.name === c.name)).flatMap((c) => projectAll(c.polygons)));
  if (borders) lines.push(`${o.id}_borders path ${span} parent=${o.id} x=0 y=0 g=${o.group} stroke=${o.borders} "${borders}"`);
  const info = [`projection ${projection}, Natural Earth 1:${res}; 1° of longitude ≈ ${r1(k * RAD)} px at the center`];
  for (const c of marked.found) {
    const d = pathOf(c);
    const id = `${o.id}_${slug(c.name)}`;
    if (!d) {
      info.push(`${c.name}: outside the frame (add it to focus)`);
      continue;
    }
    lines.push(`${id} path ${span} parent=${o.id} x=0 y=0 g=${o.group} filled=1 fill=${o.accent}${border} "${d}"`);
    const polys = projected.get(c)!;
    const main = polys.reduce((a, b) => (ringArea(b[0]!) > ringArea(a[0]!) ? b : a))[0]!.map(toBox);
    const b = ringBox(main);
    info.push(`${id}: ${c.name}, main shape center x=${r1(o.x + (b[0] + b[2]) / 2)} y=${r1(o.y + (b[1] + b[3]) / 2)} size ${r1(b[2] - b[0])}×${r1(b[3] - b[1])}`);
  }
  for (const pt of o.points) {
    const [bx, by] = toBox(project(pt.lon, pt.lat));
    const inside = bx >= view[0] && bx <= view[2] && by >= view[1] && by <= view[3];
    info.push(`point ${pt.name}: x=${r1(o.x + bx)} y=${r1(o.y + by)}${inside ? "" : " (outside the map box)"}`);
  }
  return { lines, info, unknown };
}
