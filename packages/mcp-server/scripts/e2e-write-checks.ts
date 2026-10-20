/**
 * End-to-end check of the write-time tools (lint, placement, timing refs, checkpoints, next_step,
 * examples) through MCP, against a real editor. Same setup as smoke:
 *   MOTIONILY_TOKEN=… MOTIONILY_PROJECT=… pnpm --filter @motionily/mcp-server exec tsx scripts/e2e-write-checks.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: process.env as Record<string, string>, stderr: "inherit" }));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const body = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n> ${name}${res.isError ? " (error)" : ""} ${JSON.stringify(args).slice(0, 140)}\n${body}`);
  return { ok: !res.isError, body };
};

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.length, tools.filter((n) => ["inspect", "checkpoint", "next_step", "examples", "get_scene", "get_layer", "get_group"].includes(n)).join(", "));

await call("next_step");
await call("add_layers", { lines: "bg rect 0-6 x=540 y=960 w=1080 h=1920 fill=background" });
await call("add_layers", {
  lines: [
    "pill rect 0-6 x=540 y=900 w=600 h=200 rad=100 fill=primary",
    'label text 0-6 x=540 y=900 w=500 h=80 size=60 fill=primary "Book now"',
    'fine text 0-6 x=540 y=300 w=400 h=40 size=14 fill=text "fine print"',
    "edge rect 0-6 x=1070 y=1500 w=300 h=300 fill=accent",
    'sub text 0-6 w=400 h=60 size=40 place=below:pill,gap=30 fill=on_background "Under the pill"',
  ].join("\n"),
});
await call("add_layers", { lines: 'refd text @phrase:1-@phrase:2 x=540 y=1400 w=300 h=60 size=40 fill=text "x"' });
await call("checkpoint", { action: "save", name: "before-fix" });
await call("edit_layers", { lines: "label fill=on_primary" });
await call("checkpoint", { action: "diff", name: "before-fix" });
await call("inspect", { target: "label" });
await call("inspect", { target: "group:nothing" });
await call("examples", { action: "save", label: "E2E pill test", tags: "test,pill" });
await call("examples", { action: "find", query: "pill" });
await call("review_video", { frames: 6 });
await call("checkpoint", { action: "restore", name: "before-fix" });
await call("next_step");
await client.close();
