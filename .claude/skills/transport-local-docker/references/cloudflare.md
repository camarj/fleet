# CloudflareTransport — Still Not Supported in MVP

## Status

The Cloudflare stub is a documented placeholder. Any attempt to use it throws
immediately. This has not changed with the A2A/ACP migration.

## Why it is not supported

The fundamental incompatibility is at the runtime and protocol level:

| | Cloudflare Workers | A2A agents | ACP agents |
|---|---|---|---|
| Runtime | JavaScript / WebAssembly | Any HTTP server | Python (or other) subprocess |
| Process model | Edge function (stateless) | Long-lived HTTP+SSE server | Long-lived subprocess (stdin/stdout) |
| A2A compatible? | With significant effort (Durable Objects for state) | Native | N/A |
| ACP compatible? | No — stdio subprocess model impossible | N/A | Native |

**A2A remote agents** could theoretically run on Cloudflare Workers using
Durable Objects for session state — but this requires rewriting the agent in
TypeScript and is out of scope for the current phase.

**ACP local agents** require a long-lived subprocess with controllable
stdin/stdout. Cloudflare Workers cannot fulfil this model.

## If you need a remote agent today

Use `A2AAdapter.connect(url)` pointing at any HTTP(S) endpoint where your
agent is deployed — Fly.io, Railway, a VPS, or a tunnel (e.g. ngrok). The
A2A standard travels identically over any HTTPS connection.
