---
name: transport-local-docker
description: How agent location maps to the right adapter — ACP spawns a local subprocess (stdio), A2A connects to a remote URL (HTTP+SSE). No separate Transport layer.
triggers:
  - transport
  - agent launch
  - endpoint resolution
  - locate agent
  - local agent
  - docker agent
  - remote url
  - subprocess spawn
---

## Purpose

"Transport" in the new model means: how does the Core reach an agent given its
**location**? The answer is baked into the adapter choice — there is no
separate `Transport` interface:

| Location | Adapter | Connection |
|---|---|---|
| Local (on this machine) | `AcpAdapter` | Spawns a subprocess → stdio JSON-RPC |
| Remote (URL) | `A2AAdapter` | HTTP+SSE to the base URL |
| Docker (container) | `A2AAdapter` (mapped port) or `AcpAdapter` (future) | See `references/docker.md` |

## CRITICAL: stdio, not localhost HTTP

**ACP agents are NOT reached over HTTP to a localhost port.** The Core spawns
the agent as a subprocess and communicates over its stdin/stdout. There is no
HTTP server, no `localhost:PORT`, no `/healthz` polling.

The old Runtime Protocol used HTTP+WS to localhost. **That pattern is gone.**

## When to use

- Understanding how the Core connects to a local vs. remote agent
- Implementing or debugging subprocess launch for ACP agents
- Understanding Docker and remote agent patterns
- Explaining why Cloudflare is still unsupported

## Two adapter paths

### Local agent (AcpAdapter)

The Core spawns the agent process. Communication is over stdio.

```ts
const adapter = await AcpAdapter.launch({
  cwd: "/path/to/agent",
  command: "python",
  args: ["-m", "agent"],
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  id: "my-local-agent",
  name: "My Local Agent",
});
```

See `references/local.md` and the `acp-client` skill for details.

### Remote agent (A2AAdapter)

The Core connects by URL. No spawning; the agent runs independently.

```ts
const adapter = await A2AAdapter.connect("https://agent.example.com");
// Agent Card auto-discovered at /.well-known/agent-card.json
```

See `references/docker.md` for using a container-mapped URL.

## Closing

Both adapters implement `close()`:
- `AcpAdapter.close()` — kills the subprocess
- `A2AAdapter.close()` — no-op (no persistent connection)

## Docker

See `references/docker.md`. TL;DR: run the container yourself, then connect
with `A2AAdapter` using the mapped port URL. Container lifecycle management
is not yet implemented.

## Cloudflare

See `references/cloudflare.md`. Still unsupported — the Cloudflare stub is a
documented placeholder.

## References

- `references/local.md` — ACP subprocess spawn details
- `references/docker.md` — Docker transport approach (stub)
- `references/cloudflare.md` — why Cloudflare is unsupported
- Skill `acp-client` — ACP wire protocol details
- Skill `a2a-client` — A2A wire protocol details
