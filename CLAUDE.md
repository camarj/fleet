# CLAUDE.md — Gateway development rules

Rules for developing the **Fleet** (Component 2). Short and
non-negotiable. Detail lives in `.claude/skills/` and `ARCHITECTURE.md`.

## What this is

A multiplexer + operations center (Orca/cmux-style) that **connects to** already
deployed agents to consume, configure, and (Phase 2) orchestrate them. The
**Core never creates agents**. The repo additionally hosts a **converter**
workspace (`packages/converter`, `@inteliside/gateway-converter`) that turns a
Claude Code project into a deployable **Flue** (TypeScript) agent — that is a
separate tool, not the Core. See `ARCHITECTURE.md` for the full picture.

## Non-negotiable rules

1. **The Gateway never talks to an agent directly — only through an adapter.**
   Use `A2AAdapter` for remote agents, `AcpAdapter` for local agents, and
   `FlueAdapter` for served Flue agents (`packages/core/src/adapters/`). The
   `foreign/` directory is a placeholder for future non-standard agents.
   → skills `adapter-interface`, `flue-client`.
2. **The frontend never connects to an agent.** It always goes through the Core
   over WebSocket (the Gateway API in `packages/core/src/api.ts`). Two distinct
   boundaries: Core↔Agent = A2A (remote) or ACP (local); Frontend↔Core = Gateway API.
3. **Adapter (protocol) and Transport (location) are orthogonal.** Don't mix
   their logic. The Adapter determines the wire protocol; location details (URL
   or subprocess path) are resolved before the adapter is created.
4. **Never invent A2A or ACP wire behavior.** The authoritative references are
   `docs/gateway-clients/sdk-reference.md` (A2A + ACP client usage) and
   `docs/acp/wire-reference.md` (ACP wire). If behavior is unspecified, check
   there first, then ask.
5. **ACP agents communicate over stdio (subprocess); A2A agents over HTTP+SSE.**
   Don't mix up the two wire models.
6. **Cloudflare is a supported deploy target** (since the agent runtime is now
   Flue/TypeScript, which runs on Workers). The converter emits a real
   `wrangler.jsonc` and the deployer's `cloudflare` target runs
   `flue build --target cloudflare` + `wrangler deploy`. Never invent the Flue CF
   wire (DO class/binding names, compat date) — verify against `@flue/cli` or the
   `flue-client` skill. `wrangler deploy` needs `CLOUDFLARE_API_TOKEN`.
7. **Abort is per-standard.** A2A: `client.cancelTask({ id })`. ACP:
   `connection.cancel({ sessionId })`. Both surface as `handle.abort()` on the
   neutral `RunHandle`.
8. **Secrets only in env vars / a secure store** — never in the frontend or the
   repo. Agent configuration carries env var NAMES, never values.
9. **Don't invent Tauri / xterm.js / React Flow APIs.** Consult the matching
   skill, its `references/`, or the official docs. If it isn't there, ask.
10. **Phase 1 has no orchestration** — `orchestration/` is a skeleton only.

## Skills (load before relevant work)

| Skill | Use when |
| --- | --- |
| `a2a-client` | Working with `A2AAdapter` — `@a2a-js/sdk`, streaming, cancellation |
| `acp-client` | Working with `AcpAdapter` — `@agentclientprotocol/sdk`, subprocess, session lifecycle |
| `adapter-interface` | The neutral `AgentAdapter` interface and its implementations |
| `flue-client` | Working with `FlueAdapter` and the Claude Code→Flue converter — `@flue/sdk`, invoke-stream, mapping |
| `transport-local-docker` | Reaching A2A agents by location (local/docker mapped port) |
| `xterm-terminal` | The terminal panel (xterm.js) |
| `react-flow-canvas` | The workflow canvas (Phase 2) |
| `tauri-shell-sidecar` | Desktop shell, sidecar packaging, builds |

## Stack

pnpm monorepo · `packages/core` (TS/Node, the brain) · `packages/converter`
(Claude Code → Flue agent emitter, deterministic, no LLM) · `frontend` (React 19 +
Vite) · `apps/desktop` (Tauri v2, macOS first) · `apps/web` (Phase 3). SQLite via
built-in `node:sqlite`. Node ≥ 22.18 (Flue requires it; 24 recommended).

## Verify before claiming done

`pnpm --filter @inteliside/gateway-core test` (Core smoke + sidecar smoke),
`pnpm --filter @inteliside/gateway-core typecheck`,
`pnpm --filter @inteliside/gateway-frontend build`.
