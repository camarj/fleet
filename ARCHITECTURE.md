# Architecture — Fleet (Component 2)

## What it is (and isn't)

The Gateway is a **multiplexer + operations center** (Orca/cmux-style) for a fleet
of agents. It **connects to** agents that are already built and deployed, to
consume, configure, and (Phase 2) orchestrate them.

It is **not** a CLI, **not** an agent framework, and it does **not** create
agents — the Scaffolding (Component 1) does that. The Gateway reaches every agent through a neutral `AgentAdapter` interface with
two native implementations: **A2AAdapter** for remote agents (Agent2Agent
standard, HTTP+SSE) and **AcpAdapter** for local agents (Agent Client Protocol,
stdio subprocess). Lifecycle nuance: the Gateway MAY launch and supervise a
*local* agent as a subprocess (ACP), but it never creates or edits agent code.

## Two layers, two protocols

```
┌────────────┐   Gateway API (WS)   ┌────────────┐  A2A (HTTP+SSE) or   ┌─────────┐
│  Frontend  │ ───────────────────▶ │    Core    │  ACP (stdio) ──────▶ │  Agent  │
│  (React)   │ ◀─────────────────── │  (TS/Node) │ ◀─────────────────── │ (Python)│
└────────────┘                      └────────────┘                      └─────────┘
```

- **Frontend** (`frontend/`): React, shared across desktop and web. It **never**
  connects to an agent — only to the Core, over WebSocket. It speaks the
  **Gateway API** (`packages/core/src/api.ts`), never A2A or ACP.
- **Core** (`packages/core/`): the brain. Reaches agents via A2A or ACP and
  exposes the Gateway API to the frontend. All connection logic lives here (TS),
  reused verbatim by both the desktop and web deliveries.

Keeping these two boundaries distinct is the central design rule: the frontend is
insulated from A2A and ACP; the Core is the only translator.

## Two orthogonal axes

| Axis | Question | Implementation |
| --- | --- | --- |
| **Adapter** (protocol) | *How* do we invoke this agent? | `adapters/` — `A2AAdapter` (remote, HTTP+SSE, `@a2a-js/sdk`) and `AcpAdapter` (local, stdio subprocess, `@agentclientprotocol/sdk`); `foreign/` is a placeholder for future non-standard agents |
| **Transport** (location) | *Where* is the endpoint? | Implicit in the connection parameters: A2A takes a base URL; ACP takes a working directory + command. |

Adapter and Transport are conceptually orthogonal. The Adapter determines the wire
protocol; location details (URL, path) are resolved before the adapter is created.

## Agent Standards (Core ↔ Agent)

The Core reaches every agent through the neutral `AgentAdapter` interface
(`packages/core/src/adapters/agent-adapter.ts`). Two native implementations:

| Standard | `AgentKind` | Transport | Use when |
| --- | --- | --- | --- |
| **A2A** (`@a2a-js/sdk`) | `"a2a"` | HTTP + SSE | Remote agents — connect by base URL; Agent Card auto-discovered at `/.well-known/agent-card.json` |
| **ACP** (`@agentclientprotocol/sdk`) | `"acp"` | stdio subprocess | Local agents — the Core spawns the process via `child_process.spawn` |

Both adapters map each standard's events into the neutral run model (`neutral.ts`),
so the rest of the Core — state, pricing, the Gateway API, the frontend — stays
protocol-agnostic.

- **Abort:** A2A → `client.cancelTask({ id })`; ACP → `connection.cancel({ sessionId })`. Both surface as `handle.abort()` on the neutral `RunHandle`.
- **Usage:** A2A carries it in `metadata['inteliside/usage']`; ACP in
  `_meta['inteliside_usage']` on `PromptResponse`. Constants in `neutral.ts`.
- **Model overrides:** passed as `RunOptions.model` (neutral specifier + optional
  parameters) into the adapter; each adapter maps it to its standard's wire.
- **Cost:** tokens only on the wire; the Core computes USD from a price table
  keyed by the neutral model specifier (`pricing/`).

Authoritative client references: `docs/gateway-clients/sdk-reference.md` (A2A + ACP
SDK usage) and `docs/acp/wire-reference.md` (ACP wire detail).

## The Gateway API (Frontend ↔ Core)

`packages/core/src/api.ts` — the Core's own WebSocket protocol. Requests:
`agents.list`, `agent.connectA2A` (remote by URL), `agent.launchAcp` (local
subprocess), `session.start`, `session.abort`, `config.set`. Events: `agents`,
`agent.registered`, `session.started/event/usage/done/error`, `error`. The Core
translates `session.start` into the appropriate A2A or ACP call and relays
streamed neutral events back as `session.*` events.

## Endpoint discovery & lifecycle

The Core connects to agents in two ways:

- **launchAcp** (local): the Core spawns the agent as a stdio subprocess
  (`child_process.spawn`) and connects via ACP. Agent identity is resolved during
  the ACP `initialize` handshake — no external manifest file needed.
- **connectA2A** (remote): connect to an already-running A2A agent by its base
  URL. The Agent Card is auto-discovered at `/.well-known/agent-card.json`.

## Per-agent configuration

Changing the model between sessions = `RunOptions.model` (neutral override),
persisted per agent in `configs` (SQLite) and applied on the next `session.start`.
Overriding tools/MCP/prompt is out of the MVP scope.

## State & pricing

`state/db.ts` — the Core's own SQLite store via built-in `node:sqlite` (zero
native build): `agents`, `configs`, `sessions`, `usage`. `pricing/pricing.ts`
turns usage tokens into USD via a configurable price table.

## Desktop (Tauri v2)

`apps/desktop` — the same React frontend in a WebView; the Core runs as a
**sidecar** the shell launches. Frontend ↔ Core is WebSocket, identical to the
web delivery (no connection logic in Rust). The Core is packaged into a single
binary via esbuild + Node SEA (`scripts/build-sidecar.mjs`) because it uses
`node:sqlite`. See the `tauri-shell-sidecar` skill. Building needs the Rust
toolchain.

## Decisions

| # | Decision | Choice |
| --- | --- | --- |
| 1 | Agent wire standards | A2A (`@a2a-js/sdk`) for remote (HTTP+SSE); ACP (`@agentclientprotocol/sdk`) for local (stdio subprocess) |
| 2 | Connection model | A2A and ACP are both native; neutral `AgentAdapter` interface insulates the rest of the Core; `foreign/` placeholder for future non-standard agents |
| 3 | Endpoint/lifecycle | `launchAcp` (Core spawns subprocess) + `connectA2A` (connect to running agent by URL) |
| 4 | Per-agent config | `RunOptions.model` neutral override per session (MVP) |
| 5 | Core on desktop | TS/Node sidecar launched by Tauri; WS to frontend |
| — | SQLite | Built-in `node:sqlite` (better-sqlite3 failed to compile) |

## Module map (`packages/core/src`)

```
adapters/     AgentAdapter interface + A2AAdapter (remote, HTTP+SSE) + AcpAdapter (local, stdio) + foreign/ (placeholder)
state/        SQLite store (node:sqlite)
pricing/      tokens → cost
orchestration/ Phase 2 skeleton
neutral.ts    Neutral run model — events, usage, types (the Core's lingua franca)
api.ts        Gateway API (Frontend ↔ Core) types
core.ts       GatewayCore — wires it all together
server.ts     WebSocket server (the sidecar entrypoint)
```
