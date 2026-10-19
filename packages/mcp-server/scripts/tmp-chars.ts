import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "t", version: "0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: process.env as Record<string, string>, stderr: "inherit" }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  console.log(`> ${name}${r.isError ? " ERR" : ""}: ${r.content[0]?.text.split("\n").slice(0, 9).join(" | ")}`);
  return r;
};
for (let i = 0; i < 20; i++) { if ((await call("get_project")).content[0]?.text.includes("Editor: open")) break; await new Promise((r) => setTimeout(r, 1000)); }
const ch = (id: string, character: string, outfit: string, action: string, x: number, extra = {}) =>
  ({ id, type: "character", character, outfit, action, x, y: 1500, w: 260, h: 560, ...extra });
await call("load_scene", { scene: JSON.stringify({ width: 1080, height: 1920, fps: 30, duration: 5, layers: [
  ch("doctora", "stickman_outfit", "doctor", "wave", 300, { hair: "long" }),
  ch("oficinista", "stickman_outfit", "office", "walk", 760, { hair: "short", facing: -1 }),
  ch("chibi", "chibi", "sport", "celebrate", 540, { y: 1760, h: 380, hair: "bun" }),
  ch("blob", "blob", "casual", "jump", 880, { y: 1780, w: 200, h: 200 }),
  { id: "title", type: "text", text: "Tu consulta, al día", size: 96, anchor: "title", w: 900, h: 220, fill: "text" },
] }) });
await call("apply_ops", { ops: [{ op: "set_character", id: "doctora", hair: "short", hair_color: [1, 1, 1, 1] }] });
await call("get_layer", { id: "doctora" });
await client.close();
