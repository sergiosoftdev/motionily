/**
 * End-to-end smoke test through MCP, the way Claude Code would run it.
 * Needs the API up, the project open in the editor, and an agent token:
 *   MOTIONILY_TOKEN=… MOTIONILY_PROJECT=… pnpm --filter @motionily/mcp-server smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    env: process.env as Record<string, string>,
    stderr: "inherit",
  }),
);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  console.log(`\n> ${name}${res.isError ? " (error)" : ""}\n${res.content.map((c) => c.text).join("\n")}`);
  return res;
};

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));

// Wait for the editor to attach to this bridge.
for (let i = 0; i < 20; i++) {
  const r = await call("get_project");
  if (r.content[0]?.text.includes("Editor: open")) break;
  await new Promise((r) => setTimeout(r, 1000));
}

await call("load_scene", {
  scene: JSON.stringify({
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 5,
    layers: [
      { id: "sheet", shape: "rect", fill: "surface", x: 540, y: 960, w: 860, h: 1300, radius: 24,
        rotation: [{ t: 0, v: -6, ease: "back" }, { t: 0.8, v: -2 }],
        y_note: "ignored field is rejected? no: serde ignores unknown" },
      { id: "title_bar", shape: "rect", start: 0.4, fill: "primary", x: 540, w: 640, h: 120, radius: 12,
        y: [{ t: 0, v: 2100, ease: "back" }, { t: 0.7, v: 640 }] },
      { id: "seal", shape: "ellipse", start: 1, fill: "accent", x: 800, y: 1400, w: 220, h: 220,
        scale: [{ t: 0, v: 0, ease: "back" }, { t: 0.5, v: 1 }] },
    ],
  }),
});
await call("apply_ops", { ops: [{ op: "set_prop", id: "seal", prop: "rotation", value: [{ t: 0, v: 0 }, { t: 3, v: 360, ease: "linear" }] }] });
await call("create_brick", {
  slot: "animation",
  id: "stamp_spin",
  name: "Sello girando",
  payload: { keys: { rotation: [[0, 0, "linear"], [3, 360]] } },
});
await new Promise((r) => setTimeout(r, Number(process.env.SMOKE_FEEDBACK_WAIT_MS ?? 0)));
await call("get_feedback");
await client.close();
