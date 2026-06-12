# Plan 008: Tolerant http-MCP connect — one unreachable MCP server must not prevent agent boot (BACKLOG I9)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. Base your branch on `origin/main`.
>
> **Drift check (run first)**: `git diff --stat 20e77a1..HEAD -- packages/converter/src/emit.ts packages/converter/test/convert.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2 (small, but the failure mode was hit in live acceptance the
  day this plan was written)
- **Effort**: S
- **Risk**: LOW (emitted-code change only; behavior identical when all MCP
  servers are reachable)
- **Depends on**: none
- **Category**: bug / robustness
- **Planned at**: commit `20e77a1`, 2026-06-12

## Why this matters

Backlog I9, discovered live on 2026-06-12: a converted agent's emitted module
connects each **http** MCP server with a raw top-level
`await connectMcpServer(...)`. If ANY configured http MCP server is
unreachable at boot (DNS failure, server down, stale URL), the await throws,
the Node process exits 1, the container never listens, and the whole deploy
fails with "the deployed agent did not start listening in time" — with the
real cause buried in container logs. One bad URL = no agent.

The fix already half-exists: PR #40 introduced an emitted
`tryConnectMcpServer` helper (warn + boot without that server's tools) — but
it is emitted and used **only for bridged stdio servers**. This plan routes
http servers through the same helper. An agent that boots without one
integration is strictly more useful than an agent that doesn't boot.

Live evidence: deploying the converter test fixture (which declares an
`inventory` http MCP pointing at the placeholder `https://mcp.example.com`)
crashed at boot with `getaddrinfo ENOTFOUND mcp.example.com` while the bridged
`filesystem` stdio server had already started fine.

## Current state

Relevant files:

- `packages/converter/src/emit.ts` — `emitAgentModule` builds the emitted
  agent source. http MCP blocks (lines 192–200, raw `await connectMcpServer`),
  tolerant helper emitted only when `bridgedMcp.length > 0` (lines 205–227),
  assembly (254–255).
- `packages/converter/test/convert.test.ts` — fixture-driven smoke test; the
  fixture (`test/fixtures/claude-project/.mcp.json`) declares BOTH an `inventory`
  http server and a `filesystem` stdio server. Line 64 asserts the RAW pattern
  (`'connectMcpServer("inventory"'`) — this assertion MUST be updated by this
  plan.

### Excerpt 1 — http servers use the raw connect (emit.ts:192–200, verbatim)

```ts
  for (const mcp of httpMcp) {
    const id = uniqueIdent(mcp.name + "Mcp", used);
    mcpIdents.push(id);
    const env = `${upperSnake(mcp.name)}_MCP_URL`;
    const opts: string[] = [`  url: process.env.${env} ?? ${q(mcp.url)},`];
    if (mcp.transport === "sse") opts.push(`  transport: "sse",`);
    if (mcp.headers && Object.keys(mcp.headers).length > 0) opts.push(`  headers: ${json(mcp.headers)},`);
    mcpBlocks.push(`const ${id} = await connectMcpServer(${q(mcp.name)}, {\n${opts.join("\n")}\n});`);
  }
```

### Excerpt 2 — the tolerant helper, currently gated on bridged servers (emit.ts:205–227)

