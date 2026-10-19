// Build apps/web/public/models/manifest.json: every bundled model with its size and clips,
// so agents can pick and place models without opening them. Run after adding models.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../apps/web/public/models/", import.meta.url).pathname;
const CATEGORY = { characters: "character", furniture: "furniture", "city-commercial": "building", "city-suburban": "building", market: "shop" };

function readGlb(path) {
  const b = readFileSync(path);
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString("utf8"));
}

const models = [];
for (const pack of readdirSync(root)) {
  const dir = join(root, pack);
  if (!statSync(dir).isDirectory()) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".glb")).sort()) {
    const j = readGlb(join(dir, file));
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const m of j.meshes) {
      for (const p of m.primitives) {
        const a = j.accessors[p.attributes.POSITION];
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i], a.min[i]);
          max[i] = Math.max(max[i], a.max[i]);
        }
      }
    }
    const r = (v) => Math.round(v * 100) / 100;
    models.push({
      key: `${pack}/${file.replace(/\.glb$/, "")}`,
      category: /^(aid|wheelchair)/.test(file) ? "medical" : (CATEGORY[pack] ?? pack),
      size: [0, 1, 2].map((i) => r(max[i] - min[i])),
      origin: min.map(r),
      ...(j.animations?.length ? { clips: j.animations.map((a) => a.name) } : {}),
    });
  }
}
writeFileSync(join(root, "manifest.json"), JSON.stringify({ license: "CC0 (Kenney), see LICENSES.txt", models }, null, 0));
console.log(`${models.length} models`);
