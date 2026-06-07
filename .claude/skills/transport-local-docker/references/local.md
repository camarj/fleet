# Local Agent — AcpAdapter Subprocess Launch

Source: `packages/core/src/adapters/acp.ts`

## How the Core reaches a local agent

The Core SPAWNS the agent as a subprocess. There is no HTTP server, no
localhost port, no health polling. Communication happens over the process's
stdin/stdout using newline-delimited JSON-RPC (ACP protocol).

## Launch

```ts
const adapter = await AcpAdapter.launch({
  cwd: "/absolute/path/to/agent",  // working directory for the subprocess
  command: "python",                // executable
  args: ["-m", "agent"],            // arguments
  env: { ANTHROPIC_API_KEY: "..." },// merged over process.env
  id: "my-agent",                   // neutral identity (ACP initialize carries little)
  name: "My Agent",                 // display name
});
```

`AcpAdapter.launch()` internally:
1. `spawn(command, args, { cwd, env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "inherit"] })`
2. Wraps stdin/stdout via `acp.ndJsonStream()` (Web Streams)
3. Creates a `ClientSideConnection` with a handler
4. Calls `conn.initialize({ protocolVersion, clientCapabilities: { fs: false, terminal: false } })`
5. Returns the ready adapter

## stdio contract

| Stream | Direction | Content |
|---|---|---|
| `stdin` | Core → Agent | ACP JSON-RPC messages (newline-delimited) |
| `stdout` | Agent → Core | ACP JSON-RPC messages (newline-delimited) |
| `stderr` | inherited | Agent logs — visible in Core terminal (dev) |

The agent **MUST NOT** write anything to stdout except valid ACP messages.
Logging goes to stderr.

## No HOST/PORT env injection

Unlike the old Runtime Protocol, ACP agents do NOT receive `HOST` or `PORT`
environment variables. They bind no HTTP server — all communication is stdio.

## Session lifecycle (after launch)

```ts
const { sessionId } = await adapter.conn.newSession({ cwd: spec.cwd, mcpServers: [] });
const result = await adapter.conn.prompt({ sessionId, messages: [...] });
// Real-time output: sessionUpdate callback fires during prompt()
```

See the `acp-client` skill and `docs/gateway-clients/sdk-reference.md` §2 for
the full lifecycle.

## Closing

```ts
await adapter.close();
// 1. proc.kill() — sends SIGKILL
// 2. await conn.closed — waits for the connection to shut down
```

## Permissions (MVP)

All filesystem and terminal permission requests from the agent are denied:
```ts
return { outcome: { outcome: "cancelled" } };
```

The Gateway does not grant a local ACP agent access to the host machine's
filesystem or terminal in Phase 1.
