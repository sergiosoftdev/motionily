# Contributing

Thanks for helping. Motionily is MIT licensed and fully open: features land in the open code, with no
paid tier behind flags.

## Setup

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
pnpm install
DATABASE_URL=sqlite:$PWD/data/motionily.db pnpm api   # or MONGO_URI=mongodb://…
pnpm dev
```

Desktop app: `pnpm desktop` (needs the API built once: `pnpm --filter @motionily/api build`).

## Ground rules

- **Every UI action is an op, and every op is an MCP tool.** Whatever a person can do in the editor, an
  agent must be able to do through `packages/mcp-server`, and the other way round.
- **Agent-agnostic.** Nothing may depend on one vendor's agent. In-app runs go through
  `apps/api/src/common/agent-cli.ts`, which has a driver per CLI; a new CLI is a new driver there.
- **Document what the engine does.** A new engine feature ships with its exact behavior (formulas,
  defaults, limits) in `docs/agent`, so agents read it instead of experimenting.
- **Prompts live in `docs/agent/prompts`.** Code only assembles them.
- **No magic strings.** Use enums or `as const` objects and their union types.
- **Both storages.** API changes must pass `pnpm --filter @motionily/api test` (MongoDB) and
  `pnpm --filter @motionily/api test:sqlite`.

## Before a pull request

```bash
pnpm test
pnpm --filter @motionily/api test:sqlite
```

Keep commits focused, with messages in the imperative (`feat(engine): …`, `fix(api): …`).
