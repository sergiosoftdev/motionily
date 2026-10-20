/** Demo agent: titles + captions with key words. Run with MOTIONILY_TOKEN/MOTIONILY_PROJECT and the editor open. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "t", version: "0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: process.env as Record<string, string>, stderr: "inherit" }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  console.log(`> ${name}${r.isError ? " ERR" : ""}: ${r.content[0]?.text.split("\n").slice(0, 8).join(" | ")}`);
  return r;
};
for (let i = 0; i < 20; i++) { if ((await call("get_project")).content[0]?.text.includes("Editor: open")) break; await new Promise((r) => setTimeout(r, 1000)); }
const words = "Reserva tu cita en 10 segundos desde el móvil sin llamadas ni esperas".split(" ").map((t, i) => ({ text: t, start: 0.3 + i * 0.32, end: 0.3 + i * 0.32 + 0.28 }));
await call("load_scene", { scene: JSON.stringify({ width: 1080, height: 1920, fps: 30, duration: 5, layers: [
  { id: "card", type: "shape", shape: "rect", fill: "surface", anchor: "hero", w: 820, h: 620, radius: 32, anims: [{ use: "animation/pop_in" }] },
  { id: "title", type: "text", text: "Tu agenda, sin líos", size: 110, anchor: "title", w: 900, h: 300, fill: "text", anims: [{ use: "animation/fade_up", at: 0.2 }] },
  { id: "sub", type: "text", text: "Citas online para fisios", size: 56, role: "body", anchor: "hero", w: 700, h: 200, fill: "primary", anims: [{ use: "animation/fade_up", at: 0.5 }] },
] }) });
await call("apply_ops", { ops: [{ op: "set_captions", captions: { words } }, { op: "set_emphasis", words: [4, 5, 11], emphasis: true }] });
await call("inspect");
await client.close();
