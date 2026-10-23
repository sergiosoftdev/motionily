/** Call one MCP tool on a video and print its text: MOTIONILY_TOKEN, MOTIONILY_PROJECT; args: tool name, JSON arguments. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [name, args] = process.argv.slice(2);
const SAVE_GRACE_MS = 4000;
const client = new Client({ name: "call", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: process.env as Record<string, string>, stderr: "ignore" }));
const res = (await client.callTool({ name: name!, arguments: JSON.parse(args ?? "{}") })) as { content: { type: string; text?: string }[]; isError?: boolean };
console.log(`${res.isError ? "(error) " : ""}${res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")}`);
// The headless editor saves a moment after each change: closing at once would drop the last edit.
await new Promise((r) => setTimeout(r, SAVE_GRACE_MS));
await client.close();
