/** Place a few library sounds on the timeline through the bridge (like add_sfx does). */
import { EditorBridge } from "../src/bridge.js";
import { ProjectApi } from "../src/api.js";

const apiUrl = process.env.MOTIONILY_API ?? "http://localhost:3100";
const api = new ProjectApi(apiUrl, process.env.MOTIONILY_TOKEN!, process.env.MOTIONILY_PROJECT!);
const bridge = new EditorBridge(apiUrl, process.env.MOTIONILY_TOKEN!, process.env.MOTIONILY_PROJECT!);
await new Promise((r) => setTimeout(r, 800));
const lib = new Map((await api.sounds()).map((s) => [s.name, s]));
const cue = (id: string, name: string, at: number) => ({ op: "put_sfx", cue: { id, sound: name, src: lib.get(name)!.url, at, gain: 0.7 } });
const res = await bridge.applyOps([cue("s1", "whoosh_fast", 0.4), cue("s2", "pop", 0.9), cue("s3", "impact", 1.6), cue("s4", "ding", 3)] as never);
console.log("sfx", lib.size, res.ok, res.error ?? "");
process.exit(0);
