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
      { id: "sheet", type: "shape", shape: "rect", fill: "surface", anchor: "hero", w: 860, h: 1100, radius: 24, end: 2.5,
        anims: [{ use: "animation/paper_flutter" }] },
      { id: "title_bar", type: "shape", shape: "rect", fill: "primary", anchor: "title", w: 640, h: 120, radius: 12, end: 2.5,
        anims: [{ use: "animation/slide_in", at: 0.4 }] },
      { id: "seal", type: "shape", shape: "ellipse", fill: "accent", anchor: "accent", w: 220, h: 220, start: 2.5,
        anims: [{ use: "animation/pop_in", at: 0.1 }] },
    ],
  }),
});
await call("apply_ops", { ops: [{ op: "add_transition", transition: { at: 2.5, use: "transition/page_flip", duration: 0.8 } }] });
await call("apply_ops", { ops: [{ op: "add_anim", id: "seal", anim: { use: "animation/nope" } }] });
await call("create_brick", {
  slot: "animation",
  id: "stamp_spin",
  name: "Sello girando",
  payload: { keys: { rotation: [[0, 0, "linear"], [3, 360]] } },
});
await call("apply_ops", { ops: [{ op: "add_anim", id: "seal", anim: { use: "animation/stamp_spin", at: 0.6 } }] });
await new Promise((r) => setTimeout(r, Number(process.env.SMOKE_FEEDBACK_WAIT_MS ?? 0)));
await call("get_feedback");
await client.close();
