---
name: flue-client
description: How the Core speaks to a served Flue agent (Astro/Fred Schott, TS) — stream FlueEvents over HTTP (agents.invoke mode:stream), map to neutral RunEvents — using @flue/sdk. Also Flue authoring basics for the converter.
triggers:
  - flue
  - FlueAdapter
  - "@flue/runtime"
  - "@flue/sdk"
  - createFlueClient
  - FlueEvent
  - connectFlue
  - flue agent
  - mcp__ tool naming
  - thinkingLevel
---

## Purpose

`FlueAdapter` (`packages/core/src/adapters/flue.ts`) is the Core's client for
**Flue** agents — a TypeScript agent framework by the Astro team
(`github.com/withastro/flue`, Apache-2.0, `@flue/runtime` **0.10.1**,
EXPERIMENTAL → pin exact). A Flue agent is served over HTTP+WebSocket; the Core
connects by URL via `@flue/sdk`, consumes the granular `FlueEvent` stream, and
maps it to the neutral run model (`neutral.ts`) so the rest of the Core never
sees Flue.

Fleet is **Flue-only** — `FlueAdapter` is the single implementation of the
`AgentAdapter` interface (A2A/ACP were removed). See skill `adapter-interface`.

## When to use

- Adding or modifying `FlueAdapter` / the `connectFlue` path in the Core
- Mapping `FlueEvent` → neutral `RunEvent` (text, thinking, tool, MCP, skill, memory, subagent)
- Deriving `mcp.*` from tool names and `skill.*`/`memory.*` from operation/compaction events
- Authoring or converting a Flue agent (provider/model swap) — see `references/flue-authoring.md`

## Source of truth (verified vs official docs — do NOT invent)

- **Wire + mapping**: `references/flue-wire.md` (FlueEvent union, HTTP/WS API, abort, usage)
- **Authoring + providers**: `references/flue-authoring.md` (createAgent, tools, skills, model specifiers)
- **Official docs**: https://flueframework.com/docs/ · source `github.com/withastro/flue` (`packages/sdk/src/types.ts`)
- **Implementation**: `packages/core/src/adapters/flue.ts`

## CRITICAL facts (verified live in WS0)

- The adapter streams over **HTTP**: `client.agents.invoke(name, id, { mode:"stream",
  payload:{message,session?}, signal })` → `AsyncIterable<AttachedAgentEvent>`. The
  WebSocket path (`client.agents.connect`) FAILED against a built `node` server
  ("Flue WebSocket connection failed") — do NOT use it. The SSE `/runs/<id>/stream`
  is workflow-only.
- **A served Flue agent module MUST export `route` and `websocket` middleware** to be
  routable, else it builds and loads ("Agents: echo") but returns "agent not
  registered". The converter (WS2) must emit both for every agent.
- **MCP tools are namespaced** `mcp__<connection>__<tool>` (double underscore) →
  `isMcpTool()` is deterministic, not a guess.
- **Abort is client-side only** (AbortSignal to invoke). No server-side cancel →
  `RunHandle.abort()` is best-effort.
- Direct agents get **no `run_end`** → terminal = the async iterable completing.
  Usage rides on `turn`/`operation`/`compaction`. `PromptUsage` (confirmed) =
  `{ input, output, cacheRead, cacheWrite, totalTokens, cost{...} }`.

## Two-protocol boundary

| Protocol | Who speaks it | How |
|---|---|---|
| Flue (HTTP + WebSocket) | `FlueAdapter` ↔ served Flue agent | via `@flue/sdk` |
| Gateway API (WebSocket) | Core ↔ Frontend | via `packages/core/src/api.ts` |

The frontend **never** speaks Flue. The Core translates `FlueEvent`s into neutral
`RunEvent`s relayed over the Gateway API.

## Connecting + streaming

```ts
import { createFlueClient } from "@flue/sdk";

const client = createFlueClient({ baseUrl, token });
const controller = new AbortController();
const stream = client.agents.invoke(agentName, instanceId, {
  mode: "stream",
  payload: { message: userMessage },
  signal: controller.signal,
}); // : AsyncIterable<AttachedAgentEvent>
for await (const ev of stream) mapFlueEvent(ev, sink, accum); // → neutral RunEvents
// iterable completes = END OF TURN (no run_end on direct agents)
// → sink.onUsage(accum.total()) → sink.onDone("completed")
// abort: controller.abort() → throws → onDone("aborted")
```

## FlueEvent → neutral RunEvent (the mapping)

| FlueEvent | Neutral `RunEvent` |
|---|---|
| `text_delta` | `message.delta` (assistant) |
| `thinking_start` / `thinking_delta` / `thinking_end` | `thinking.start` / `.delta` / `.end` |
| `tool_start` | `isMcpTool` ? `mcp.call` : `tool.call` |
| `tool_call` | `isMcpTool` ? `mcp.result` : `tool.result` |
| `task_start` / `task` | `subagent.start` / `subagent.end` |
| `operation_*` (kind `skill`) | `skill.start` / `skill.end` |
| `operation` (kind `prompt`) | `accum.add(usage)` |
| `compaction_start` / `compaction` | `memory.start` / `memory.end` (+ usage) |
| `turn` / `operation`(prompt) | `accum.add(usage)` |
| `agent_end` / `idle` | optional "assistant finished" hint |
| terminal | `socket.prompt()` resolves → `message.completed` + `onDone` (NO `run_end` on direct agents) |
| `turn_*`,`message_*`,`log` | no-op |

`OperationKind = 'prompt' | 'skill' | 'task' | 'shell' | 'compact'`.
Keep `mapFlueEvent` pure and exported — it is unit-tested without a socket in
`packages/core/test/flue.test.ts`.

## Aborting a run

```ts
await handle.abort();
// best-effort: socket.close() (and/or AbortController on the operation signal)
// sink.onDone() is called with status "aborted"
// NOTE: the server may keep billing the run — document this limitation.
```

## References

- `references/flue-wire.md` — FlueEvent union, HTTP/WS endpoints, abort, usage, MCP naming
- `references/flue-authoring.md` — createAgent/defineTool/defineAgentProfile/connectMcpServer/skills, model specifiers + providers, CLI/deploy
- `packages/core/src/adapters/flue.ts` — implementation
- `packages/core/src/neutral.ts` — neutral run model + usage constants
- `.claude/skills/adapter-interface/SKILL.md` — the shared `AgentAdapter` contract
