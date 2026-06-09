---
name: adapter-interface
description: The neutral AgentAdapter interface and its only implementation, FlueAdapter, plus the foreign/ placeholder for future non-Flue agents.
triggers:
  - adapter interface
  - AgentAdapter
  - AgentKind
  - FlueAdapter
  - agent framework
  - adapter kind
  - native adapter
---

## Purpose

`AgentAdapter` (`packages/core/src/adapters/agent-adapter.ts`) is the Core's
neutral abstraction for talking to one agent. Fleet is **Flue-only**, so there
is a single implementation:

| `AgentKind` | Adapter | When | Wire |
|---|---|---|---|
| `"flue"` | `FlueAdapter` | Every agent (converted from Claude Code, deployed by Fleet) | Flue HTTP + WebSocket, `@flue/sdk` |

`FlueAdapter` maps Flue's event stream INTO the neutral run model (`neutral.ts`).
The rest of the Core — state, Gateway API, frontend — never sees Flue.

A2A and ACP were removed; the `foreign/` directory is a placeholder for a future
agent that speaks neither Flue nor a standard Fleet supports.

## When to use

- Understanding the `AgentAdapter` interface contract
- Implementing a future `foreign` adapter for a non-Flue protocol
- Debugging adapter initialization or method dispatch

## AgentAdapter interface

```ts
// packages/core/src/adapters/agent-adapter.ts
export type AgentKind = "flue";

export interface AgentAdapter {
  readonly kind: AgentKind;
  info(): AgentInfo;
  run(input: RunInput, options: RunOptions, sink: RunSink): RunHandle;
  close(): Promise<void>;
}

export interface RunHandle {
  readonly done: Promise<void>;
  abort(): Promise<void>;  // Flue: best-effort socket close / signal
}
```

## Wiring in the Core (Gateway API)

```ts
// Connect a served Flue agent — triggered by "agent.connectFlue", or by the
// deployer after it converts + builds + runs the agent.
const adapter = await FlueAdapter.connect({ baseUrl, agentName, instanceId, token });
```

See `packages/core/src/core.ts` (`#connectFlue` / `#deployFlue`) for canonical
wiring, and `packages/core/src/deploy/flue-deployer.ts` for the deploy pipeline.

## References

- `packages/core/src/adapters/agent-adapter.ts` — the interface
- `packages/core/src/adapters/flue.ts` — FlueAdapter implementation
- `packages/core/src/adapters/foreign/README.md` — placeholder for non-Flue agents
- Skill `flue-client` — deep dive on the Flue wire + mapping
