# Fleet

The operations center for a fleet of agents — a multiplexer (Orca/cmux-style)
that **connects to** already-deployed agents to consume, configure, and (Phase 2)
orchestrate them. It does not build agents; the Scaffolding (Component 1) does.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the design and
**[CLAUDE.md](./CLAUDE.md)** for the development rules.

## Layout

```
packages/core/    Gateway Core (TS/Node) — the brain
frontend/         React app (shared by desktop + web)
apps/desktop/     Tauri v2 shell (macOS first) — runs the Core as a sidecar
apps/web/         Web delivery (Phase 3 — structure only)
.claude/skills/   Skills that make Claude expert at developing the Gateway
```

The Core reaches agents via **A2A** (remote, HTTP+SSE) or **ACP** (local, stdio
subprocess) and exposes a **Gateway API** (WebSocket) to the frontend. The
frontend never talks to agents directly.

## Prerequisites

- Node ≥ 20 (24 recommended — the Core uses the built-in `node:sqlite`)
- pnpm 9
- For the desktop **build** only: the Rust toolchain (`rustup`).

## Install

```bash
pnpm install
```

## Run (dev)

```bash
# Core (WebSocket server on ws://127.0.0.1:4179)
pnpm core:dev

# Frontend (Vite on http://localhost:1420) — in another terminal
pnpm frontend:dev
```

Open http://localhost:1420. In the Sidebar:

- **A2A (remote):** enter the agent's base URL (`agent.connectA2A`). The Agent
  Card is auto-discovered. See the Scaffolding repo for agent startup instructions.
- **ACP (local):** provide a working directory and start command
  (`agent.launchAcp`). The Core spawns the subprocess automatically.

## Test

```bash
pnpm --filter @inteliside/gateway-core test        # Core + sidecar smoke (fake agent, no API key)
pnpm --filter @inteliside/gateway-core typecheck
pnpm --filter @inteliside/gateway-frontend build
```

## Desktop

See [apps/desktop/README.md](./apps/desktop/README.md). Requires Rust.

```bash
pnpm desktop:dev     # tauri dev (run `pnpm core:dev` alongside it)
```

## Status

Phase 1 (multiplexer). See [ROADMAP.md](./ROADMAP.md).
