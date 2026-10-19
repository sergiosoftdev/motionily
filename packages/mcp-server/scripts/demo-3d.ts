/** Demo agent: 3D clinic set with animated characters and a camera move. Needs the editor open. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "demo-3d", version: "0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: process.env as Record<string, string>, stderr: "inherit" }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
  console.log(`> ${name}${r.isError ? " ERR" : ""}: ${(r.content[0]?.text ?? "").split("\n").slice(0, 6).join(" | ")}`);
  return r;
};
for (let i = 0; i < 20; i++) {
  if ((await call("get_project")).content[0]?.text?.includes("Editor: open")) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await call("load_scene", {
  scene: JSON.stringify({ width: 1080, height: 1920, fps: 30, duration: 5, layers: [
    { id: "title", type: "text", text: "Tu consulta, en 3D", size: 92, anchor: "title", w: 900, h: 200, fill: "text", anims: [{ use: "animation/pop_in", at: 0.3 }] },
  ] }),
});
await call("apply_ops", {
  ops: [
    { op: "set_stage_preset", kind: "clinic_room" },
    { op: "put_prop", prop: { id: "paciente", model: "characters/character-male-c", x: 0.35, y: 0.45, z: -1.25, rotation: 0, action: "sit", enter: "pop" } },
    { op: "put_prop", prop: { id: "fisio", model: "characters/character-female-b", x: 0.95, z: -0.35, rotation: -40, action: "interact-left", enter: "pop", enter_delay: 0.3 } },
    { op: "put_prop", prop: { id: "recepcion", model: "characters/character-female-e", x: [{ t: 0, v: -1.4 }, { t: 5, v: 0.2 }], z: 0.7, rotation: 90, action: "walk", enter: "pop", enter_delay: 0.6 } },
    { op: "set_camera", camera: { yaw: [{ t: 0, v: 10 }, { t: 5, v: 42 }], pitch: 24, distance: [{ t: 0, v: 6.4 }, { t: 5, v: 4.8 }], target_x: -0.2, target_y: 0.35, target_z: -0.6 } },
  ],
});
await call("render_frames", { times: [0.8, 3.5] });
await client.close();
