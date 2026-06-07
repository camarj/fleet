---
name: a2a-client
description: How the Core speaks A2A (Agent2Agent) to REMOTE agents — connect by URL, stream via SSE, cancel tasks — using @a2a-js/sdk.
triggers:
  - a2a
  - A2AAdapter
  - remote agent
  - agent card
  - sendMessageStream
  - ClientFactory
  - tasks/cancel
  - a2a-js sdk
---

## Purpose

`A2AAdapter` (`packages/core/src/adapters/a2a.ts`) is the Core's client for
**remote** agents. It speaks the open A2A (Agent2Agent) standard over HTTP+SSE
via `@a2a-js/sdk`. The adapter maps all A2A events into the neutral run model
(`neutral.ts`) so the rest of the Core — state machine, Gateway API, frontend —
never sees A2A directly.

## When to use

- Adding or modifying how the Core connects to remote A2A agents
- Debugging agent card discovery, SSE streaming, or task cancellation
- Reading usage metadata off the A2A wire
- Understanding the stream event kinds (`task`, `status-update`, `artifact-update`, `message`)

## Source of truth

Do NOT duplicate SDK API here. Read these directly:
- **SDK reference**: `docs/gateway-clients/sdk-reference.md` — §1 A2A Client
- **Implementation**: `packages/core/src/adapters/a2a.ts`

## The two-protocol boundary

| Protocol | Who speaks it | Direction |
|---|---|---|
| A2A (HTTP+SSE) | `A2AAdapter` ↔ Remote agent | via `@a2a-js/sdk` |
| Gateway API (WebSocket) | Core ↔ Frontend | via `packages/core/src/api.ts` |

The frontend **never** speaks A2A. The Core translates A2A events into neutral
`RunEvent` objects relayed over the Gateway API.

## Connecting to a remote agent

```ts
import { A2AAdapter } from "@inteliside/gateway-core/adapters";

const adapter = await A2AAdapter.connect("https://agent.example.com");
// ClientFactory.createFromUrl() auto-fetches the Agent Card at
// /.well-known/agent-card.json — no manual discovery step.
```

## Starting a run

```ts
const handle = adapter.run(input, options, sink);
// sink.onEvent?.(event)   — called for each neutral RunEvent
// sink.onUsage?.(usage)   — called when usage arrives
// sink.onDone?.(status)   — called when the task reaches a terminal state
await handle.done;
```

## Aborting a run

```ts
await handle.abort();
// → calls client.cancelTask({ id: taskId }) — A2A tasks/cancel
// The run resolves with status "aborted".
```

## Usage metadata

Usage rides on A2A `metadata["inteliside/usage"]` (constant
`A2A_USAGE_METADATA_KEY` from `neutral.ts`). Present on both `Task` and
`Message` events. See `docs/gateway-clients/sdk-reference.md` §1 for the
exact read pattern.

## Stream event kinds (A2A → neutral mapping)

| A2A `event.kind` | Terminal? | How the adapter uses it |
|---|---|---|
| `"task"` | No | Captures `taskId` for potential abort |
| `"artifact-update"` | When `lastChunk` | Extracts text parts → `message.delta` events |
| `"message"` | Yes (no task wrapper) | Extracts text parts → `message.delta`, reads usage |
| `"status-update"` | When `.final === true` | Reads usage; derives `completed`/`aborted` status |

## Closing

```ts
await adapter.close();
// A2A holds no persistent connection — this is a no-op.
```

## References

- `references/a2a-streaming.md` — SSE event loop, cancellation, metadata patterns
- `docs/gateway-clients/sdk-reference.md` §1 — full SDK surface (authoritative)
- `packages/core/src/adapters/a2a.ts` — implementation
- `packages/core/src/neutral.ts` — neutral run model and usage constants
