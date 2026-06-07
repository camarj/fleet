---
name: acp-client
description: How the Core speaks ACP (Agent Client Protocol) to LOCAL agents — spawn as stdio subprocess, session/prompt, session/cancel — using @agentclientprotocol/sdk.
triggers:
  - acp
  - AcpAdapter
  - local agent
  - stdio subprocess
  - session/prompt
  - session/cancel
  - agentclientprotocol sdk
  - ndJsonStream
---

## Purpose

`AcpAdapter` (`packages/core/src/adapters/acp.ts`) is the Core's client for
**local** agents. It speaks ACP (Agent Client Protocol) via
`@agentclientprotocol/sdk`. The Core **SPAWNS** the agent as a subprocess and
communicates over **stdio** using newline-delimited JSON-RPC. No HTTP, no
localhost port.

The adapter maps all ACP callbacks and responses into the neutral run model
(`neutral.ts`), so the rest of the Core never sees ACP.

## When to use

- Adding or modifying how the Core launches and talks to local ACP agents
- Debugging subprocess spawn, initialization handshake, or session lifecycle
- Reading usage metadata off the ACP wire (`_meta["inteliside_usage"]`)
- Understanding `sessionUpdate` callback mapping to neutral RunEvents

## Source of truth

Do NOT duplicate SDK or wire-protocol detail here. Read these directly:
- **SDK reference**: `docs/gateway-clients/sdk-reference.md` — §2 ACP Client
- **Wire spec**: `docs/acp/wire-reference.md`
- **Implementation**: `packages/core/src/adapters/acp.ts`

## CRITICAL: transport is stdio, not HTTP

ACP agents are reached over **stdin/stdout of a subprocess**. The Core spawns
the process; `ndJsonStream()` wraps its stdin/stdout as Web Streams; a
`ClientSideConnection` drives the JSON-RPC protocol.

```
Core (Gateway) ──[spawn]-→ Agent subprocess
                 stdin  ←────────────────────
                 stdout ─────────────────────→
                         (newline-delimited JSON-RPC)
```

There is no HTTP server, no localhost port, no health endpoint. Ignore all
HTTP-style connection patterns from the old Runtime Protocol documentation.

## Two-protocol boundary

| Protocol | Who speaks it | Direction |
|---|---|---|
| ACP (stdio JSON-RPC) | `AcpAdapter` ↔ Local subprocess | via `@agentclientprotocol/sdk` |
| Gateway API (WebSocket) | Core ↔ Frontend | via `packages/core/src/api.ts` |

The frontend **never** speaks ACP. The Core translates ACP updates into neutral
`RunEvent` objects relayed over the Gateway API.

## Launching a local agent

```ts
import { AcpAdapter } from "@inteliside/gateway-core/adapters";

const adapter = await AcpAdapter.launch({
  cwd: "/path/to/agent",
  command: "python",
  args: ["-m", "agent"],
  env: { ANTHROPIC_API_KEY: "..." },
  id: "my-agent",
  name: "My Local Agent",
});
// Under the hood: spawn() → ndJsonStream() → ClientSideConnection → initialize()
```

## Starting a run

```ts
const handle = adapter.run(input, options, sink);
// AcpAdapter.run():
//   1. conn.newSession({ cwd, mcpServers: [] })
//   2. conn.prompt({ sessionId, prompt: [...] })  ← blocks until stopReason
//   Real-time events arrive via the sessionUpdate callback (not inside run())
await handle.done;
```

## Streaming updates (sessionUpdate callback)

Incremental output arrives via the `Client.sessionUpdate()` push callback —
NOT as return values from `prompt()`. The `AcpAdapter` wires this in
`AcpAdapter.launch()` and maps updates to neutral events:

| ACP `update.sessionUpdate` | Neutral event |
|---|---|
| `"agent_message_chunk"` | `message.delta` |
| `"tool_call"` | `tool.call` |
| `"tool_call_update"` (status = completed) | `tool.result` |

See `references/acp-lifecycle.md` and `docs/acp/wire-reference.md` §7 for
the full `session/update` discriminant list.

## Aborting a run

```ts
await handle.abort();
// → conn.cancel({ sessionId }) — ACP session/cancel notification
// The in-flight prompt() resolves with stopReason: "cancelled"
// sink.onDone() is called with status "aborted"
```

## Usage metadata

Usage rides on ACP `PromptResponse._meta["inteliside_usage"]` (constant
`ACP_USAGE_META_KEY` from `neutral.ts`). Present when the agent writes it.
The standard `PromptResponse.usage` field is `@experimental`/UNSTABLE in
v0.25.0 — do not rely on it. See `docs/gateway-clients/sdk-reference.md` §2
"Reading `_meta["inteliside_usage"]`".

## Closing

```ts
await adapter.close();
// Kills the subprocess (SIGTERM), then awaits conn.closed.
```

## Permissions (MVP default)

The Core denies all filesystem/terminal permission requests from the agent:

```ts
async requestPermission(): Promise<acp.RequestPermissionResponse> {
  return { outcome: { outcome: "cancelled" } };
}
```

No ACP agent can read/write the host filesystem or spawn terminals in Phase 1.

## References

- `references/acp-lifecycle.md` — initialize/newSession/prompt/cancel sequence
- `docs/gateway-clients/sdk-reference.md` §2 — full SDK surface (authoritative)
- `docs/acp/wire-reference.md` — ACP wire protocol (authoritative)
- `packages/core/src/adapters/acp.ts` — implementation
- `packages/core/src/neutral.ts` — neutral run model and usage constants
