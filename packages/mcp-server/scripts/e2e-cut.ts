/** End-to-end check of the razor (cut tool / ripple_delete / split_layer) against the real headless editor. MOTIONILY_TOKEN, MOTIONILY_PROJECT of a TEST video. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-cut", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: process.env as Record<string, string>, stderr: "ignore" }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const body = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n> ${name}${res.isError ? " (ERROR)" : ""}\n${body.slice(0, 900)}`);
  return body;
};
const words = "Three games started a war . On Historia we open the files one screen at a time . El Salvador was tiny".split(" ").filter((w) => w !== ".");
let t = 0.5;
const captions = { words: words.map((w, i) => { const start = t; t += 0.4 + (i === 4 || i === 15 ? 0.6 : 0); return { text: w, start, end: start + 0.3 }; }) };
await call("apply_ops", { ops: [{ op: "clear_layers" }, { op: "set_duration", duration: 12 }, { op: "set_audio", audio: { start: 0, trim_in: 0, trim_out: null } }, { op: "set_captions", captions }] });
await call("add_layers", { lines: ['bg rect 0 x=540 y=960 w=1080 h=1920 fill=#111111 g=w', 'hook text 0-3 x=540 y=600 w=900 h=200 size=90 fill=#ffffff g=hook "Three games"', 'files text 3.4-6.6 x=540 y=900 w=900 h=200 size=80 fill=#ffffff g=files "The files"', 'tiny text 7-11 x=540 y=1200 w=900 h=200 size=80 fill=#ffffff g=tiny "Tiny"'].join("\n") });
await call("cut", { phrase: "On Historia we open the files one screen at a time" });
await call("inspect", {});
await call("apply_ops", { ops: [{ op: "split_layer", id: "tiny", at: 5 }] });
await call("inspect", { target: "tiny_2" });
await client.close();
