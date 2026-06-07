---
name: xterm-terminal
description: Embed an xterm.js terminal in React and wire it to the Gateway Core's streaming session events.
triggers:
  - xterm
  - terminal panel
  - TerminalPanel
  - terminal rendering
  - session streaming
  - fit addon
---

## Purpose

Embed and manage an xterm.js terminal in the React frontend, connecting it to the Gateway Core's WebSocket stream (`session.event` → `RunEvent`). The terminal is the primary UI for agent interaction in Phase 1.

## When to use

- Modifying `TerminalPanel.tsx` or its rendering logic
- Adding new `RunEvent` types to the terminal renderer
- Debugging session streaming or terminal lifecycle
- Adding new xterm addons (fit, search, ligatures, etc.)

## Package versions (verified)

```
@xterm/xterm@6.0.0         ← current package (xterm is DEPRECATED)
@xterm/addon-fit@0.11.0
```

CSS import (required — without it the terminal renders blank):
```ts
import "@xterm/xterm/css/xterm.css";
```

## Key file

`frontend/src/components/TerminalPanel/TerminalPanel.tsx`

## Architecture

```
GatewayClient (WS to Core)
  └── on(ServerEvent)
        └── session.event → RunEvent
              └── renderEvent(term, ev) → term.write / term.writeln
```

The frontend never touches A2A or ACP. The Core translates neutral `RunEvent` objects into `session.event` Gateway API packets; `TerminalPanel` renders them.

## Steps

### Terminal initialization (once per mount)

```ts
const term = new Terminal({
  convertEol: true,
  fontSize: 13,
  fontFamily: "Menlo, Monaco, monospace",
  theme: { background: "#0d1117", foreground: "#c9d1d9" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(containerRef.current);   // must be after mount, container must have dimensions
fit.fit();
```

Call `fit.fit()` whenever the container resizes (`window.addEventListener("resize", ...)`).

Dispose on unmount:
```ts
window.removeEventListener("resize", onResize);
term.dispose();
```

### Wiring Gateway events → terminal

Listen via `client.on()` (returns an unsubscribe function — use as the `useEffect` cleanup):

```ts
useEffect(() => {
  return client.on((e: ServerEvent) => {
    switch (e.type) {
      case "session.event":
        if (e.sessionId === sessionRef.current) renderEvent(term, e.event);
        break;
      case "session.done":
        term.writeln(usageLine(e.usage, e.costUsd, e.status));
        break;
      // ...
    }
  });
}, [client]);
```

### RunEvent rendering (current implementation)

| event.type | Action |
|---|---|
| `message.delta` | `term.write(ev.content)` — incremental, no newline |
| `message.completed` | ignored (already streamed via deltas) |
| `tool.call` | `term.writeln(...)` with tool name + input |
| `tool.result` | `term.writeln(...)` with output |
| `subagent.start` | `term.writeln(...)` |
| `subagent.end` | `term.writeln(...)` |
| `interrupt` | `term.writeln(...)` with reason |

### Sending a message / aborting

```ts
// Start session
client.send({ type: "session.start", agentId: agent.id, message: input });

// Abort
client.send({ type: "session.abort", sessionId: sessionRef.current });
```

## Session lifecycle (TerminalPanel state)

1. User submits → `pendingRef.current = true`, `setBusy(true)`
2. `session.started` → sets `sessionRef.current = e.sessionId`, clears pending
3. `session.event` → `renderEvent(term, e.event)` if sessionId matches
4. `session.done` / `session.error` → print summary, `setBusy(false)`, clear sessionRef

Phase 1: one session at a time. Starting a new message while busy is blocked by the UI.

## References

- `references/api.md` — @xterm/xterm 6 API surface used in this project
- Official xterm.js docs: https://xtermjs.org/
- xterm.js GitHub: https://github.com/xtermjs/xterm.js
- @xterm/addon-fit: https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit
