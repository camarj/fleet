# Foreign-Framework Adapters (edge case — NOT the standard path)

Source: `packages/core/src/adapters/foreign/README.md`

## When you DON'T need a foreign adapter (the vast majority of cases)

- **Flue agent** (served over Flue's HTTP+WebSocket API — every agent Fleet
  converts and deploys, and any externally-hosted Flue agent) → use
  `FlueAdapter` directly (`packages/core/src/adapters/flue.ts`).

Fleet is Flue-only; A2A and ACP were removed. There is no "foreign adapter"
needed for the standard case.

## When you DO need a foreign adapter

Only when connecting to an agent that does **not** speak Flue — for example a
proprietary protocol, a legacy REST API, or another framework's wire format.

Current known cases:
- None. The `foreign/` directory is intentionally empty.

## What a foreign adapter does

It implements `AgentAdapter` by translating the third-party protocol into the
neutral run model (`neutral.ts`):

```ts
// packages/core/src/adapters/foreign/<framework>.ts
class MyCustomAdapter implements AgentAdapter {
  readonly kind = "flue" as const;  // or extend AgentKind with a new literal
  info(): AgentInfo { ... }
  run(input: RunInput, options: RunOptions, sink: RunSink): RunHandle { ... }
  close(): Promise<void> { ... }
}
```

The Core does not change. Only the adapter knows about the foreign protocol.
Adding a new `AgentKind` literal ripples through `api.ts` (core + frontend
mirror) and `state/db.ts` — budget for that.

## Where to add it

`packages/core/src/adapters/foreign/` — create `<framework>.ts` implementing
`AgentAdapter`. Follow the same sink-driving pattern as `FlueAdapter`
(`mapFlueEvent` + `UsageAccumulator` in `flue.ts`).

## Rule

```
Speaks Flue?  → FlueAdapter   (always — no exceptions)
Anything else? → ForeignXxxAdapter (add to adapters/foreign/)
```
