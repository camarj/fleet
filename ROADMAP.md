# Roadmap

## Phase 1 — Multiplexer (current)

A desktop app (Tauri macOS) operating ONE Scaffolding agent at a time:
Sidebar + Terminal panel + A2A adapter (remote) + ACP adapter (local) +
per-agent config + own state.

- [x] Monorepo scaffold
- [x] Neutral `AgentAdapter` interface + `A2AAdapter` (`@a2a-js/sdk`, remote HTTP+SSE) + `AcpAdapter` (`@agentclientprotocol/sdk`, local stdio) + `foreign/` placeholder
- [x] State in SQLite (`node:sqlite`): agents, configs, sessions, usage
- [x] Pricing (tokens → cost)
- [x] Gateway API + `GatewayCore` + WebSocket server (sidecar)
- [x] Core smoke tests (direct + real sidecar WS) — all green
- [x] Frontend: Sidebar + TerminalPanel (xterm.js) + WorkflowCanvas stub
- [x] Tauri v2 shell scaffold (sidecar wiring, esbuild + Node SEA packaging) — **build needs Rust**
- [x] Skills + references + docs
- [ ] End-to-end against a REAL DeepAgents agent (needs Python env + API key)
- [ ] Tauri build/run validation (needs `rustup`)
- [ ] Persist state to an app-data SQLite file in the desktop build (currently `:memory:` default)

## Phase 2 — Orchestration

- [ ] Workflow canvas (React Flow / `@xyflow/react` 12): nodes, edges, serialization
- [ ] Orchestration engine: run a graph, pass one agent's output to the next
- [ ] Multi-agent sessions

## Phase 3 — Web & Windows delivery

- [ ] `apps/web`: serve the same frontend, connect to the Core over WS
- [ ] Windows Tauri build

## Third-party agents (future extension)

Connect any agent that speaks A2A or ACP — Claude Code, Codex, Gemini CLI, and
others. A2A agents are already supported via `connectA2A`. ACP agents are already
supported via `launchAcp`. The `foreign/` placeholder in `adapters/` covers any
future non-standard agent that needs a custom adapter.

## Known follow-ups

- Docker: reaching an A2A agent inside a container requires knowing its mapped port; no auto-discovery yet.
