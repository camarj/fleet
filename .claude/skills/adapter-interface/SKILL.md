---
name: adapter-interface
description: The neutral AgentAdapter interface — two native implementations (A2AAdapter for remote, AcpAdapter for local) — and when a foreign adapter is needed.
triggers:
  - adapter interface
  - AgentAdapter
  - AgentKind
  - A2AAdapter
  - AcpAdapter
  - agent framework
  - adapter kind
  - native adapter
---

## Purpose

`AgentAdapter` (`packages/core/src/adapters/agent-adapter.ts`) is the Core's
neutral abstraction for talking to one agent. Two native implementations cover
all standard cases:

| `AgentKind` | Adapter | When | Standard |
|---|---|---|---|
| `"a2a"` | `A2AAdapter` | Remote agents | A2A (HTTP+SSE), `@a2a-js/sdk` |
| `"acp"` | `AcpAdapter` | Local agents | ACP (stdio subprocess), `@agentclientprotocol/sdk` |

Both map their standard's events INTO the neutral run model (`neutral.ts`).
The rest of the Core — state machine, Gateway API, frontend — never sees A2A
or ACP.

There are no "foreign adapters" for standard cases. A2A and ACP ARE the
native adapters. See `references/foreign-adapters.md` only for the rare case
of an agent that speaks neither.

## When to use

- Deciding which adapter to use for a new agent
- Understanding the `AgentAdapter` interface contract
- Implementing a non-standard adapter for a third-party protocol
- Debugging adapter initialization or method dispatch

## AgentAdapter interface

```ts
// packages/core/src/adapters/agent-adapter.ts
export type AgentKind = "a2a" | "acp";

export interface AgentAdapter {
  readonly kind: AgentKind;
  info(): AgentInfo;
  run(input: RunInput, options: RunOptions, sink: RunSink): RunHandle;
  close(): Promise<void>;
}

export interface RunHandle {
  readonly done: Promise<void>;
  abort(): Promise<void>;  // A2A: tasks/cancel; ACP: session/cancel
}
```

## Decision: which adapter?

```
Agent is REMOTE (has a URL, not spawned by us)?
  YES → A2AAdapter — connects by base URL, auto-discovers Agent Card
  NO  → Agent is LOCAL (we spawn it as a subprocess)?
    YES → AcpAdapter — spawns the process, communicates over stdio
    NO  → Does it speak neither A2A nor ACP?
           → see references/foreign-adapters.md
```

## Two axes — adapter vs. protocol

| Axis | Answers |
|---|---|
| Adapter (framework) | HOW to talk to the agent — A2A or ACP |
| Protocol wire | WHERE and HOW the bytes travel — HTTP+SSE (A2A) or stdio JSON-RPC (ACP) |

Adapter and wire are coupled in the new model: `A2AAdapter` owns HTTP+SSE,
`AcpAdapter` owns the subprocess + stdio. There is no separate "Transport"
layer — the adapters absorb it.

## Wiring an adapter in the Core (Gateway API)

```ts
// Remote agent (A2A) — triggered by "agent.connectA2A" request
const adapter = await A2AAdapter.connect(req.url);

// Local agent (ACP) — triggered by "agent.launchAcp" request
const adapter = await AcpAdapter.launch({
  cwd: req.cwd,
  command: req.command ?? "python",
  args: req.args ?? ["-m", "agent"],
  id: req.id,
  name: req.name,
});
```

See `packages/core/src/core.ts` for canonical wiring in `#handleRequest()`.

## References

- `references/foreign-adapters.md` — only for agents speaking neither A2A nor ACP
- `packages/core/src/adapters/agent-adapter.ts` — the interface
- `packages/core/src/adapters/a2a.ts` — A2AAdapter implementation
- `packages/core/src/adapters/acp.ts` — AcpAdapter implementation
- Skill `a2a-client` — deep dive on A2A wire details
- Skill `acp-client` — deep dive on ACP wire details
