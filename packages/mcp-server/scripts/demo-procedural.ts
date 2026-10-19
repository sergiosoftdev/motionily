/** Demo agent: builds a clinic, a camilla and two characters procedurally, saves them as prefabs, animates. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "demo-procedural", version: "0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: process.env as Record<string, string>, stderr: "inherit" }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
  console.log(`> ${name}${r.isError ? " ERR" : ""}: ${(r.content[0]?.text ?? "").split("\n").slice(0, 3).join(" | ")}`);
  return r;
};
for (let i = 0; i < 20; i++) {
  if ((await call("get_project")).content[0]?.text?.includes("Editor: open")) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const leg = { shape: "cylinder", radius: 0.035, height: 0.6, position: [-0.85, 0.3, -0.27], color: "text", repeat: { count: [2, 1, 2], spacing: [1.7, 0, 0.54] } };
await call("save_prefab", {
  name: "camilla", kind: "object", description: "Camilla de fisioterapia con agujero facial",
  node: { children: [
    leg,
    { shape: "box", size: [1.95, 0.16, 0.72], radius: 0.06, position: [0, 0.66, 0], color: "primary" },
    { shape: "box", size: [1.95, 0.05, 0.72], radius: 0.02, position: [0, 0.56, 0], color: "text" },
    { shape: "torus", radius: 0.09, tube: 0.025, position: [0.8, 0.745, 0], color: "text" },
    { shape: "box", size: [0.5, 0.06, 0.7], radius: 0.03, position: [-0.7, 0.77, 0], color: "surface" },
  ] },
});
await call("save_prefab", {
  name: "consulta", kind: "space", description: "Consulta: suelo, dos paredes, ventana, estantería, planta",
  node: { children: [
    { shape: "box", size: [5, 0.06, 4], position: [0, -0.03, 0], color: "surface" },
    { shape: "box", size: [5, 2.6, 0.12], position: [0, 1.3, -2], color: "background" },
    { shape: "box", size: [0.12, 2.6, 4], position: [-2.5, 1.3, 0], color: "background" },
    { shape: "box", size: [1.3, 0.9, 0.05], radius: 0.04, position: [0.6, 1.6, -1.93], color: [0.75, 0.88, 0.98, 1] },
    { shape: "box", size: [0.9, 1.6, 0.35], radius: 0.03, position: [-1.7, 0.8, -1.8], color: "accent",
      children: [{ shape: "box", size: [0.8, 0.04, 0.3], position: [0, -0.4, 0.02], color: "surface", repeat: { count: [1, 3, 1], spacing: [0, 0.45, 0] } }] },
    { shape: "lathe", points: [[0, 0], [0.18, 0.02], [0.16, 0.38], [0, 0.4]], position: [2.0, 0, -1.6], color: "accent",
      children: [{ shape: "sphere", radius: 0.32, position: [0, 0.65, 0], color: "primary", scale: [1, 1.3, 1] }] },
    { prefab: "camilla", position: [0.3, 0, -1.1] },
  ] },
});
await call("save_prefab", { name: "fisio", kind: "character", description: "Fisio con bata blanca y moño",
  node: { rig: { style: "labcoat", top: [0.97, 0.97, 0.95, 1], bottom: [0.13, 0.15, 0.14, 1], hair: "bun", steth: true, badge: true } } });
await call("save_prefab", { name: "paciente", kind: "character", description: "Paciente en ropa deportiva",
  node: { rig: { style: "hoodie", top: "accent", bottom: [0.3, 0.37, 0.45, 1], hair: "beanie", hat: "primary" } } });
await call("load_scene", { scene: JSON.stringify({ width: 1080, height: 1920, fps: 30, duration: 6, layers: [
  { id: "title", type: "text", text: "Tu consulta, a tu manera", size: 88, anchor: "top", w: 900, h: 200, fill: "text", anims: [{ use: "animation/fade_up", at: 0.4 }] },
] }) });
await call("apply_ops", { ops: [
  { op: "put_prop", prop: { id: "set", prefab: "consulta" } },
  { op: "put_prop", prop: { id: "fisio", prefab: "fisio", x: 1.25, z: -0.45, rotation: -50, action: "stressed", enter: "drop" } },
  { op: "put_prop", prop: { id: "paciente", prefab: "paciente", x: -1.8, z: 0.6, enter: "pop", enter_delay: 0.3,
    beats: [{ at: 0.4, duration: 2.2, go_to: "fisio", action: "wave" }, { at: 3.6, face: "fisio", action: "point" }] } },
  { op: "set_shots", shots: [
    { start: 0, end: 2.2, kind: "reveal", target: "all", yaw: 25, pitch: 28 },
    { start: 2.2, end: 4.2, kind: "push_in", target: "fisio", yaw: -25, framing: 0.9, blend: 0.4 },
    { start: 4.2, end: 6, kind: "follow", target: "paciente", yaw: 35, framing: 1.2 },
  ] },
] });
await call("list_prefabs");
await client.close();
