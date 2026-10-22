/** Render stills of a video through the real (headless) editor, read-only: MOTIONILY_TOKEN, MOTIONILY_PROJECT, E2E_OUT, times as args. */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "stills", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: process.env as Record<string, string>, stderr: "ignore" }));
const times = process.argv.slice(2).map(Number);
for (let i = 0; i < times.length; i += 6) {
  const res = (await client.callTool({ name: "render_frames", arguments: { times: times.slice(i, i + 6) } })) as { content: { type: string; text?: string; data?: string }[] };
  let n = i;
  for (const c of res.content) if (c.type === "image") writeFileSync(`${process.env.E2E_OUT}/t${String(times[n++]).padStart(5, "0")}.jpg`, Buffer.from(c.data!, "base64"));
}
await client.close();
