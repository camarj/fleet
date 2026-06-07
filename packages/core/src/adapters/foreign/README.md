# Foreign-framework adapters (future extension — NOT in the MVP)

This folder is intentionally empty.

The Gateway's **native** paths are the two open standards, both living one level
up in `../`:

- `../a2a.ts` — `A2AAdapter`, for **remote** agents that speak **A2A**
  (Agent2Agent, HTTP+SSE).
- `../acp.ts` — `AcpAdapter`, for **local** agents that speak **ACP** (Agent
  Client Protocol, stdio subprocess).

Both implement the neutral `AgentAdapter` interface (`../agent-adapter.ts`) and
map their standard's events into the neutral run model, so the rest of the Core
never sees A2A or ACP wire details.

A **foreign-framework adapter** belongs here only when we must connect to an
agent that speaks **neither A2A nor ACP** — for example a runtime with its own
proprietary protocol that we cannot put behind an A2A or ACP bridge. Such an
adapter implements `../agent-adapter.ts` by translating that foreign protocol
into the neutral model (`run / event / usage / done / abort`).

**Rule:** reach for a foreign adapter only as a last resort. If the agent can be
fronted by A2A (remote) or ACP (local), use the native adapter instead — that is
the whole point of standardizing on open protocols.
