/** Load a scene JSON file into a headless editor and save frames as JPEGs (engine smoke test). */
import { readFileSync, writeFileSync } from "node:fs";
import { EditorBridge } from "../src/bridge.js";
import { HeadlessEditor } from "../src/headless.js";
import { ProjectApi } from "../src/api.js";

const [file, outDir, times = "1,2.5,4.5,6"] = process.argv.slice(2);
const token = process.env.MOTIONILY_TOKEN!;
const projectId = process.env.MOTIONILY_PROJECT!;
const apiUrl = process.env.MOTIONILY_API ?? "http://localhost:3100";
const api = new ProjectApi(apiUrl, token, projectId);
const bridge = new EditorBridge(apiUrl, token, projectId);
bridge.headless = new HeadlessEditor(process.env.MOTIONILY_WEB ?? "http://localhost:5173", projectId, () => api.headlessSession());
await new Promise((r) => setTimeout(r, 500));
const res = await bridge.loadScene(readFileSync(file!, "utf8"));
console.log("load", res.ok, res.error ?? "");
const ts = times.split(",").map(Number);
const frames = await bridge.renderFrames(ts, 1280);
frames.images?.forEach((url, i) => writeFileSync(`${outDir}/engine-${ts[i]}.jpg`, Buffer.from(url.split(",")[1]!, "base64")));
console.log("frames", frames.images?.length, frames.error ?? "");
await bridge.headless.close();
process.exit(0);
