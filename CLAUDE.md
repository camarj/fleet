# CLAUDE.md — Gateway development rules

Rules for developing the **Fleet** (Component 2). Short and
non-negotiable. Detail lives in `.claude/skills/` and `ARCHITECTURE.md`.

## What this is

A multiplexer + operations center (Orca/cmux-style) for **Flue** agents. Fleet
**converts** a local Claude Code project into a deployable Flue (TypeScript)
agent (`packages/converter`, `@inteliside/gateway-converter`), **deploys** it
(`packages/core/src/deploy`), and **connects** to it to consume, configure, and
(Phase 2) orchestrate it. Fleet is **Flue-only** — A2A and ACP were removed. See
`ARCHITECTURE.md` for the full picture.

## Non-negotiable rules

1. **The Gateway never talks to an agent directly — only through an adapter.**
   The only adapter is `FlueAdapter` (`packages/core/src/adapters/`), which
   speaks Flue's HTTP+WebSocket API. The `foreign/` directory is a placeholder
   for future non-Flue agents. → skills `adapter-interface`, `flue-client`.
2. **The frontend never connects to an agent.** It always goes through the Core
   over WebSocket (the Gateway API in `packages/core/src/api.ts`). Two distinct
   boundaries: Core↔Agent = Flue; Frontend↔Core = Gateway API.
3. **The neutral run model (`neutral.ts`) is Fleet's own protocol.** `FlueAdapter`
   maps Flue events into neutral `RunEvent`s; the rest of the Core and the
   frontend only ever see those. It carries the full conversation lifecycle —
   thinking, tool, MCP, skill, memory, subagent — to the client.
4. **Never invent Flue wire behavior.** Verify against the installed `@flue/sdk`
   / `@flue/cli` or the `flue-client` skill (`references/flue-wire.md`,
   `flue-authoring.md`). If behavior is unspecified, check there first, then ask.
5. **Four deploy targets** (`packages/core/src/deploy/flue-deployer.ts`):
   `docker-local`, `fly` (Fly.io, needs `FLY_API_TOKEN`), `cloudflare` (Workers,
   needs `CLOUDFLARE_API_TOKEN`), and `github` (push a repo for a self-hosted
   Docker PaaS — Coolify/Dokploy). `local-process` exists for Docker-free tests
   only and is not offered in the UI.
6. **Cloudflare is supported** (the runtime is Flue/TypeScript, which runs on
   Workers). The converter emits a real `wrangler.jsonc`; the deployer runs
   `flue build --target cloudflare` + `wrangler deploy`. Never invent the Flue CF
   wire (DO class/binding names, compat date) — verify against `@flue/cli`.
7. **Abort is best-effort** (Flue: socket close / signal) and surfaces as
   `handle.abort()` on the neutral `RunHandle`.
8. **Secrets only in env vars / a secure store** — never in the frontend or the
   repo. Agent configuration carries env var NAMES, never values.
9. **Don't invent Tauri / xterm.js / React Flow APIs.** Consult the matching
   skill, its `references/`, or the official docs. If it isn't there, ask.
10. **Phase 1 has no orchestration** — `orchestration/` is a skeleton only.

## Skills (load before relevant work)

| Skill | Use when |
| --- | --- |
| `adapter-interface` | The neutral `AgentAdapter` interface and `FlueAdapter` |
| `flue-client` | Working with `FlueAdapter` and the Claude Code→Flue converter — `@flue/sdk`, invoke-stream, mapping |
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
