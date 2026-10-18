/**
 * End-to-end smoke test: spawns the MCP server like Claude would, waits for the
 * editor to connect, then edits the scene and reads feedback through MCP.
 * Run with the editor open: pnpm --filter @motionily/mcp-server smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    env: { ...process.env, MOTIONILY_PROJECT: process.env.MOTIONILY_PROJECT ?? "/tmp/smoke.motionily.json" } as Record<string, string>,
    stderr: "inherit",
  }),
);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const out = res.content.map((c) => c.text).join("\n");
  console.log(`\n> ${name}${res.isError ? " (error)" : ""}\n${out}`);
  return res;
};

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));

// Give the editor time to reconnect to the fresh bridge.
for (let i = 0; i < 30; i++) {
  const r = await call("get_scene");
  if (!r.isError) break;
  await new Promise((r) => setTimeout(r, 1000));
}

await call("apply_ops", {
  ops: [
    { op: "set_style", style: "bold" },
    {
      op: "add_layer",
      layer: {
        id: "badge",
        shape: "ellipse",
        start: 0.2,
        fill: "primary",
        x: 820,
        y: 420,
        w: 220,
        h: 220,
        scale: [
          { t: 0, v: 0, ease: "back" },
          { t: 0.5, v: 1 },
        ],
      },
    },
  ],
});
await call("apply_ops", { ops: [{ op: "remove_layer", id: "nope" }] });
// Leave the user a moment to react in the editor.
await new Promise((r) => setTimeout(r, Number(process.env.SMOKE_FEEDBACK_WAIT_MS ?? 0)));
await call("get_feedback");
await client.close();
