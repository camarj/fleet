# Docker — Using a Containerised Agent

## How Docker fits the new model

A Docker container is simply a **location**. The adapter you use depends on
which protocol the container's agent speaks:

| Agent protocol | Adapter | How to reach it |
|---|---|---|
| A2A (HTTP+SSE) | `A2AAdapter` | Expose a port (`-p 4000:4000`), connect by URL |
| ACP (stdio) | Not supported as Docker yet (see below) | — |

## A2A agent in Docker (MVP — works today)

Run the container yourself and expose its port:

```bash
docker run -p 4000:4000 my-a2a-agent-image
```

Then register it from the frontend:

```ts
// Gateway API ClientRequest — triggers A2AAdapter.connect() in the Core
client.send({ type: "agent.connectA2A", url: "http://localhost:4000" });
```

The Core calls `A2AAdapter.connect("http://localhost:4000")`, which
auto-discovers the Agent Card at `http://localhost:4000/.well-known/agent-card.json`.

## ACP agent in Docker (NOT yet supported)

ACP requires spawning the process so its stdin/stdout are pipes controlled by
the Core. Running an ACP agent inside Docker would require either:

- `docker exec -i <id> <command>` with piped stdin/stdout, or
- A hybrid approach where Docker wraps the process and the Core connects via
  TCP and a framing layer.

Neither is implemented. For now: run ACP agents locally on the host machine.

## Future Docker lifecycle design

When implementing Docker support for A2A agents end-to-end:

1. Use the Docker Engine API (REST at `unix:///var/run/docker.sock`) or spawn
   `docker run` via `child_process`.
2. After start, read the published port:
   `docker inspect <id>` → `.NetworkSettings.Ports`.
3. Connect with `A2AAdapter.connect("http://localhost:<port>")`.
4. On close, call `docker stop <id>` then `docker rm <id>`.

Docker Engine API docs: https://docs.docker.com/engine/api/ (verify current
version before implementing).
