# Flue authoring reference (for the converter + WS0 fixture)

How a Flue agent is written, served, and deployed. Source: flueframework.com/docs
(project-layout, building-agents, tools, subagents, skills, models, provider-api,
routing, develop-and-build). Used by the Claude Code→Flue converter (WS2) and by
the WS0 test fixture.

## Project layout

```
my-project/
├── package.json
├── flue.config.ts          # defineConfig({ output: './dist' }) — build target here
├── src/
│   ├── app.ts              # optional: Hono composition, auth middleware, webhooks
│   ├── cloudflare.ts       # optional: CF Worker exports
│   ├── db.ts               # optional: DB adapter (Node only)
│   ├── agents/<name>.ts    # filename = agent name (flat, no nesting)
│   └── workflows/<name>.ts # filename = workflow name (flat)
└── dist/
```

Source dir search order: `.flue/` → `src/` → project root.

## createAgent

```ts
import { createAgent } from '@flue/runtime';

export default createAgent(({ id, env, payload }) => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'You are a support assistant.',
  tools: [lookupOrderTool],
  skills: [reviewSkill],
  subagents: [classifierProfile],
  thinkingLevel: 'medium',            // off|minimal|low|medium|high|xhigh (default medium)
  compaction: { reserveTokens: 20000, keepRecentTokens: 8000 },
  durability: { retry: 10, timeout: 60 },
}));

// REQUIRED to be reachable (WS0 finding): without `route`/`websocket` exports the
// agent builds and loads but is NOT routable ("agent not registered"). Plain
// pass-through middleware is enough; add auth checks here if needed.
export const route = async (c, next) => { /* check c.req.header('authorization') */ await next(); };
export const websocket = async (c, next) => next();
```

## defineTool / connectMcpServer

```ts
import { defineTool, Type, connectMcpServer } from '@flue/runtime';

const lookupOrderTool = defineTool({
  name: 'lookup_order_status',
  description: 'Look up fulfillment status for one order ID.',
  parameters: Type.Object({ orderId: Type.String() }),  // TypeBox (JSON-Schema compatible)
  execute: async ({ orderId }, signal) => 'status string',  // must return string
});

const inventory = await connectMcpServer('inventory', {
  url: env.INVENTORY_MCP_URL,
  headers: { Authorization: `Bearer ${env.INVENTORY_MCP_TOKEN}` },
  transport: 'streamable-http',   // or 'sse' for legacy
});
// inventory.tools → named mcp__inventory__<tool>; inventory.close()
```

## defineAgentProfile / subagents

```ts
const reviewer = defineAgentProfile({
  name: 'reviewer',               // required to target it in session.task()
  description: 'Reviews changes.',
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'Return product area and urgency.',
  tools: [...], skills: [...], thinkingLevel: 'low',
});

// in a workflow/session:
const res = await session.task(payload.change, { agent: 'reviewer', result: ReviewSchema, signal });
```

## Skills (SKILL.md — no defineSkill)

```ts
import review from '../skills/review/SKILL.md' with { type: 'skill' };  // import attribute
createAgent(() => ({ skills: [review] }));
const r = await session.skill('review', { args: { change }, result: schema, signal });
```

Skills are SKILL.md files (+ sibling support files included in builds). Also
auto-discovered from `<cwd>/.agents/skills/`. A skill invocation surfaces as an
`operation` (operationKind `skill`).

## Models & providers (the converter's central feature)

Specifier format `{provider}/{model}`, e.g. `anthropic/claude-sonnet-4-6`,
`openai/gpt-5.5`, `openrouter/moonshotai/kimi-k2.6`, `cloudflare/@cf/...`.

Built-in provider IDs: `anthropic`, `openai`, `openrouter`, `cloudflare`,
`cloudflare-workers-ai`, `cloudflare-ai-gateway`. Env keys: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`.

```ts
import { configureProvider, registerProvider } from '@flue/runtime';

configureProvider('anthropic', { baseUrl: env.GW_URL, apiKey: env.ANTHROPIC_API_KEY });

registerProvider('ollama', { api: 'openai-completions', baseUrl: 'http://localhost:11434/v1' });
// ProviderConfiguration: { baseUrl?, headers?, apiKey?, storeResponses? }
// HttpProviderRegistration: { api, baseUrl, apiKey?, headers?, contextWindow?, maxTokens?, models? }
```

Per-operation override: `session.prompt(msg, { model: 'openai/gpt-5.5' })`.

## CLI / dev / build / deploy

| Command | Purpose |
|---|---|
| `flue dev` | Dev server (Hono). Port not documented — discover at runtime |
| `flue connect <name> <id>` | Interactive REPL to an agent |
| `flue run <workflow> --payload '{...}'` | Run a workflow once |
| `flue build [--target node\|cloudflare]` | Build to `dist/` |
| `flue logs <runId>` | Inspect run logs |

Targets: `node` (any Node host; Docker by implication) and `cloudflare`
(Workers + Durable Objects). Node requirement: **>= 22.18**.

## DB (Node only)

```ts
// src/db.ts
import { sqlite } from '@flue/runtime/node';
export default sqlite('./data/flue.db');   // or sqlite() in-memory; Postgres adapter for multi-replica
```

Cloudflare needs no `db.ts` (Durable Object SQLite).

## Converter mapping (Claude Code → Flue, ~1:1) — for WS2

| Claude Code | Flue |
|---|---|
| `CLAUDE.md` | agent `instructions` |
| `.claude/agents/*.md` | `defineAgentProfile()` |
| `.claude/skills/*` | `SKILL.md` copied into `src/skills/` |
| MCP server config | `connectMcpServer()` |
| settings model | `model` specifier (default = original Anthropic model; swappable) |
| hooks, permissions | NOT mapped — document the gap |

The converter MUST also emit `export const route` + `export const websocket` for every
agent module (see createAgent above) — otherwise Fleet's FlueAdapter cannot reach it.
