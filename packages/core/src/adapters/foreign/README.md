# Foreign adapters (future extension — NOT in the MVP)

This folder is intentionally empty.

Fleet is **Flue-only**: the native path is `../flue.ts` — `FlueAdapter`, for the
Flue agents Fleet converts and deploys (Flue HTTP + WebSocket). It implements the
neutral `AgentAdapter` interface (`../agent-adapter.ts`) and maps Flue's events
into the neutral run model, so the rest of the Core never sees the wire protocol.

A **foreign adapter** belongs here only when we must connect to an agent that
does **not** speak Flue — a runtime with its own protocol we cannot put behind a
Flue server. Such an adapter implements `../agent-adapter.ts` by translating that
foreign protocol into the neutral model (`run / event / usage / done / abort`).

**Rule:** reach for a foreign adapter only as a last resort. If the agent is a
Flue agent (or can be converted to one), use `FlueAdapter`.
