# Architecture — Fleet (Component 2)

## What it is (and isn't)

Fleet is a **converter + deployer + operations center** for a fleet of agents.
It converts a local Claude Code project into a deployable **Flue** (TypeScript)
agent, deploys it to a target environment, and then connects to it to consume,
configure, and (Phase 2) orchestrate it.

It is **not** a CLI, **not** an agent framework, and it does **not** run LLMs
inline. The converter (`packages/converter`) is deterministic: no LLM is invoked
during conversion. The Core reaches every deployed agent through `FlueAdapter` —
the only adapter in the system.

## Two layers, one protocol

```
┌────────────┐   Gateway API (WS)   ┌────────────┐  Flue (HTTP+WS)   ┌─────────┐
│  Frontend  │ ───────────────────▶ │    Core    │ ─────────────────▶ │  Agent  │
│  (React)   │ ◀─────────────────── │  (TS/Node) │ ◀───────────────── │ (Flue)  │
└────────────┘                      └────────────┘                    └─────────┘
```

- **Frontend** (`frontend/`): React, shared across desktop and web. It **never**
  connects to an agent — only to the Core, over WebSocket. It speaks the
  **Gateway API** (`packages/core/src/api.ts`), never Flue.
- **Core** (`packages/core/`): the brain. Reaches agents via Flue and exposes the
  Gateway API to the frontend. All connection logic lives here (TS), reused
  verbatim by both the desktop and web deliveries.

Keeping these two boundaries distinct is the central design rule: the frontend is
insulated from Flue; the Core is the only translator.

## The Adapter

| Component | Responsibility |
| --- | --- |
| **FlueAdapter** (`packages/core/src/adapters/flue.ts`) | Speaks Flue's HTTP+WebSocket API; maps Flue events into the neutral run model |
| **neutral.ts** (`packages/core/src/neutral.ts`) | Fleet's own protocol — carries the full conversation lifecycle: thinking, tool, MCP, skill, memory, subagent |

`FlueAdapter` is the only adapter in the system. It connects to a deployed Flue
agent by its base URL and maps each Flue event into a neutral `RunEvent`, so the
rest of the Core — state, pricing, the Gateway API, the frontend — stays
agent-agnostic.

- **Abort:** `handle.abort()` on the neutral `RunHandle`, translated by the adapter to Flue's cancellation wire.
- **Usage:** carried in Flue event metadata; constants in `neutral.ts`.
- **Model overrides:** passed as `RunOptions.model` (neutral specifier) into the adapter; the adapter maps it to Flue's wire.
- **Cost:** tokens only on the wire; the Core computes USD from a price table keyed by the neutral model specifier (`pricing/`).

## The Converter

`packages/converter` (`@inteliside/gateway-converter`) — converts a local Claude
Code project into a deployable Flue (TypeScript) agent. It is:

- **Deterministic** — no LLM is invoked; the same input always produces the same output.
- **Multi-provider** — provider and model are chosen at convert time; the output is not locked to Anthropic.

The converter is a separate tool from the Core; the Core calls it as a library to
drive the convert → deploy → connect flow.

## Deploy targets

`packages/core/src/deploy/flue-deployer.ts` manages five production-ready deploy
targets:

| Target | Description | Requirement |
| --- | --- | --- |
| `docker-local` | Build and run a local Docker container | Docker installed |
| `fly` | Deploy to Fly.io | `FLY_API_TOKEN` env var |
| `cloudflare` | Deploy to Cloudflare Workers | `CLOUDFLARE_API_TOKEN` env var |
| `github` | Push a Git repo with its Dockerfile — user self-deploys on Coolify/Dokploy | Git + remote repo |
| `dokploy` | Deploy to a self-hosted Dokploy instance via its REST API | `DOKPLOY_URL` + `DOKPLOY_API_KEY` env vars |

A `local-process` target also exists for Docker-free tests; it is **not** offered
in the UI and is not considered a production deploy path.

## The Gateway API (Frontend ↔ Core)

`packages/core/src/api.ts` — the Core's own WebSocket protocol. Requests:
`agents.list`, `agent.connect` (by URL after deploy), `session.start`,
`session.abort`, `config.set`. Events: `agents`, `agent.registered`,
`session.started/event/usage/done/error`, `error`. The Core translates
`session.start` into a Flue invocation and relays streamed neutral events back as
`session.*` events.

## Endpoint lifecycle

After the converter produces a Flue agent and the deployer pushes it to a target,
the Core registers the agent's URL and creates a `FlueAdapter` for it. On
`session.start`, the adapter opens a streaming connection to the agent and maps
events into the neutral run model.

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
| 1 | Agent wire standard | Flue (HTTP+WebSocket); `FlueAdapter` is the only adapter |
| 2 | Connection model | Neutral `AgentAdapter` interface with `FlueAdapter` |
| 3 | Convert → Deploy → Connect | Converter produces Flue agent; deployer pushes to target; Core registers and connects |
| 4 | Deploy targets | `docker-local`, `fly`, `cloudflare`, `github`, `dokploy`; `local-process` for tests only |
| 5 | Per-agent config | `RunOptions.model` neutral override per session (MVP) |
| 6 | Core on desktop | TS/Node sidecar launched by Tauri; WS to frontend |
| — | SQLite | Built-in `node:sqlite` (better-sqlite3 failed to compile) |

## Module map (`packages/core/src`)

```
adapters/      AgentAdapter interface + FlueAdapter (HTTP+WebSocket)
deploy/        flue-deployer.ts — docker-local / fly / cloudflare / github / dokploy targets
state/         SQLite store (node:sqlite)
pricing/       tokens → cost
orchestration/ Phase 2 skeleton
neutral.ts     Neutral run model — events, usage, types (Fleet's lingua franca)
api.ts         Gateway API (Frontend ↔ Core) types
core.ts        GatewayCore — wires it all together
server.ts      WebSocket server (the sidecar entrypoint)
```
