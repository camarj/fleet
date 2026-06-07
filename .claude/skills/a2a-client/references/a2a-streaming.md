# A2A Streaming — Event Loop, Cancellation, and Metadata

> SOURCE OF TRUTH: `docs/gateway-clients/sdk-reference.md` §1 — StreamEvent
> Discriminant Summary and Streaming — Event Loop.
> This file is a navigation aid; the SDK reference is authoritative.

---

## Event loop pattern

```ts
for await (const event of client.sendMessageStream(params)) {
  const ev = event as unknown as Record<string, unknown> & { kind: string };

  switch (ev.kind) {
    case "task":
      taskId = ev["id"] as string;         // capture for potential cancelTask()
      break;

    case "artifact-update":
      // Parts arrive incrementally. Map text parts to message.delta events.
      break;

    case "message":
      // Direct response without a task wrapper. Terminal event.
      // Read usage here: ev["metadata"]?.["inteliside/usage"]
      break;

    case "status-update":
      // Read usage from: ev["metadata"] or ev["status"]["metadata"]
      if (ev["final"] === true) {
        // terminal — check ev["status"]["state"] for "canceled" / "failed"
      }
      break;
  }
}
```

SDK reference: `docs/gateway-clients/sdk-reference.md` — "Streaming — Event Loop"

---

## Cancellation

To abort an in-flight run:

1. Break out of the `for await` loop (or let `aborted` flag skip processing).
2. Call `client.cancelTask({ id: taskId })` (the task id from the `"task"` event).

The `sendMessageStream` generator has no built-in cancel handle — you must call
`cancelTask` separately after breaking the loop. See SDK reference §1
"Cancellation" for the exact signature.

---

## Usage metadata key

Key: `"inteliside/usage"` — constant `A2A_USAGE_METADATA_KEY` in `neutral.ts`.

| Source event | Access path |
|---|---|
| `"message"` | `ev["metadata"]?.["inteliside/usage"]` |
| `"status-update"` | `ev["metadata"]?.["inteliside/usage"]` or `ev["status"]["metadata"]?.["inteliside/usage"]` |

The read helper in `a2a.ts` (`readUsage(meta)`) consolidates both sources.

---

## Terminal vs non-terminal events

| `event.kind` | Terminal? |
|---|---|
| `"task"` | No |
| `"artifact-update"` | Only when `.lastChunk === true` |
| `"message"` | Yes |
| `"status-update"` | Only when `.final === true` |

When `.final === true` on a `"status-update"`, check `status.state`:
- `"canceled"` → map to neutral `"aborted"`
- `"failed"` / `"rejected"` → trigger `sink.onError()`
- Otherwise → `"completed"`
