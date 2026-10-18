# Motionily

**Agent-first motion graphics editor.** Claude creates the video through MCP;
you watch it render live on the GPU, pick a visual style and a caption style,
and leave feedback pinned to a moment in time. The agent reads that feedback
and iterates.

Runs in the browser (WebGPU, WebGL2 fallback). Desktop builds (Tauri) come next,
reusing the same web app.

## Architecture

```
 Claude ──MCP (stdio)──▶ mcp-server ──WebSocket──▶ editor (React)
                         │ persists project        │
                         │ queues feedback ◀───────┤ style / captions / comments
                                                   ▼
                                       engine (Rust → WASM, wgpu)
                                       validates ops, renders frames
```

- **`crates/scene`** — scene model and the op set. The single source of truth.
  Every change, from the agent or the user, is an `Op` applied atomically.
- **`crates/engine`** — wgpu renderer. Instanced SDF shapes (rounded rects,
  ellipses) with analytic antialiasing in WGSL. Host-agnostic: it only gets a
  surface, a scene and a time.
- **`crates/engine-wasm`** — coarse `wasm-bindgen` API (`loadScene`,
  `applyOps`, `render(t)`) so JS↔WASM crossings stay cheap.
- **`apps/web`** — React + Tailwind editor. React never renders frames; the
  playback loop lives outside it.
- **`packages/mcp-server`** — the agent's tools.
- **`packages/protocol`** — editor ↔ server messages.

### Why it is cheap in tokens

- The agent edits with small ops (`set_prop`, `add_layer`…), never by
  rewriting the scene.
- `get_scene` returns a one-line-per-layer summary; the full JSON only on demand.
- Colors are palette slots (`primary`, `accent`…): the user's style choice
  recolors everything without the agent restating a single color.
- The format reference is fetched once (`get_reference`), not repeated in every
  tool description.

## API (apps/api)

NestJS + Mongo. Projects are **Lego builds**: every slot (motion style, palette,
composition, typography, render style, captions, scenario, characters,
animations, transitions) holds a brick from the store. Picking a motion style
opens its "box" and snaps default bricks into every slot. See `docs/PLAN.md`.

| Route | |
| --- | --- |
| `POST /auth/mock-google` | Simulated Google sign-in, returns a JWT |
| `GET /bricks?slot=&fits=&q=` | Public brick store |
| `POST /projects` | New project from a motion style box |
| `PUT /projects/:id/build/:slot` | Snap bricks into a slot (`applyKitDefaults` to re-open a box) |
| `PUT /projects/:id/scene` | Save the scene (optimistic `baseRevision`) |
| `POST /projects/:id/bricks` | Agent-made private brick |
| `POST /projects/:id/feedback/consume` | Agent reads pending feedback |

The catalog lives in `apps/api/src/bricks/seed/catalog.ts` and is upserted on boot.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `get_project` | Brief, the bricks the user chose per slot, scene state (start here) |
| `get_reference` | Scene format and op list (read once) |
| `list_bricks` / `get_brick` | Brick catalog for this project, compact or full |
| `get_scene` | Compact summary, or full JSON with `full=true` |
| `apply_ops` | Atomic batch of edits, rendered live in the editor; returns the new summary |
| `load_scene` | First cut from scratch |
| `create_brick` | Save a missing brick (e.g. animation) as private to the project |
| `get_feedback` | Comments and brick swaps since the last call |

Connect: in the editor press **Conectar agente** and paste the command. It registers
the server in Claude Code with a token scoped to that project (it cannot swap bricks
or delete the project).

## Getting started

Requirements: Rust (with `wasm32-unknown-unknown`), `wasm-bindgen-cli 0.2.129`, Node 22+, pnpm.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
pnpm install
brew services start mongodb-community   # local mongod on :27017
pnpm api            # API on :3100
pnpm dev            # builds the engine to WASM and opens the editor on :5173
```

Sign in, open a project, press **Conectar agente**, paste the command, then ask
Claude Code for the video and watch the editor.

```bash
pnpm test                                     # Rust tests + typecheck
pnpm --filter @motionily/mcp-server smoke     # end-to-end through MCP (editor open)
```

## Roadmap

1. ~~Engine: shapes, keyframes, easing, styles; MCP loop with feedback~~
2. Text layers (cosmic-text + GPU glyph atlas) and caption rendering per style
3. Auto captions: Whisper in the browser, word timestamps, keyword emphasis
4. Video/audio clips (WebCodecs), MP4 export (WebCodecs + muxer)
5. Engine in a Web Worker (OffscreenCanvas), frame previews for the agent
6. Tauri desktop app (Windows, macOS), cloud rendering
