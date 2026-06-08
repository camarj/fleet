# Flue wire reference (for FlueAdapter)

Verified against flueframework.com/docs and `github.com/withastro/flue`
(`packages/sdk/src/types.ts`, `packages/sdk/src/client.ts`). Flue is
EXPERIMENTAL (`@flue/runtime` 0.10.1 as of 2026-06-08) — APIs may break; pin exact versions.

## HTTP + WebSocket surface

A served Flue agent (Hono app via `@flue/runtime/routing`) exposes:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/agents/:name/:id` | Send a message to an agent instance. Body `{ message, session? }` |
| `GET` (WS) | `/agents/:name/:id` | WebSocket — stream agent activity (the granular `FlueEvent`s) |
| `POST` | `/workflows/:name` | Invoke a workflow |
| `GET` (WS) | `/workflows/:name` | WebSocket — live workflow activity |
| `GET` | `/runs/:runId` | Inspect a completed run record |

Serve in dev with `flue dev` (port not documented — discover at runtime).
There is **no documented SSE `/runs/<id>/stream`** wire; the streaming surface is
the agent WebSocket above. Do not build against an SSE frame format.

## @flue/sdk client (verified from installed 0.10.1 `index.d.mts`)

`createFlueClient(opts)` exports only `createFlueClient`, `FlueApiError`, `FlueSocketError`.
`opts: { baseUrl, token?, headers?, fetch?, adminBasePath?='/admin', websocket?, websocketUrl? }`.

```ts
import { createFlueClient } from "@flue/sdk";
const client = createFlueClient({ baseUrl: "http://localhost:PORT", token });

// THE adapter path — reusable WebSocket to a persistent agent instance:
const socket = client.agents.connect(name, id);          // : AgentSocket
await socket.ready;                                       // server accepted connection
const unsub = socket.onEvent((ev, ctx) => { /* map ev */ });  // ev: AttachedAgentEvent
const { result } = await socket.prompt(message, { session }); // resolves at END OF TURN
socket.close(code?, reason?);                            // closes + rejects pending work

// Other client surfaces (NOT the adapter path):
// client.agents.invoke(name, id, { mode:'stream'|'sync', payload:{message,session?}, signal? })
// client.runs.{get,events,stream}(runId, …)  ← WORKFLOW runs only (SSE). NOT direct agents.
// client.admin.agents.list() → { items: AgentManifestEntry[{name,transports,created}] }
```

### THE adapter path = HTTP invoke-stream (verified live in WS0)

Use `client.agents.invoke(name, id, { mode:"stream", payload, signal })` →
`AsyncIterable<AttachedAgentEvent>`, iterated with `for await`. The WebSocket path
(`client.agents.connect`) **FAILED** against a built `node dist/server.mjs`
("Flue WebSocket connection failed") — avoid it. `agents.invoke` streams over HTTP and
is proven working.

### Agent must export route + websocket to be routable (WS0 finding)

A built Flue agent is registered into `manifest.agents` (logs "Agents: <name>") but only
gets HTTP/WebSocket route handlers if its module **exports `route` and `websocket`**
pass-through middleware. Without them: "Agent <name> is not registered" / "Available
agents: (none)". The converter (WS2) must emit:
```ts
export const route: AgentRouteHandler = async (_c, next) => { await next(); };
export const websocket: AgentWebSocketHandler = async (_c, next) => { await next(); };
```

### CRITICAL — direct agent events are NOT runs

The stream delivers **`AttachedAgentEvent` = `Exclude<FlueEvent, run_start|run_resume|run_end>`**
(plus `instanceId`, no `runId`). So **the adapter never sees `run_end`** — that exists only for
workflow runs. **Terminal signal = the async iterable completing.** `agent_end { messages }`
and `idle` DO arrive and can mark "assistant finished", but the authoritative done is the
iterable exhausting. Live event order (echo): operation_start → agent_start → turn_start →
turn_request → message_start → message_update… → text_delta… → message_end → turn_end →
turn(usage) → agent_end → operation(usage) → idle.

## FlueEvent discriminated union (verbatim from installed 0.10.1 `index.d.mts`)

Each event also carries optional `runId?, instanceId?, dispatchId?, eventIndex?,
timestamp?, session?, parentSession?, taskId?, harness?, operationId?, turnId?`.
Events marked ✗ are EXCLUDED from `AttachedAgentEvent` (the adapter's direct path).

```
✗ run_start    { runId, owner, instanceId, workflowName, startedAt, payload }
✗ run_resume   { runId, owner, instanceId, workflowName, startedAt }
  agent_start  { }
  agent_end    { messages: unknown[] }
  turn_start   { turnId, purpose }
  turn_request { turnId, purpose, model, provider, api, input{systemPrompt?,messages,tools?}, reasoning? }
  turn_end     { turnId, purpose, message, toolResults }
  turn         { turnId, purpose, durationMs, model?, provider?, api?, output?, usage?, stopReason?, isError, error? }
  message_start  { message }
  message_update { message, assistantMessageEvent }
  message_end    { message }
  text_delta   { text }
  thinking_start { }
  thinking_delta { delta }
  thinking_end   { content }
  tool_start   { toolName, toolCallId, args? }
  tool_call    { toolName, toolCallId, isError, result?, durationMs }
  task_start   { taskId, prompt, agent?, cwd? }
  task         { taskId, agent?, isError, result?, durationMs }
  compaction_start { reason: 'threshold'|'overflow'|'manual', estimatedTokens }
  compaction   { messagesBefore, messagesAfter, durationMs, usage? }
  operation_start { operationId, operationKind }
  operation    { operationId, operationKind, durationMs, isError, error?, result?, usage? }
  log          { level: 'info'|'warn'|'error', message, attributes? }
  idle         { }
✗ run_end      { runId, result?, isError, error?, durationMs }
```

`OperationKind = 'prompt' | 'skill' | 'task' | 'shell' | 'compact'`.
`LlmTurnPurpose = 'agent' | 'compaction' | 'compaction_prefix'`.

## MCP tool naming (deterministic)

When `connectMcpServer('inventory', …)` adapts an MCP server, each tool's
model-facing name becomes `mcp__inventory__<tool>` — prefix `mcp__`, the
connection name, `__`, then the original tool name.

```ts
function isMcpTool(toolName: string): { isMcp: boolean; server?: string; name?: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);   // connection names are unlikely to contain "__"
  return m ? { isMcp: true, server: m[1], name: m[2] } : { isMcp: false };
}
```

## Usage / tokens (PromptUsage — full shape known)

```ts
interface PromptUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

Usage rides on `turn.usage`, `operation.usage`, and `compaction.usage`. Aggregate
across them (each operation/turn may include multiple model turns — do not double-count;
prefer `turn` events or `operation`(kind `prompt`)). Map to neutral usage:
`inputTokens = input`, `outputTokens = output`, `totalTokens = totalTokens`, plus `cost.total`.
Track `model`/`provider` from `turn`/`turn_request`.

## Abort / cancel

`AgentSocket` exposes only `close(code?, reason?)` ("closes the connection and
rejects pending work"). There is NO server-side cancel. So `RunHandle.abort()` =
`socket.close()` → the in-flight `prompt()` promise rejects → report `aborted`.
Best-effort: the agent process may keep running/billing server-side. Document it.

## Open items to confirm live (WS0 probe — types already authoritative)

- Whether `socket.close()` stops the run server-side or only stops local consumption
  (defines the real scope of `abort()`).
- MCP tool naming in practice (`mcp__conn__tool`) by invoking a real MCP-backed tool.
- Whether `agent_end`/`idle` reliably precede `prompt()` resolution (ordering).
