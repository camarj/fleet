# Gateway Client SDK Reference

Verified against published packages:
- `@a2a-js/sdk` v1.0.0-alpha.0 (npm, [GitHub](https://github.com/a2aproject/a2a-js)) — proto-based 1.x generation; Agent Card declares transports via `supported_interfaces[].protocol_binding` (old `preferredTransport`/`additionalInterfaces` fields are gone)
- `@agentclientprotocol/sdk` v0.25.0 (npm, [GitHub](https://github.com/agentclientprotocol/typescript-sdk))

---

## 1. A2A Client — `@a2a-js/sdk`

> **Breaking change from 0.x.** v1.0.0-alpha.0 is the proto-based generation of the A2A spec. Types, enums, and the streaming event shape are completely different. Code written against 0.3.13 will not compile.

### Install

```bash
npm install @a2a-js/sdk@1.0.0-alpha.0
```

Node.js engine: **>= 18** (declared in `engines`). Native `fetch` is used; no polyfill required.

### Key Exports

Enums and types come from `@a2a-js/sdk`; the client factory comes from the `@a2a-js/sdk/client` sub-path:

```typescript
// Enums — runtime values, needed in code (not just at compile time)
import {
  Role,      // Role.ROLE_USER, Role.ROLE_AGENT
  TaskState, // TaskState.TASK_STATE_COMPLETED (3), TASK_STATE_FAILED (4),
             //            TASK_STATE_CANCELED (5), TASK_STATE_REJECTED (7)
} from '@a2a-js/sdk';

// Types — compile-time only
import type {
  SendMessageRequest,
  StreamResponse,
  Message,
  Part,
  CancelTaskRequest,
  Task,
  Artifact,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';

// Client factory — separate sub-path
import { ClientFactory, type Client } from '@a2a-js/sdk/client';
```

### Agent Card Discovery

`new ClientFactory().createFromUrl(baseUrl)` fetches the Agent Card from `${baseUrl}/.well-known/agent-card.json`, reads `supported_interfaces[].protocol_binding` to select a transport, and returns a `Client`. The default factory already registers JSONRPC and REST transports — no options are required for typical use.

```typescript
const factory = new ClientFactory();
const client = await factory.createFromUrl('http://agent-host:4000');
```

**Important:** the alpha `Client` has **no `getAgentCard()` method**. To read card metadata, fetch it yourself via HTTP:

```typescript
async function fetchCardInfo(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, '');
  const url = base.endsWith('.json') ? base : `${base}/.well-known/agent-card.json`;
  const res = await fetch(url);
  const card = await res.json() as { name?: string; version?: string; description?: string };
  return {
    name: card.name ?? 'agent',
    version: card.version ?? '0.0.0',
    description: card.description ?? '',
  };
}
```

### `ClientFactory` API

```typescript
class ClientFactory {
  constructor(options?: ClientFactoryOptions)
  createFromUrl(baseUrl: string): Promise<Client>
}
```

The default constructor (no options) registers JSONRPC and REST transports and correctly interprets `supported_interfaces[].protocol_binding` from the Agent Card.

### `Client` API (returned by factory)

Confirmed methods in v1.0.0-alpha.0:

```typescript
class Client {
  // Send a message and stream real-time responses
  sendMessageStream(request: SendMessageRequest): AsyncIterable<StreamResponse>

  // Cancel a running task
  cancelTask(request: CancelTaskRequest): Promise<unknown>
}
```

`sendMessage` (non-streaming), `getTask`, `resubscribeTask`, `getAgentCard`, and push-notification methods are **not confirmed available** in this alpha — do not call them.

### `SendMessageRequest` Shape

The 1.x proto-based types use proto oneof shapes (`$case`/`value` pairs) — not the old plain-union `kind` fields:

```typescript
import { Role } from '@a2a-js/sdk';
import type { SendMessageRequest, Message, Part } from '@a2a-js/sdk';

// Part — note proto oneof shape, NOT { kind: 'text', text: '...' }
const part: Part = {
  content: { $case: 'text', value: 'Hello agent' },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
};

// Message — role is an enum, not the string 'user'
const message: Message = {
  messageId: 'msg_' + Math.random().toString(36).slice(2, 14),
  contextId: '',
  taskId: '',
  role: Role.ROLE_USER,
  parts: [part],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
};

// Request wrapper — tenant and metadata are required fields
const request: SendMessageRequest = {
  tenant: '',
  message,
  configuration: undefined,
  metadata: undefined,
};
```

### Streaming — Event Loop

Each item from the stream is a `StreamResponse`. Dispatch on `resp.payload.$case` (not `event.kind`):

```typescript
import { TaskState } from '@a2a-js/sdk';

const factory = new ClientFactory();
const client = await factory.createFromUrl('http://agent-host:4000');

for await (const resp of client.sendMessageStream(request)) {
  const payload = resp.payload;
  if (!payload) continue;

  switch (payload.$case) {
    case 'task':
      // payload.value is a Task — first event, gives you the taskId
      console.log('task id:', payload.value.id);
      break;

    case 'message':
      // payload.value is a Message — direct response (no task wrapper)
      for (const p of payload.value.parts) {
        if (p.content?.$case === 'text') console.log(p.content.value);
      }
      break;

    case 'artifactUpdate':
      // payload.value is a TaskArtifactUpdateEvent
      for (const p of payload.value.artifact?.parts ?? []) {
        if (p.content?.$case === 'text') console.log(p.content.value);
      }
      break;

    case 'statusUpdate': {
      // payload.value is a TaskStatusUpdateEvent
      // There is NO .final boolean — finality is determined by TaskState value
      const state = payload.value.status?.state;
      if (state === TaskState.TASK_STATE_COMPLETED) console.log('done');
      else if (state === TaskState.TASK_STATE_FAILED)   console.log('failed');
      else if (state === TaskState.TASK_STATE_CANCELED) console.log('canceled');
      else if (state === TaskState.TASK_STATE_REJECTED) console.log('rejected');
      break;
    }
  }
}
```

### Reading `metadata["inteliside/usage"]`

The usage key is `"inteliside/usage"` (slash, unchanged from 0.x). It appears on `metadata` fields at several locations depending on which payload case arrives:

```typescript
// 'message' payload
const usage = payload.value.metadata?.['inteliside/usage'];

// 'statusUpdate' payload — check both locations
const usage =
  payload.value.metadata?.['inteliside/usage'] ??
  payload.value.status?.message?.metadata?.['inteliside/usage'];

// 'artifactUpdate' payload — check both locations
const usage =
  payload.value.metadata?.['inteliside/usage'] ??
  payload.value.artifact?.metadata?.['inteliside/usage'];

// 'task' payload
const usage = payload.value.status?.message?.metadata?.['inteliside/usage'];
```

### Cancellation

The `CancelTaskRequest` shape changed in 1.x — `tenant` and `metadata` are now required fields:

```typescript
import type { CancelTaskRequest } from '@a2a-js/sdk';

// 1.x shape — tenant and metadata are required
const cancel: CancelTaskRequest = { tenant: '', id: taskId, metadata: undefined };
await client.cancelTask(cancel);

// 0.x shape — will NOT compile against 1.x types
// await client.cancelTask({ id: taskId }); ← broken
```

### `StreamResponse` Payload Summary

| `payload.$case`     | `payload.value` type        | Terminal?                                                                                           |
|---------------------|-----------------------------|-----------------------------------------------------------------------------------------------------|
| `"task"`            | `Task`                      | No — initial task object                                                                            |
| `"message"`         | `Message`                   | Yes — direct response (no task wrapper)                                                             |
| `"artifactUpdate"`  | `TaskArtifactUpdateEvent`   | No                                                                                                  |
| `"statusUpdate"`    | `TaskStatusUpdateEvent`     | When `status.state` is a terminal `TaskState`: `TASK_STATE_COMPLETED`=3, `TASK_STATE_FAILED`=4, `TASK_STATE_CANCELED`=5, `TASK_STATE_REJECTED`=7 |

There is **no `.final` boolean** in 1.x. Finality is determined entirely by the `TaskState` enum value on `statusUpdate`.

### Gaps / Unverified

- Only `sendMessageStream` and `cancelTask` are confirmed on the alpha `Client`; avoid other methods.
- `ClientFactoryOptions` customization (interceptors, custom transports) may work but is untested against this alpha.
- gRPC transport availability in the alpha is not confirmed.
- `createFromAgentCard(agentCard)` and path-override overloads on `createFromUrl` are not confirmed in the alpha signature.

---

## 2. ACP Client — `@agentclientprotocol/sdk`

> **Package rename:** `@zed-industries/agent-client-protocol` is deprecated (last v0.4.5). The active package is `@agentclientprotocol/sdk`. Migrate now.

### Install

```bash
npm install @agentclientprotocol/sdk zod
```

Peer dependency: `zod ^3.25.0 || ^4.0.0`. No explicit `engines` field in package.json; uses `Readable.toWeb()` / `Writable.toWeb()` which are stable in **Node.js >= 18**.

### Key Exports

```typescript
import * as acp from '@agentclientprotocol/sdk';

// Main classes
acp.ClientSideConnection   // what you instantiate as the gateway client
acp.AgentSideConnection    // for agent-side — not needed in the gateway

// Stream factory
acp.ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): Stream

// Types — all from the schema re-export
acp.InitializeRequest, acp.InitializeResponse
acp.NewSessionRequest, acp.NewSessionResponse
acp.PromptRequest, acp.PromptResponse
acp.CancelNotification
acp.SessionNotification
acp.RequestPermissionRequest, acp.RequestPermissionResponse
// ... and every other protocol type

// Interfaces implemented by the gateway
type acp.Client   // you implement this (handler for agent → gateway callbacks)
type acp.Agent    // implemented by ClientSideConnection (you call its methods)
```

### `ClientSideConnection` Constructor

```typescript
class ClientSideConnection {
  constructor(
    toClient: (agent: Agent) => Client,   // factory that returns your Client handler
    stream: Stream                         // from ndJsonStream()
  )

  // Accessors
  get signal(): AbortSignal   // aborts when connection closes
  get closed(): Promise<void> // resolves when connection closes
}
```

### Wiring a Subprocess (Node `child_process.spawn`)

`ndJsonStream` takes Web Streams API types. Node.js 18+ provides `Readable.toWeb()` and `Writable.toWeb()` to convert:

```typescript
import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import * as acp from '@agentclientprotocol/sdk';

const proc = spawn('npx', ['tsx', 'path/to/agent.ts'], { stdio: 'pipe' });

const stream = acp.ndJsonStream(
  Writable.toWeb(proc.stdin!),    // WritableStream<Uint8Array> — gateway → agent
  Readable.toWeb(proc.stdout!),   // ReadableStream<Uint8Array> — agent → gateway
);

const connection = new acp.ClientSideConnection(
  (_agent) => gatewayClientHandler,   // see Client interface below
  stream
);
```

### `ClientSideConnection` Methods (the `Agent` interface)

These are the methods you call on `connection` to drive the agent:

```typescript
// 1. Negotiate protocol version and exchange capabilities — call once at startup
connection.initialize(params: InitializeRequest): Promise<InitializeResponse>

// 2. Create a new conversation session — returns a sessionId
connection.newSession(params: NewSessionRequest): Promise<NewSessionResponse>

// 3. Send a user prompt — blocks until the agent completes the turn
connection.prompt(params: PromptRequest): Promise<PromptResponse>

// 4. Cancel an ongoing turn (notification — no response body)
connection.cancel(params: CancelNotification): Promise<void>

// Additional session management (conditionally available by capability):
connection.loadSession(params): Promise<LoadSessionResponse>    // replay history
connection.resumeSession(params): Promise<ResumeSessionResponse> // resume, no history replay
connection.listSessions(params): Promise<ListSessionsResponse>
connection.deleteSession(params): Promise<DeleteSessionResponse>
connection.closeSession(params): Promise<CloseSessionResponse>  // cancel + free resources
connection.setSessionMode(params): Promise<SetSessionModeResponse>
connection.authenticate(params): Promise<AuthenticateResponse>
```

### `PromptRequest` Shape

```typescript
const promptResult: acp.PromptResponse = await connection.prompt({
  sessionId,
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Hello agent' }],
    },
  ],
  // optional _meta for pass-through metadata
  _meta: { 'inteliside/request_id': '...' },
});
```

### `PromptResponse` Shape and `stopReason`

```typescript
type PromptResponse = {
  stopReason: StopReason;
  _meta?: { [key: string]: unknown } | null;
  usage?: Usage | null;   // UNSTABLE — token usage, may not always be present
};

type StopReason =
  | 'end_turn'           // normal completion
  | 'max_tokens'         // token limit hit
  | 'max_turn_requests'  // too many sub-requests in the turn
  | 'refusal'            // agent refused the request
  | 'cancelled';         // client sent cancel() and agent honored it
```

### Reading `_meta["inteliside_usage"]`

Every ACP protocol type carries `_meta?: { [key: string]: unknown } | null`. On `PromptResponse`:

```typescript
const result = await connection.prompt(promptParams);
const usage = result._meta?.['inteliside_usage'];

// Check stop reason before reading
if (result.stopReason === 'end_turn') {
  console.log('usage:', usage);
}
```

Note: unlike A2A's `metadata` (slash-separated key `"inteliside/usage"`), ACP uses `_meta` with underscore-separated keys. The exact key name is whatever the agent puts there — `"inteliside_usage"` is an example; verify against the Python agent implementation.

### `Client` Interface — Handler You Implement

The gateway must implement this interface. The agent calls these methods during a turn (agent → gateway direction):

```typescript
interface Client {
  // REQUIRED — agent asks permission before executing a sensitive tool call
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>

  // REQUIRED — real-time streaming updates during the turn (message chunks, tool calls, plans)
  // This is how you stream progress to callers; it is a notification (returns void)
  sessionUpdate(params: SessionNotification): Promise<void>

  // OPTIONAL — file system access (only if you advertised these capabilities)
  readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>
  writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>

  // OPTIONAL — terminal access
  createTerminal?(params: CreateTerminalRequest): Promise<CreateTerminalResponse>
  terminalOutput?(params: TerminalOutputRequest): Promise<TerminalOutputResponse>
  releaseTerminal?(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse | void>
  waitForTerminalExit?(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse>
  killTerminal?(params: KillTerminalRequest): Promise<KillTerminalResponse | void>

  // Extension hooks (both optional)
  extMethod?(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
  extNotification?(method: string, params: Record<string, unknown>): Promise<void>
}
```

### Minimal Complete Usage Snippet

```typescript
import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import * as acp from '@agentclientprotocol/sdk';

// 1. Implement the Client handler (gateway → agent callbacks)
class GatewayClientHandler implements acp.Client {
  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    // Auto-approve or route to human — must return one of the options
    return { outcome: 'approved', optionId: params.options[0].id };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    // Stream incremental output to the gateway caller here
    console.log('session update:', JSON.stringify(params).slice(0, 200));
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await fs.readFile(params.path, 'utf8');
    return { content };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await fs.writeFile(params.path, params.content, 'utf8');
    return {};
  }
}

async function runAgentSession(userPrompt: string) {
  // 2. Spawn agent subprocess
  const proc = spawn('npx', ['tsx', 'agent/index.ts'], { stdio: 'pipe' });

  // 3. Wire stdin/stdout through ndJsonStream (Web Streams needed)
  const stream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin!),
    Readable.toWeb(proc.stdout!),
  );

  const handler = new GatewayClientHandler();
  const connection = new acp.ClientSideConnection((_agent) => handler, stream);

  // 4. Initialize — negotiate protocol version
  await connection.initialize({
    protocolVersion: '2025-05-26',
    capabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
  });

  // 5. Create a session
  const { sessionId } = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });

  // 6. Send prompt — blocks until stopReason arrives
  //    Session updates stream in real time via handler.sessionUpdate()
  const result = await connection.prompt({
    sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
  });

  // 7. Read usage metadata
  const usage = result._meta?.['inteliside_usage'];
  console.log('stopReason:', result.stopReason, 'usage:', usage);

  // 8. Clean up
  proc.kill();
  await connection.closed;

  return result;
}

// Cancel mid-turn:
// connection.cancel({ sessionId })
// The prompt() promise will resolve with stopReason: 'cancelled'
```

### Gaps / Unverified

- `_meta` keys written by the Python `agent-client-protocol` agent are not documented in the TypeScript SDK. The key name `"inteliside_usage"` must be confirmed against the actual Python agent implementation — it is **not** a protocol-specified key.
- `usage?: Usage | null` in `PromptResponse` is marked `@experimental` / UNSTABLE in v0.25.0; do not rely on it until stable.
- `InitializeRequest.protocolVersion` accepted values are not pinned in the TypeScript types — verify against the Python server's advertised version during handshake.
- No explicit `engines` field in package.json. `Readable.toWeb()` / `Writable.toWeb()` were added in Node.js 16.7.0 (flagged) and are stable in **18+**. Treat Node >= 18 as the minimum.
- The `cancel()` method sends a **notification** (no response). The in-flight `prompt()` will eventually resolve with `stopReason: 'cancelled'` — do not `await cancel()` expecting it to block until the prompt resolves.

---

## Cross-Reference: A2A vs. ACP

| Concern              | A2A (`@a2a-js/sdk` v1.0.0-alpha.0)                                                    | ACP (`@agentclientprotocol/sdk`)                      |
|----------------------|----------------------------------------------------------------------------------------|-------------------------------------------------------|
| Transport            | HTTP/SSE (JSONRPC or REST, negotiated via `supported_interfaces[].protocol_binding`)   | stdio / newline-delimited JSON (subprocess)           |
| Connection           | `new ClientFactory()` → `createFromUrl()`                                              | `new ClientSideConnection(handler, ndJsonStream(...))`|
| Discovery            | `/.well-known/agent-card.json` auto-fetched; card parsed manually (no `getAgentCard()` in alpha) | Agent spawned as child process; no discovery step     |
| Send prompt          | `client.sendMessageStream(req)` (async iter)                                           | `connection.prompt(params)` (single await)            |
| Streaming updates    | `for await` on `AsyncIterable<StreamResponse>`; `resp.payload.$case` discriminant      | `Client.sessionUpdate()` callback (push)              |
| Cancellation         | `client.cancelTask({ tenant: "", id, metadata: undefined })`                           | `connection.cancel({ sessionId })` (notification)     |
| Usage metadata key   | `payload.value.metadata?.['inteliside/usage']`                                         | `result._meta?.['inteliside_usage']`                  |
| Node.js minimum      | **18** (declared)                                                                      | **18** (practical; `toWeb()` stable from 18)          |
