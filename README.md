# Fleet

The operations center for a fleet of agents — converts a local Claude Code
project into a deployable **Flue** (TypeScript) agent, deploys it, and connects
to it to consume, configure, and (Phase 2) orchestrate it.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the design and
**[CLAUDE.md](./CLAUDE.md)** for the development rules.

## Layout

```
packages/core/      Gateway Core (TS/Node) — the brain
packages/converter/ Converter — Claude Code project → Flue agent (deterministic, no LLM)
frontend/           React app (shared by desktop + web)
apps/desktop/       Tauri v2 shell (macOS first) — runs the Core as a sidecar
apps/web/           Web delivery (Phase 3 — structure only)
.claude/skills/     Skills that make Claude expert at developing the Gateway
```

The Core converts and deploys agents via the **Flue** protocol, then connects via
`FlueAdapter` and exposes a **Gateway API** (WebSocket) to the frontend. The
frontend never talks to agents directly.

## Prerequisites

- Node ≥ 22.18 (Flue requires it; 24 recommended — the Core uses the built-in `node:sqlite`)
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

Open http://localhost:1420. Use the Sidebar to convert a local Claude Code
project, choose a deploy target (`docker-local`, `fly`, `cloudflare`, or
`github`), and start a session once the agent is deployed.

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

Phase 1 (convert + deploy + connect). See [ROADMAP.md](./ROADMAP.md).
