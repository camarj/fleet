# Mini-spec — ACP adapter (SUPERSEDED · historical)

> **Status: SUPERSEDED.** This was the original *proposal* to consume ACP agents
> as a **foreign** extension layered on top of the (now retired) custom
> Inteliside Runtime Protocol. ACP has since shipped as a **native** adapter, so
> this document is kept only for historical context. **Do not implement from it.**
>
> **Authoritative sources today:**
> - `packages/core/src/adapters/acp.ts` — the real `AcpAdapter` (source of truth).
> - `docs/acp/wire-reference.md` — the ACP wire reference.
> - `docs/gateway-clients/sdk-reference.md` — A2A + ACP client usage.
> - `.claude/skills/acp-client/` — how the Core speaks ACP.

## What changed from this proposal to what shipped

| This proposal said | What actually shipped |
| --- | --- |
| ACP is a **foreign** adapter under `adapters/foreign/acp/` | ACP is a **native** adapter at `packages/core/src/adapters/acp.ts` (`AgentKind = "acp"`) |
| A separate `StdioTransport` at `transport/stdio.ts` | No separate Transport layer — the adapter spawns the subprocess directly |
| Additive changes to `@inteliside/agent-contract` | The Gateway no longer depends on the Contract at all |
| Manifest synthesis with `runtime.protocol: "acp"` | No manifest — agent identity comes straight from ACP `initialize` |
| Usage as a Contract extension | Usage carried in `_meta["inteliside_usage"]` (constant in `packages/core/src/neutral.ts`) |

The neutral-model concepts below (session/update → `RunEvent` mapping,
`stopReason` → terminal frame, `session/cancel` abort, filesystem callbacks)
remain conceptually accurate, but the **binding** definitions now live in the
real `acp.ts` and `docs/acp/wire-reference.md`. Where this doc and the code
disagree, the code wins.

---

## Original design notes (for context only)

> ACP is Zed's open standard (Apache), JSON-RPC 2.0, agent runs as a **subprocess
> of the client** over **stdio**, analogous to LSP.

### Operation mapping (ACP → neutral `AgentAdapter`)

| `AgentAdapter` method | ACP |
| --- | --- |
| connect/launch | spawn → `initialize` (negotiate version + capabilities) → `authenticate` (if required) → `session/new` |
| `run(input, sink)` | `session/prompt`; stream `session/update` → `sink`; resolve on the `stopReason` response |
| `abort()` | `session/cancel` (by `sessionId`) |
| usage | accumulate from `usage_update` notifications |

An ACP *session* persists across many prompt turns; the adapter holds it open and
treats each `session/prompt` turn as one neutral run.

### `session/update` → neutral `RunEvent` mapping

| ACP `sessionUpdate` | Neutral RunEvent | Notes |
| --- | --- | --- |
| `agent_message_chunk` | `message.delta` | role=assistant, content |
| `user_message_chunk` | — | echo of our own input; skip |
| `tool_call` (status `pending`) | `tool.call` | id=`toolCallId`, name, input |
| `tool_call_update` (→ `completed`) | `tool.result` on completed | id, output from `content` |
| `usage_update` | usage | `used`/`size` tokens (+ optional `cost`) |
| `session/request_permission` (agent→client) | `interrupt` + resume reply | maps to HITL |

`stopReason` → terminal frame:

| ACP `stopReason` | Neutral |
| --- | --- |
| `end_turn`, `max_tokens`, `max_turn_requests` | `done` · `completed` |
| `cancelled` | `done` · `aborted` |
| `refusal` | `done` · `completed` (carry a refusal note) |

### Risks / open questions (some now resolved in code)

- **Filesystem callbacks.** ACP agents may read/write files through the client
  (`fs/*` client methods). The Gateway must decide policy: grant, sandbox, or
  deny. This is a security surface remote agents never had.
- **stdio framing** — confirm against the ACP schema / `llms.txt`.
- **Auth diversity** — each ACP agent authenticates differently (ChatGPT vs API
  key vs custom provider); the adapter needs a per-agent auth strategy.

---

### Sources (verified)

- ACP introduction — https://agentclientprotocol.com/get-started/introduction
- ACP overview / methods — https://agentclientprotocol.com/protocol/overview
- ACP prompt turn / session updates / stop reasons — https://agentclientprotocol.com/protocol/prompt-turn
- Full schema index — https://agentclientprotocol.com/llms.txt
- Claude Code ACP bridge — https://www.npmjs.com/package/@zed-industries/claude-code-acp
- Codex ACP bridge (stdio) — https://github.com/cola-io/codex-acp
- ACP Registry (Zed + JetBrains) — https://zed.dev/blog/acp-registry
