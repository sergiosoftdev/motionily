/** Two grouped pieces (hook + dashboard) to try group selection and editing in the editor. */
import { EditorBridge } from "../src/bridge.js";

const bridge = new EditorBridge(process.env.MOTIONILY_API ?? "http://localhost:3100", process.env.MOTIONILY_TOKEN!, process.env.MOTIONILY_PROJECT!);
await new Promise((r) => setTimeout(r, 800));
const card = (id: string, x: number, y: number, w: number, h: number, fill: string, start: number) => ({
  op: "add_layer",
  layer: { id, group: "dashboard", type: "shape", shape: "rect", x, y, w, h, radius: 24, fill, start, end: 6, opacity: [{ t: 0, v: 0 }, { t: 0.4, v: 1 }] },
});
const res = await bridge.applyOps([
  { op: "set_palette", palette: { background: "#0f172a", surface: "#1e293b", primary: "#22c55e", accent: "#f59e0b", text: "#f8fafc" } },
  { op: "add_layer", layer: { id: "hook", group: "hook", type: "text", text: "Tus números, claros", x: 540, y: 360, w: 900, h: 200, size: 96, fill: "text", start: 0, end: 6 } },
  card("panel", 540, 1060, 900, 760, "surface", 0.6),
  card("chart", 540, 980, 760, 380, "background", 0.9),
  card("kpi1", 330, 1300, 340, 160, "primary", 1.1),
  card("kpi2", 750, 1300, 340, 160, "accent", 1.3),
]);
console.log("ops", res.ok, res.error ?? "");
process.exit(0);