```ts
  const tryHelperLines: string[] = [];
  if (bridgedMcp.length > 0) {
    tryHelperLines.push(
      `/**`,
      ` * Bridged stdio MCP servers run as a sidecar started by start.mjs. If the`,
      ` * bridge is not up (e.g. a bare \`node dist/server.mjs\` run that bypasses`,
      ` * start.mjs), boot WITHOUT those tools instead of crashing.`,
      ` */`,
      `async function tryConnectMcpServer(name: string, options: Parameters<typeof connectMcpServer>[1]) {`,
      `  try {`,
      `    return await connectMcpServer(name, options);`,
      `  } catch (err) {`,
      `    console.warn(\`[fleet] bridged MCP "\${name}" unavailable: \${err instanceof Error ? err.message : String(err)}\`);`,
      `    return { tools: [] as never[] };`,
      `  }`,
      `}`,
    );
    for (const mcp of bridgedMcp) {
      const id = uniqueIdent(mcp.name + "Mcp", used);
      mcpIdents.push(id);
      mcpBlocks.push(`const ${id} = await tryConnectMcpServer(${q(mcp.name)}, {\n  url: "http://127.0.0.1:${mcp.port}/mcp",\n});`);
    }
  }
```

### Excerpt 3 — assembly (emit.ts:254–255) and the existing test assertions (convert.test.ts:64–67)

```ts
  if (tryHelperLines.length) out.push(tryHelperLines.join("\n"), "");
  if (mcpBlocks.length) out.push(mcpBlocks.join("\n\n"), "");
```

```ts
  assert(agent.includes('connectMcpServer("inventory"'), "http MCP wired via connectMcpServer");
  assert(agent.includes("INVENTORY_MCP_URL"), "MCP url overridable via env");
  assert(agent.includes('tryConnectMcpServer("filesystem"'), "bridged stdio MCP uses tryConnectMcpServer");
```

NOTE: `'tryConnectMcpServer("inventory"'` CONTAINS the substring
`'connectMcpServer("inventory"'` — so assertion line 64 would still pass after
the change and silently stop testing what it claims. The test update in Step 3
must make the distinction explicit.

Repo conventions: emitted-code comments are full sentences explaining why
(match the existing helper's docblock); converter changes are verified against
pinned versions — no new dependencies are involved here.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck converter | `pnpm --filter @inteliside/gateway-converter typecheck` | exit 0 |
| Converter tests | `pnpm --filter @inteliside/gateway-converter test` | `ALL GOOD` |
| Build converter (core imports dist) | `pnpm --filter @inteliside/gateway-converter build` | exit 0 |
| Core suite (downstream consumer gate) | `pnpm --filter @inteliside/gateway-core test` | all `ALL GOOD` |

## Scope

**In scope** (the only files you should modify):

- `packages/converter/src/emit.ts`
- `packages/converter/test/convert.test.ts`

**Out of scope** (do NOT touch, even though they look related):

- `packages/converter/src/read.ts` — server parsing is correct.
- `start.mjs` emission / Dockerfile emission — the bridge sidecar path works
  (live-verified 2026-06-12).
- Fleet Core (`packages/core/**`) — nothing changes on the gateway side.
- Reporting unreachable servers in the deploy UI — a worthwhile follow-up,
  not this plan (the emitted `console.warn` lands in container logs, which the
  deploy log already surfaces).

## Git workflow

- Branch off `origin/main`: `fix/i9-tolerant-http-mcp`
- Conventional commit, e.g. `fix(converter): boot agent even when an http MCP server is unreachable`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Emit the helper whenever ANY MCP server exists

In `emit.ts`, restructure lines 205–227:

1. Hoist the helper emission out of the `if (bridgedMcp.length > 0)` gate:
   emit `tryHelperLines` when `httpMcp.length > 0 || bridgedMcp.length > 0`
   (the same condition that imports `connectMcpServer`, line 189–191).
2. Generalize the docblock — it currently explains only the bridged case.
   Target text (full sentences, both failure modes):

```
/**
 * Connect an MCP server tolerantly: if it is unreachable at boot (bridged
 * sidecar not started, remote http server down or DNS-unresolvable), boot
 * WITHOUT that server's tools instead of crashing the agent. One missing
 * integration must not take the whole agent down (Fleet backlog I9).
 */
```

3. Keep the `console.warn` line but drop the word "bridged" from the message
   (it now covers both kinds): `[fleet] MCP "${name}" unavailable: ...`.

### Step 2: Route http connects through the helper

Change the http block (line 199) to:

```ts
    mcpBlocks.push(`const ${id} = await tryConnectMcpServer(${q(mcp.name)}, {\n${opts.join("\n")}\n});`);
```

Order note: the helper must be emitted BEFORE the blocks in the output —
already guaranteed by the assembly at 254–255 (`tryHelperLines` first). The
emission order of the `for` loops does not matter beyond that; do not reorder
them.

**Verify**: `pnpm --filter @inteliside/gateway-converter typecheck` → exit 0.

### Step 3: Update the tests so they distinguish raw vs tolerant

In `packages/converter/test/convert.test.ts`:

1. REPLACE line 64's assertion (its substring would pass vacuously — see the
   NOTE in Current state) with:

```ts
  assert(agent.includes('tryConnectMcpServer("inventory"'), "http MCP wired via tolerant tryConnectMcpServer (I9)");
  assert(!agent.includes('= await connectMcpServer('), "no raw top-level connectMcpServer remains (I9: unreachable server must not crash boot)");
```

   (the negative assertion is the real I9 regression guard — the only
   remaining `connectMcpServer(` occurrences must be the import and the call
   INSIDE the helper.)

2. Keep line 65 (`INVENTORY_MCP_URL`) and line 67 (filesystem) unchanged.
3. If the test has a cloudflare-target section asserting MCP emission, run the
   suite first and adjust only assertions that fail due to this change —
   cloudflare emission also flows through the same `mcpBlocks`, so http servers
   on CF get the tolerant helper too (correct: CF has no bridged servers but
   can have http ones).

**Verify**: `pnpm --filter @inteliside/gateway-converter test` → `ALL GOOD`.

### Step 4: Full gates (converter feeds the core from dist)

**Verify**:
`pnpm --filter @inteliside/gateway-converter typecheck` &&
`pnpm --filter @inteliside/gateway-converter test` &&
`pnpm --filter @inteliside/gateway-converter build` &&
`pnpm --filter @inteliside/gateway-core test` → all green.

## Test plan

Covered in Step 3: positive (http wired via helper) + negative (no raw
top-level connect remains) + existing bridged/env-override assertions as
regression gates. Live acceptance (deferred to operator): deploy the test
fixture project (it has the unreachable `inventory` placeholder URL) to
docker-local — the agent must now BOOT, log
`[fleet] MCP "inventory" unavailable: ...` in the container, and still serve
chat with the filesystem tools working.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @inteliside/gateway-converter typecheck` exits 0
- [ ] `pnpm --filter @inteliside/gateway-converter test` exits 0 with the new
      assertions
- [ ] `pnpm --filter @inteliside/gateway-converter build` exits 0
- [ ] `pnpm --filter @inteliside/gateway-core test` exits 0
- [ ] `rg -n 'await connectMcpServer' packages/converter/src/emit.ts` matches
      ONLY the line inside the emitted helper (line ~215 region)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift since `20e77a1`).
- The `tools: [] as never[]` fallback return type stops typechecking against
  the current `@flue/sdk` version (SDK drift) — report; do not invent a new
  Flue type.
- Any cloudflare-target test failure suggests the helper breaks
  `flue build --target cloudflare` — STOP; CF compatibility of emitted code is
  rule #6 territory and must be verified, not patched around.

## Maintenance notes

- Trade-off accepted: a typo'd MCP URL now produces a *booting* agent with a
  warn in container logs instead of a loud deploy failure. The deploy-log
  panel surfaces container output, but a reviewer should confirm the warn is
  greppable (`[fleet] MCP`). Surfacing unreachable servers in the deploy
  report/UI is the natural follow-up (candidate for a future I-PR4/I6 slice —
  the honest per-target parity report).
- If Flue's SDK ever adds a native lazy/retry option on `connectMcpServer`,
  the emitted helper can be retired — note the SDK version when that happens.
