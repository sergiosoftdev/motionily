/**
 * Builds src/icons.json from Lucide (ISC license, https://lucide.dev): every icon as ONE path
 * string centered on 0,0 in a 24-unit box (stroke-width 2, round caps), plus its search tags.
 *
 *   npm pack lucide-static && tar xzf lucide-static-*.tgz
 *   npx tsx scripts/build-icons.ts package/icon-nodes.json package/tags.json
 */
import { readFileSync, writeFileSync } from "node:fs";

const HALF = 12;
type Node = [string, Record<string, string>];

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const r = (n: number) => +n.toFixed(3);

/** SVG path data -> absolute commands, shifted by -HALF so the icon is centered. */
function center(d: string): string {
  // Character scanner: arc flags are single digits that may touch the next number ("017.07").
  let p = 0;
  const skip = () => {
    while (p < d.length && /[\s,]/.test(d[p]!)) p++;
  };
  const number = () => {
    skip();
    const m = /^[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/i.exec(d.slice(p));
    if (!m) throw new Error(`bad number at ${p} in ${d}`);
    p += m[0].length;
    return Number(m[0]);
  };
  const flag = () => {
    skip();
    return Number(d[p++]);
  };
  let cmd = "";
  let [x, y, sx, sy] = [0, 0, 0, 0];
  const out: string[] = [];
  for (skip(); p < d.length; skip()) {
    if (/[a-zA-Z]/.test(d[p]!)) cmd = d[p++]!;
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const n = ARGS[up];
    if (n === undefined) throw new Error(`unsupported command ${cmd} in ${d}`);
    if (up === "Z") {
      out.push("Z");
      [x, y] = [sx, sy];
      continue;
    }
    const v = Array.from({ length: n }, (_, k) => (up === "A" && (k === 3 || k === 4) ? flag() : number()));
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    let abs: number[];
    if (up === "H") {
      abs = [v[0]! + ox];
      x = abs[0]!;
      out.push(`H${r(x - HALF)}`);
    } else if (up === "V") {
      abs = [v[0]! + oy];
      y = abs[0]!;
      out.push(`V${r(y - HALF)}`);
    } else if (up === "A") {
      const [rx, ry, rot, large, sweep, ex, ey] = v as [number, number, number, number, number, number, number];
      x = ex + ox;
      y = ey + oy;
      out.push(`A${r(rx)} ${r(ry)} ${r(rot)} ${large} ${sweep} ${r(x - HALF)} ${r(y - HALF)}`);
    } else {
      abs = v.map((c, k) => c + (k % 2 === 0 ? ox : oy));
      x = abs[abs.length - 2]!;
      y = abs[abs.length - 1]!;
      if (up === "M") [sx, sy] = [x, y];
      out.push(up + abs.map((c) => r(c - HALF)).join(" "));
    }
    // Further pairs after M are lines.
    if (up === "M") cmd = rel ? "l" : "L";
  }
  return out.join("");
}

const n = (a: Record<string, string>, k: string) => Number(a[k] ?? 0);

function toPath([kind, a]: Node): string {
  switch (kind) {
    case "path":
      return a.d!;
    case "circle":
    case "ellipse": {
      const [cx, cy] = [n(a, "cx"), n(a, "cy")];
      const [rx, ry] = kind === "circle" ? [n(a, "r"), n(a, "r")] : [n(a, "rx"), n(a, "ry")];
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case "rect": {
      const [x, y, w, h] = [n(a, "x"), n(a, "y"), n(a, "width"), n(a, "height")];
      const rr = Math.min(n(a, "rx") || n(a, "ry"), w / 2, h / 2);
      if (!rr) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rr} ${y}H${x + w - rr}A${rr} ${rr} 0 0 1 ${x + w} ${y + rr}V${y + h - rr}A${rr} ${rr} 0 0 1 ${x + w - rr} ${y + h}H${x + rr}A${rr} ${rr} 0 0 1 ${x} ${y + h - rr}V${y + rr}A${rr} ${rr} 0 0 1 ${x + rr} ${y}Z`;
    }
    case "line":
      return `M${a.x1} ${a.y1}L${a.x2} ${a.y2}`;
    case "polyline":
    case "polygon": {
      const pts = a.points!.trim().split(/[\s,]+/).map(Number);
      const pairs = Array.from({ length: pts.length / 2 }, (_, k) => `${pts[k * 2]} ${pts[k * 2 + 1]}`);
      return `M${pairs.join("L")}${kind === "polygon" ? "Z" : ""}`;
    }
    default:
      throw new Error(`unsupported element ${kind}`);
  }
}

const [nodesFile, tagsFile] = process.argv.slice(2);
const nodes = JSON.parse(readFileSync(nodesFile!, "utf8")) as Record<string, Node[]>;
const tags = JSON.parse(readFileSync(tagsFile!, "utf8")) as Record<string, string[]>;
const icons: Record<string, { d: string; tags: string[] }> = {};
for (const [name, els] of Object.entries(nodes)) icons[name] = { d: els.map((e) => center(toPath(e))).join(""), tags: tags[name] ?? [] };
writeFileSync(new URL("../src/icons.json", import.meta.url), JSON.stringify(icons));
console.log(`${Object.keys(icons).length} icons`);
