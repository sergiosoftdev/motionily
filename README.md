<p align="center">
  <img src="docs/readme/banner.png" alt="Motionily: the open-source, agent-first video editor" width="100%" />
</p>

<p align="center">
  <b>Your coding agent builds the motion graphics and edits your footage.<br />
  You watch every change render live on your GPU, and fix anything by hand.</b>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-e5484d?style=flat-square" alt="MIT license" /></a>
  <a href="https://github.com/sergiosoftdev/motionily/releases"><img src="https://img.shields.io/badge/desktop-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-151515?style=flat-square" alt="Desktop: macOS, Windows, Linux" /></a>
  <img src="https://img.shields.io/badge/engine-Rust%20%2B%20wgpu-151515?style=flat-square&logo=rust" alt="Engine: Rust + wgpu" />
  <a href="docs/agents.md"><img src="https://img.shields.io/badge/agents-any%20MCP%20client-151515?style=flat-square" alt="Works with any MCP client" /></a>
</p>

<p align="center">
  <a href="https://instagram.com/motionily"><img src="https://img.shields.io/badge/Instagram-@motionily-E4405F?style=for-the-badge&logo=instagram&logoColor=white" alt="Instagram @motionily" /></a>
  <a href="https://www.tiktok.com/@motionily"><img src="https://img.shields.io/badge/TikTok-@motionily-000000?style=for-the-badge&logo=tiktok&logoColor=white" alt="TikTok @motionily" /></a>
</p>

---

## What it is

**An open-source, agent-first video editor.** Your coding agent (Claude Code, Codex, Gemini CLI,
OpenCode, Cursor, VS Code, Claude Desktop or any MCP client) builds motion graphics and edits your
footage. You watch every change render live on your GPU, edit anything by hand, and leave feedback
pinned to a moment in time. The agent reads that feedback and iterates.

- **Any agent.** Motionily is an MCP server plus an editor. Use the agent you already pay for and
  prefer; inside the app, pick which CLI runs in-app generation (Settings › Coding agent).
- **Runs on your machine.** The desktop app (macOS, Windows, Linux) bundles everything: the editor,
  the API on SQLite, the native GPU engine and ffmpeg. No account, no server, your files stay local.
- **A real engine.** A Rust/wgpu renderer (Metal, DX12, Vulkan, WebGPU, WebGL2): shapes, text,
  vector paths, images, video clips, glTF 3D with skeletons, cameras, particles, custom WGSL shaders,
  post effects. Native export up to 4K in H.264, HEVC 10-bit or ProRes 422 HQ.
- **Built for agents.** Small atomic ops instead of rewriting files, a layout tool that returns where
  every layer lands, a self-review loop that renders contact sheets and flags framing, overlaps and
  dead air, and one manual (`docs/agent`) so the agent never has to guess.

MIT licensed. Everything is open: there are no paid features in the code.

## The editor

One video, three ways to work on it. Switch between them at any time from the top bar.

### Simple: watch it and ask

<p align="center">
  <img src="docs/readme/editor-simple.png" alt="Simple mode: the video preview with a request box pinned to the current moment" width="720" />
</p>

The video, a play bar and one box. Ask for any change for the whole video, for the moment under the
playhead, or for something you click in the frame. The agent picks it up and you watch it change.

### Pro: every layer, every key

<p align="center">
  <img src="docs/readme/editor-pro.png" alt="Pro mode: composition viewer, layer timeline, effect controls and character panel" width="100%" />
</p>

A compositor layout: composition viewer, a layer timeline with blend modes, track mattes and
parenting, effect controls, a graph editor and type settings. Everything the agent built is a normal
layer you can select, retime and tweak.

### Edit: your own footage

<p align="center">
  <img src="docs/readme/editor-edit.png" alt="Edit mode: media bin, multitrack timeline and the agent panel" width="100%" />
</p>

A multitrack editor for the clips you upload: import media, split and trim on the timeline, and ask
for graphics anywhere on top of the cut.

## Quick start

### Desktop app

Download an installer from [Releases](https://github.com/sergiosoftdev/motionily/releases), or build it:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
pnpm install
pnpm --filter @motionily/desktop build     # installers in target/release/bundle/
```

During development, `pnpm desktop` runs the app against the Vite dev server (`pnpm dev`).

### Browser + local API

```bash
pnpm install
DATABASE_URL=sqlite:$PWD/data/motionily.db pnpm api   # API on :3100 (or MONGO_URI for MongoDB)
pnpm dev                                               # engine to WASM + editor on :5173
```

Requirements: Rust with `wasm32-unknown-unknown`, `wasm-bindgen-cli 0.2.129`, Node 22.13+ and pnpm.
ffmpeg on PATH is optional in the browser (the desktop app ships its own).

### Connect your agent

In the editor (or the side navigation) press **Connect your agent** and pick your client: it gives
you the command or the JSON to register the Motionily MCP server. Then ask for the video, for
example `claude "Make a 30 second ad for the app in this folder"`, and keep the editor open to watch
it build. See [docs/agents.md](docs/agents.md) for every client and for in-app generation.

## Architecture

```
 your agent ──MCP (stdio)──▶ packages/mcp-server ──REST/WS──▶ apps/api (NestJS)
                                                               │  MongoDB or one SQLite file
                                                               ▼
                          apps/web (React editor) ◀──WS── live ops, feedback, reviews
                                │
                                ▼
                 crates/engine (Rust/wgpu) as WASM in the editor,
                 native in apps/desktop (playback viewer, 4K export, ffmpeg)
```

| Path | What it is |
| --- | --- |
| `crates/scene` | Scene model and the op set: the single source of truth. Every change, from the agent or the user, is an op applied atomically. |
| `crates/engine` | wgpu renderer, host-agnostic: it gets a surface (or renders headless), a scene and a time. |
| `crates/engine-wasm` | Coarse `wasm-bindgen` API for the browser editor. |
| `apps/web` | React + Tailwind editor (Simple, Pro and Edit modes). React never renders frames. |
| `apps/api` | NestJS API: projects, brand kits, media, feedback, agent runs. Storage is MongoDB, or SQLite through a Mongoose driver (`DATABASE_URL=sqlite:…`). |
| `apps/desktop` | Tauri app: starts the API locally, native Metal viewer, native export through ffmpeg, projects as folders. |
| `packages/mcp-server` | The agent's tools. |
| `packages/protocol` | Editor ↔ server messages. |
| `docs/agent` | The agent manual and every prompt Motionily sends a model. |

## Development

```bash
pnpm test                                   # Rust tests, wasm check, typecheck, API e2e (MongoDB)
pnpm --filter @motionily/api test:sqlite    # the same API suite on SQLite
cargo test -p motionily-desktop             # native export through every codec (needs ffmpeg)
cargo run -p engine --example still -- examples/demo.scene.json 2.5 out.png   # one frame, no window
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the plan in [docs/PLAN.md](docs/PLAN.md).

## Follow along

<p align="center">
  <img src="docs/readme/social.png" alt="Motionily on Instagram and TikTok: @motionily" width="360" />
</p>

<p align="center">
  New features and videos made with Motionily on
  <a href="https://instagram.com/motionily">Instagram</a> and
  <a href="https://www.tiktok.com/@motionily">TikTok</a>: <b>@motionily</b>.
</p>

## License

[MIT](LICENSE). Bundled third-party components (Node.js, ffmpeg, fonts, 3D models) keep their own
licenses: see [THIRD_PARTY.md](THIRD_PARTY.md).
