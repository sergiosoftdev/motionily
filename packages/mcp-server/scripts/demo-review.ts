/** Self-review without the user's editor: headless editor + procedural demo + review_video. */
import { writeFileSync } from "node:fs";
import { EditorBridge } from "../src/bridge.js";
import { HeadlessEditor } from "../src/headless.js";
import { ProjectApi } from "../src/api.js";

const token = process.env.MOTIONILY_TOKEN!;
const projectId = process.env.MOTIONILY_PROJECT!;
const apiUrl = process.env.MOTIONILY_API ?? "http://localhost:3100";
const api = new ProjectApi(apiUrl, token, projectId);
const bridge = new EditorBridge(apiUrl, token, projectId);
bridge.headless = new HeadlessEditor(process.env.MOTIONILY_WEB ?? "http://localhost:5173", projectId, () => api.headlessSession());

await new Promise((r) => setTimeout(r, 500));
const res = await bridge.applyOps([
  { op: "add_layer", layer: { id: "title", type: "text", text: "Revisión automática", start: 0, end: 4, fill: "text", w: 900, h: 200, size: 110, x: 700, y: 300 } },
  { op: "add_layer", layer: { id: "sub", type: "text", text: "Se solapa con el título", start: 0, end: 4, fill: "primary", w: 800, h: 120, size: 60, x: 640, y: 330 } },
]);
console.log("ops", res.ok, res.error ?? "");
const bad = await bridge.applyOps([{ op: "add_anim", id: "title", anim: { use: "animation/pop_in", at: 0 } }]);
console.log("preset rejected:", !bad.ok, bad.error);
const own = await bridge.applyOps([
  { op: "define_anim", key: "my/rise", template: { keys: { opacity: [[0, 0], [0.4, 1]], dy: [[0, 80, "back"], [0.5, 0]] } } },
  { op: "add_anim", id: "title", anim: { use: "my/rise", at: 0.2 } },
]);
console.log("own anim ok:", own.ok, own.error ?? "");
const r = await bridge.review(8);
console.log(r.review?.issues);
if (r.review) writeFileSync(process.argv[2] ?? "review.jpg", Buffer.from(r.review.sheet.split(",")[1]!, "base64"));
await bridge.headless.close();
process.exit(0);
