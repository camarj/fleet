# ACP Session Lifecycle — initialize → newSession → prompt → cancel

> SOURCE OF TRUTH: `docs/gateway-clients/sdk-reference.md` §2 and
> `docs/acp/wire-reference.md` §3–5 and §10.
> This file maps the ACP sequence to what `AcpAdapter` does. Read the
> authoritative refs for precise field shapes and gaps.

---

## 1. Spawn subprocess

```ts
const proc = spawn(command, args, {
  cwd, env: { ...process.env, ...spec.env },
  stdio: ["pipe", "pipe", "inherit"],  // stdin/stdout are pipes; stderr is inherited
});
```

The agent MUST write only valid ACP JSON-RPC messages to `stdout`. Logging goes
to `stderr` — which is inherited and flows to the Core's terminal.

---

## 2. Wire up ndJsonStream

```ts
const stream = acp.ndJsonStream(
  Writable.toWeb(proc.stdin!),    // Core → Agent
  Readable.toWeb(proc.stdout!),   // Agent → Core
);
const conn = new acp.ClientSideConnection(() => handler, stream);
```

`ndJsonStream` takes Web Streams (`WritableStream<Uint8Array>` /
`ReadableStream<Uint8Array>`). Use `Writable.toWeb()` / `Readable.toWeb()`
(Node.js 18+ stable) to convert Node streams.

---

## 3. initialize (first call, required)

```ts
await conn.initialize({
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
});
```

The `acp.PROTOCOL_VERSION` constant comes from the SDK. Do not hard-code it.

Wire format: `"method": "initialize"`, `"params": { "protocolVersion": 1, ... }`.
Version negotiation: if the agent returns a different version and the client
cannot support it, close the connection. See `docs/acp/wire-reference.md` §3.

---

## 4. newSession

```ts
const { sessionId } = await conn.newSession({
  cwd: "/absolute/path",
  mcpServers: [],
});
```

The `sessionId` is required for all subsequent `prompt`, `cancel`, and
`closeSession` calls. Wire method: `"session/new"`.

---

## 5. prompt (blocks until stopReason)

```ts
const result = await conn.prompt({
  sessionId,
  messages: [
    { role: "user", content: [{ type: "text", text: "Hello" }] },
  ],
});
// result.stopReason: "end_turn" | "cancelled" | "max_tokens" | "refusal" | ...
```

Real-time output arrives via the `sessionUpdate` push callback **during** this
await — not in the return value. The adapter's `handleUpdate()` maps those
notifications to neutral RunEvents.

Wire method: `"session/prompt"`. See `docs/acp/wire-reference.md` §5.

---

## 6. cancel (abort mid-turn)

```ts
await conn.cancel({ sessionId });
// This is a NOTIFICATION — it does not block until cancelled.
// The in-flight prompt() will resolve with stopReason: "cancelled".
```

Do NOT await `cancel()` expecting the prompt to be done. The prompt promise
resolves asynchronously after the agent honours the cancellation.

Wire method: `"session/cancel"`. See `docs/acp/wire-reference.md` §10.

---

## 7. close

```ts
proc.kill();
await conn.closed;
```

No explicit `session/close` call in the MVP — the Core kills the subprocess
directly. `conn.closed` resolves once the connection is torn down.

---

## session/update discriminants (Core-side handling)

The `sessionUpdate` callback receives objects where `params.update.sessionUpdate`
is the discriminant (older SDK uses `update.type`). The adapter checks both:

| `update.sessionUpdate` / `update.type` | Maps to neutral |
|---|---|
| `"agent_message_chunk"` | `message.delta` |
| `"tool_call"` | `tool.call` |
| `"tool_call_update"` (status = `"completed"`) | `tool.result` |
| `"agent_thought_chunk"`, `"plan"`, etc. | Currently not mapped (ignored) |

For the full list of `session/update` variants, see
`docs/acp/wire-reference.md` §7.
