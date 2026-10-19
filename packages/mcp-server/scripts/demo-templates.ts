/** Demo agent: a short video chained from scene templates. Needs the editor open. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "demo-templates", version: "0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: process.env as Record<string, string>, stderr: "inherit" }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
  console.log(`> ${name}${r.isError ? " ERR" : ""}: ${(r.content[0]?.text ?? "").split("\n").slice(0, 4).join(" | ")}`);
  return r;
};
for (let i = 0; i < 20; i++) {
  if ((await call("get_project")).content[0]?.text?.includes("Editor: open")) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await call("load_scene", { scene: JSON.stringify({ width: 1080, height: 1920, fps: 30, duration: 7, layers: [] }) });
await call("apply_template", { template: "kinetic_title", id: "b1", at: 0, duration: 2.2, title: "Menos papeles, más pacientes" });
await call("apply_template", { template: "clinic_scene", id: "b2", at: 2.2, duration: 4.8, title: "Tu consulta, en orden", subtitle: "Agenda, fichas y cobros" });
await call("apply_ops", { ops: [{ op: "add_transition", transition: { at: 2.2, use: "transition/shape_wipe", duration: 0.6 } }] });
await client.close();
