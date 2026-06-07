# Foreign-Framework Adapters (edge case — NOT the standard path)

Source: `packages/core/src/adapters/foreign/README.md`

## When you DON'T need a foreign adapter (the vast majority of cases)

- **A2A agent** (remote, serves an Agent Card at `/.well-known/agent-card.json`) → use `A2AAdapter` directly.
- **ACP agent** (local, started as a subprocess and speaks ACP JSON-RPC over stdio) → use `AcpAdapter` directly.

These cover every agent built with the Inteliside Scaffolding and any
standards-compliant third-party agent. There is no "foreign adapter" needed
for standard cases.

## When you DO need a foreign adapter

Only when connecting to an agent that speaks **neither A2A nor ACP** — for
example a proprietary protocol, a legacy REST API, or a framework-specific
wire format.

Current known cases:
- None in the MVP. The `foreign/` directory is intentionally empty.

## What a foreign adapter does

It implements `AgentAdapter` by translating the third-party protocol into the
neutral run model:

```ts
// packages/core/src/adapters/foreign/<framework>.ts
class MyCustomAdapter implements AgentAdapter {
  readonly kind = "a2a" as const;  // pick the closest standard or add a new AgentKind
  info(): AgentInfo { ... }
  run(input: RunInput, options: RunOptions, sink: RunSink): RunHandle { ... }
  close(): Promise<void> { ... }
}
```

The Core does not change. Only the adapter knows about the foreign protocol.

## Where to add it

`packages/core/src/adapters/foreign/` — create `<framework>.ts` implementing
`AgentAdapter`. Follow the same sink-driving pattern as `A2AAdapter` and
`AcpAdapter`.

## Rule

```
Speaks A2A?  → A2AAdapter    (always — no exceptions)
Speaks ACP?  → AcpAdapter    (always — no exceptions)
Neither?     → ForeignXxxAdapter (add to adapters/foreign/)
```
