# Roadmap

## Phase 1 — Convert → Deploy → Connect (current)

A desktop app (Tauri macOS) operating ONE Flue agent at a time:
Converter + deployer (four targets) + `FlueAdapter` + Sidebar + Terminal panel +
per-agent config + own state.

- [x] Monorepo scaffold
- [x] Neutral `AgentAdapter` interface + `FlueAdapter` (`packages/core/src/adapters/flue.ts`, HTTP+WebSocket)
- [x] Converter: `packages/converter` (`@inteliside/gateway-converter`) — deterministic, multi-provider
- [x] Deploy targets: `docker-local`, `fly`, `cloudflare`, `github` (`packages/core/src/deploy/flue-deployer.ts`)
- [x] State in SQLite (`node:sqlite`): agents, configs, sessions, usage
- [x] Pricing (tokens → cost)
- [x] Gateway API + `GatewayCore` + WebSocket server (sidecar)
- [x] Core smoke tests (direct + real sidecar WS) — all green
- [x] Frontend: Sidebar + TerminalPanel (xterm.js) + WorkflowCanvas stub
- [x] Tauri v2 shell scaffold (sidecar wiring, esbuild + Node SEA packaging) — **build needs Rust**
- [x] Skills + references + docs
- [ ] End-to-end against a REAL Flue agent (needs a deployed agent + API key)
- [ ] Tauri build/run validation (needs `rustup`)
- [ ] Persist state to an app-data SQLite file in the desktop build (currently `:memory:` default)

## Phase 2 — Orchestration

- [ ] Workflow canvas (React Flow / `@xyflow/react` 12): nodes, edges, serialization
- [ ] Orchestration engine: run a graph, pass one agent's output to the next
- [ ] Multi-agent sessions

## Phase 3 — Web & Windows delivery

- [ ] `apps/web`: serve the same frontend, connect to the Core over WS
- [ ] Windows Tauri build
