/**
 * End-to-end check of the material tools against the real editor (headless) and local API:
 * search_assets, import_assets, add_vector, add_map, find_icons + ic=prefix:name, set_direction.
 * Needs MOTIONILY_TOKEN and MOTIONILY_PROJECT of a TEST video (see reference notes).
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-assets", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: process.env as Record<string, string>, stderr: "inherit" }));
const out = process.env.E2E_OUT ?? ".";
let images = 0;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  const body = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  for (const c of res.content.filter((c) => c.type === "image")) writeFileSync(`${out}/${name}-${images++}.jpg`, Buffer.from(c.data!, "base64"));
  console.log(`\n> ${name}${res.isError ? " (ERROR)" : ""} ${JSON.stringify(args).slice(0, 160)}\n${body.slice(0, 1800)}`);
  return body;
};

await call("get_project");
await call("apply_ops", { ops: [{ op: "clear_layers" }, { op: "set_duration", seconds: 6 }] });
await call("find_icons", { query: "rocket launch", limit: 12 });
const found = await call("search_assets", { needs: [{ q: "Fanta", kind: "logo" }, { q: "Coca-Cola bottle 1930s", kind: "photo" }], per_query: 6 });
const logo = /id="(commons:File:Fanta logo \(2009\)\.svg)"/.exec(found)?.[1] ?? /id="(iconify:[^"]+fanta)"/.exec(found)?.[1];
const imported = await call("import_assets", { ids: [logo], query: "fanta logo" });
const svg = /svg "(\/media\/[^"]+\.svg)"/.exec(imported)?.[1];
await call("add_vector", { id: "fanta", svg, x: 540, y: 700, w: 700, split: "parts" });
await call("add_vector", { id: "rocket", icon: "fluent-emoji-flat:rocket", x: 540, y: 1250, w: 260 });
await call("add_map", { id: "de", x: 540, y: 1500, w: 700, h: 500, focus: ["Germany"], highlight: ["Germany"], points: [{ name: "Essen", lon: 7.01, lat: 51.46 }] });
await call("add_layers", { lines: 'star path 0 x=200 y=200 ic=ph:star-fill:96 fill=accent g=icons\nbell path 0 x=880 y=200 ic=tabler:bell:96 g=icons' });
await call("set_direction", { genre: "editorial_collage", concept: "A wartime story told as a collage of real cutouts, logos and paper on a desk", techniques: ["cutouts with white outline", "map route drawn on", "logo pieces assembling"] });
await call("render_frames", { times: [1] });
await client.close();
