# Foreign adapters

A **foreign adapter** connects to an agent that does **not** speak Flue — a
runtime with its own protocol we cannot put behind a Flue server. It implements
the neutral `AgentAdapter` interface (`../agent-adapter.ts`) by translating that
foreign protocol into the neutral run model (`run / event / usage / done /
abort`), so the rest of the Core never sees the wire protocol — exactly as
`../flue.ts` (`FlueAdapter`) does for Flue.

## A2aAdapter (A2A — Agent2Agent, ADR-13)

- `a2a.ts` — `A2aAdapter` + the pure `mapA2aEvent` mapper. A2A is the
  **coordination** layer (third-party interop, Orchestrator delegation) that
  coexists with Flue, the native **runtime**. The mapper reuses the shared
  neutral-mapping scaffolding (`../neutral-mapping.ts`).
- `a2a-types.ts` — the A2A wire shapes (Task / Message / status-update /
  artifact-update), verified against the official spec, plus the injectable
  `A2aClient` seam (tests drive a fake; production uses the HTTP client).
- `a2a-http-client.ts` — the production `A2aClient`: JSON-RPC 2.0 + SSE.

The factory (`../factory.ts`) builds an `A2aAdapter` for `kind: "a2a"`.

**Rule:** for a Flue agent (or one that can be converted to one), use
`FlueAdapter` — a foreign adapter is for genuinely non-Flue runtimes.
