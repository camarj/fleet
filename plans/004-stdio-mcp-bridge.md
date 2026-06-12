# Plan 004: Bridge stdio MCP servers inside the agent container (Node targets)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git fetch && git diff --stat 97da810..origin/main -- packages/converter/src/types.ts packages/converter/src/read.ts packages/converter/src/emit.ts packages/converter/test/convert.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Base your branch on `origin/main`
> (97da810 or later).

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (changes the emitted artifact set — package.json/Dockerfile/start script; Cloudflare emission must stay clean; the bridge itself can only be fully proven in a live deploy)
- **Depends on**: plan 001 (merged, PR #37 — target-conditional emission)
- **Category**: direction
- **Planned at**: commit `97da810` (origin/main), 2026-06-12

## Why this matters

Backlog I2 (`docs/BACKLOG.md` §I) — the second slice of converter parity. Claude Code projects commonly depend on **stdio MCP servers** (e.g. `npx -y @modelcontextprotocol/server-filesystem`). Flue's `connectMcpServer` is HTTP-only — DEFINITIVE: its `McpTransport` type is the two-member union `'streamable-http' | 'sse'` (verified against `@flue/sdk@0.10.1`). Today the converter just reports these servers as unmapped, so a converted agent silently loses tools its instructions rely on.

But the deployed agent's container is a full Node environment, and every container target (docker-local, dokploy, fly, github→CI image) runs the Dockerfile's CMD. So the fix is to **run the stdio server INSIDE the container** behind a tiny stdio→HTTP bridge (`supergateway`), and point `connectMcpServer` at `http://127.0.0.1:<port>`. Cloudflare Workers cannot do this (no subprocesses) — there the honest unmapped report stays.

Verified bridge facts (npm registry + project README, 2026-06-12 — do not re-derive):
- Package `supergateway`, latest `3.4.3`, "Run MCP stdio servers over SSE, Streamable HTTP or visa versa". No `engines` constraint published.
- CLI: `npx -y supergateway --stdio "<command>" --outputTransport streamableHttp --port 8000` → serves Streamable HTTP at `/mcp` (default path), default port 8000.

## Current state

Relevant files (all in `packages/converter/`):

- `src/types.ts` — `McpServerSpec` (stdio variant has `command`/`args`/`env`), `ConvertReport`.
- `src/read.ts` — parses stdio servers fully AND pushes the unmapped item at read time.
- `src/emit.ts` — emitter; HTTP MCP wiring, scaffold files (`emitPackageJson`, `DOCKERFILE` const, `emitEnvExample`, `emitReadme`), and since PR #37 a `nodeSandbox = opts.target !== "cloudflare"` flag threaded through.
- `test/convert.test.ts` — fixture-driven smoke test; the fixture `test/fixtures/claude-project/.mcp.json` already declares a stdio server.

### Excerpt 1 — read-time unmapped push (`src/read.ts:34-42`)

```ts
  for (const s of mcpServers) {
    if (s.kind === "stdio") {
      unmapped.push({
        kind: "mcp-stdio",
        name: s.name,
        reason: `Flue's connectMcpServer is HTTP-only, so this stdio server (command: ${s.command}) was NOT wired. Expose it over HTTP/SSE to use it.`,
      });
    }
  }
```

and the parser (`src/read.ts:161-170`) keeps `command`, `args?`, `env?` on the spec:

```ts
    } else if (typeof cfg["command"] === "string") {
      out.push({
        name,
        kind: "stdio",
        command: cfg["command"] as string,
        args: Array.isArray(cfg["args"]) ? (cfg["args"] as string[]) : undefined,
        env: isStringRecord(cfg["env"]) ? (cfg["env"] as Record<string, string>) : undefined,
      });
    }
```

### Excerpt 2 — emit-time state (`src/emit.ts`, post-PR #37)

`emitFlueProject` (line ~26) computes `nodeSandbox = opts.target !== "cloudflare"` and filters `httpMcp = project.mcpServers.filter(... kind === "http")`. The HTTP MCP block in `emitAgentModule` (lines ~131-143):

```ts
  for (const mcp of httpMcp) {
    imports.add("connectMcpServer");
    const id = uniqueIdent(mcp.name + "Mcp", used);
    mcpIdents.push(id);
    const env = `${upperSnake(mcp.name)}_MCP_URL`;
    const opts: string[] = [`  url: process.env.${env} ?? ${q(mcp.url)},`];
    if (mcp.transport === "sse") opts.push(`  transport: "sse",`);
    ...
    mcpBlocks.push(`const ${id} = await connectMcpServer(${q(mcp.name)}, {\n${opts.join("\n")}\n});`);
  }
```

Scaffold: `emitPackageJson()` (line ~186) — a CONSTANT manifest (name "flue-agent") so Docker layer cache shares `npm install` across agents; dependencies today: `@flue/runtime`, `agents`. `DOCKERFILE` const (line ~216) ends with `CMD ["node", "dist/server.mjs"]` (line 226). `emitEnvExample(apiKeyEnv, httpMcp, env)` (line ~301). `emitReadme(project, specifier, apiKeyEnv, httpMcp, unmapped, nodeSandbox)`.

### Excerpt 3 — fixture (`test/fixtures/claude-project/.mcp.json`)

```json
{
  "mcpServers": {
    "inventory": { "type": "http", "url": "https://mcp.example.com/inventory", "headers": { "Authorization": "Bearer REPLACE_ME" } },
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] }
  }
}
```

### Deployment-path facts (verified — context for design, deployer NOT in scope)

- docker-local: `docker build` + `docker run` → Dockerfile CMD runs (`flue-deployer.ts:221-235`). fly/github/dokploy likewise build the Docker image.
- local-process (tests only, not in the UI): `flue build` then `spawn("node", ["dist/server.mjs"])` directly (`flue-deployer.ts:265-270`) — it BYPASSES start.mjs, so the bridge will not be running there. The emitted agent must therefore boot gracefully when a bridged server is unreachable (see Step 3's `tryConnectMcpServer`).

### Conventions

- Emitter is deterministic: same input + same options ⇒ byte-identical output. Bridge ports must derive from sorted server names, never from randomness.
- Secrets: env var NAMES only, never values (CLAUDE.md rule #8). A stdio server's `env` block values from the source config are DROPPED; only the names surface in `.env.example`.
- Comments: full sentences, why-focused, cite verified versions.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Converter typecheck | `pnpm --filter @inteliside/gateway-converter typecheck` | exit 0 |
| Converter tests | `pnpm --filter @inteliside/gateway-converter test` | ALL GOOD |
| Converter build | `pnpm --filter @inteliside/gateway-converter build` | exit 0 |
| Core typecheck | `pnpm --filter @inteliside/gateway-core typecheck` | exit 0 |
| Core tests | `pnpm --filter @inteliside/gateway-core test` | all pass |
| Frontend build (gate) | `pnpm --filter @inteliside/gateway-frontend build` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `packages/converter/src/types.ts`
- `packages/converter/src/read.ts`
- `packages/converter/src/emit.ts`
- `packages/converter/test/convert.test.ts`
- `packages/converter/test/fixtures/claude-project/.mcp.json` (add an `env` block to the stdio fixture server — see Step 6)

**Out of scope** (do NOT touch):

- `packages/core/**` (including `flue-deployer.ts` — the graceful-boot helper makes a deployer change unnecessary) and `frontend/**` (no Gateway API change; rule #11 not triggered).
- `packages/converter/src/cli.ts`, `src/providers.ts`.
- Hooks/permissions/slash-commands reporting (backlog I4/I5/I6 — separate plans).

## Git workflow

- Branch: `feat/i-pr2-stdio-mcp-bridge` based on `origin/main`.
- Conventional commits, e.g. `feat(converter): bridge stdio MCP servers in-container for node targets`.
- Do NOT push or open a PR.

## Steps

### Step 1: Types

In `src/types.ts`:

1a. Add to `ConvertReport`:

```ts
  /** Stdio MCP servers wired in-container via the supergateway bridge (node targets). */
  mcpStdioBridged: string[];
```

**Verify**: `pnpm --filter @inteliside/gateway-converter typecheck` → errors ONLY about the missing field in `emit.ts`'s report literal (expected until Step 3) — or add the field with `[]` placeholder in the same commit to keep typecheck green; your choice, but typecheck must be green by the end of Step 3.

### Step 2: Move the stdio unmapped decision from read time to emit time

In `src/read.ts`, DELETE the `for (const s of mcpServers) { if (s.kind === "stdio") { unmapped.push(...) } }` block (lines 34-42 excerpt above). The parser keeps emitting the full stdio spec; whether it's bridged or unmapped now depends on the target, which only `emit.ts` knows.

**Verify**: `pnpm --filter @inteliside/gateway-converter typecheck` → exit 0 (the variable `mcpServers` is still used below for the project object).

### Step 3: Emit the bridge (emit.ts)

3a. In `emitFlueProject`, after the `httpMcp` filter, compute the stdio sets:

```ts
const stdioMcp = project.mcpServers
  .filter((m): m is Extract<typeof m, { kind: "stdio" }> => m.kind === "stdio")
  .sort((a, b) => a.name.localeCompare(b.name)); // deterministic port assignment
// A --stdio arg with embedded whitespace/quotes would need shell quoting inside
// the bridge; refuse honestly rather than emit a fragile command line.
const bridgeable = stdioMcp.filter((m) => [m.command, ...(m.args ?? [])].every((a) => !/[\s"']/.test(a) || a === m.command && !/["']/.test(a)));
```

Simplification allowed: treat a server as bridgeable when `[...(m.args ?? [])].every(a => !/[\s"']/.test(a))` AND `!/["']/.test(m.command)` (the command itself may not contain quotes; spaces in the command string are fine because supergateway shells the whole `--stdio` string). Pick ONE rule, implement it exactly, and test it.

- If `nodeSandbox` (i.e. target !== "cloudflare"): `const bridged = bridgeable`, each assigned port `3100 + index` (sorted order). For every NON-bridgeable stdio server, push unmapped with an honest reason (`args contain quoting-unsafe characters`).
- Else (cloudflare): push the SAME unmapped item read.ts used to push, with the reason extended: `"...Cloudflare Workers cannot run subprocesses, so the in-container bridge is unavailable on this target."`

3b. In `emitAgentModule` (new parameter: the `bridged` list with ports), when `bridged.length > 0`:

- Emit ONE helper above the MCP blocks (generated code, full-sentence comment):

```ts
/**
 * Bridged stdio MCP servers run as a sidecar started by start.mjs. If the
 * bridge is not up (e.g. a bare `node dist/server.mjs` run that bypasses
 * start.mjs), boot WITHOUT those tools instead of crashing.
 */
async function tryConnectMcpServer(name: string, options: Parameters<typeof connectMcpServer>[1]) {
  try {
    return await connectMcpServer(name, options);
  } catch (err) {
    console.warn(`[fleet] bridged MCP "${name}" unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { tools: [] as never[] };
  }
}
```

- Per bridged server, emit (mirroring the HTTP block's ident/spread pattern):

```ts
const filesystemMcp = await tryConnectMcpServer("filesystem", {
  url: "http://127.0.0.1:3100/mcp",
});
```

and include its ident in the same `tools: [...]` spread as the HTTP ones. (`connectMcpServer` defaults to streamable-http — supergateway's `--outputTransport streamableHttp` matches; no `transport` field needed.)

3c. New emitted file `start.mjs` (only when `bridged.length > 0`), generated by a new `emitStartMjs(bridged)` — the emitted content:

```js
/**
 * Container entrypoint — starts one supergateway bridge per stdio MCP server,
 * waits for each port to accept connections, then starts the Flue server.
 * Generated by @inteliside/gateway-converter; bridge facts verified against
 * supergateway 3.4.3 (--stdio + --outputTransport streamableHttp, path /mcp).
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";

const BRIDGES = [
  { name: "filesystem", port: 3100, command: "npx -y @modelcontextprotocol/server-filesystem /data" },
];

const children = [];
for (const b of BRIDGES) {
  // The command is passed as ONE argv entry — no shell interpolation on our side.
  const child = spawn(
    "npx",
    ["supergateway", "--stdio", b.command, "--outputTransport", "streamableHttp", "--port", String(b.port)],
    { stdio: "inherit" }, // env inherited: container env (incl. the server's vars) reaches the wrapped process
  );
  children.push(child);
}

function waitForPort(port, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tryOnce = () => {
      const sock = connect({ port, host: "127.0.0.1" }, () => { sock.destroy(); resolve(true); });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) resolve(false);
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

for (const b of BRIDGES) {
  const up = await waitForPort(b.port);
  if (!up) console.warn(`[fleet] bridge "${b.name}" did not come up on :${b.port} — the agent will boot without it`);
}

const server = spawn("node", ["dist/server.mjs"], { stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { server.kill(sig); for (const c of children) c.kill(sig); });
}
server.on("exit", (code) => { for (const c of children) c.kill("SIGTERM"); process.exit(code ?? 0); });
```

(The `BRIDGES` array is the generated part — build it from the bridged list; everything else is a fixed template. `b.command` = `[command, ...args].join(" ")`.)

3d. Scaffold conditionals (all keyed on `bridged.length > 0`):

- `emitPackageJson(bridged: boolean)`: when bridged, add `"supergateway": "3.4.3"` to dependencies and set `"start": "node start.mjs"`. Update the constancy comment honestly: the manifest is now byte-identical across agents WITH the same bridging class (two Docker cache classes instead of one).
- `DOCKERFILE` → `emitDockerfile(bridged: boolean)`: when bridged, `CMD ["node", "start.mjs"]`; else unchanged.
- `emitEnvExample(...)`: add the stdio servers' env var NAMES (from `m.env` keys, values dropped — rule #8) with a comment naming the server.
- `emitReadme(...)`: when bridged, add a short section listing each bridged server and its internal port; when a stdio server was unmapped (CF or quoting), it already lands in "Not mapped".
- Report literal: `mcpStdioBridged: bridged.map((m) => m.name)`.

**Verify**: `pnpm --filter @inteliside/gateway-converter typecheck` → exit 0.

### Step 4: Existing-test reconciliation

The current `convert.test.ts` asserts `unmapped.some(u => u.kind === "mcp-stdio" && u.name === "filesystem")` for the DEFAULT (node) convert — that expectation flips: on node the server is now BRIDGED. Update that assertion to the cloudflare section (where it must still hold) and assert its ABSENCE in the default section.

**Verify**: `pnpm --filter @inteliside/gateway-converter test` → ALL GOOD after Step 5's additions (run it after Step 5 if you prefer one pass).

### Step 5: New tests

In `convert.test.ts`:

Default (node) convert:
1. `r.mcpStdioBridged` includes `"filesystem"`; `r.unmapped` has NO `mcp-stdio` item.
2. Agent module includes `tryConnectMcpServer("filesystem"` and `http://127.0.0.1:3100/mcp`.
3. Emitted files include `start.mjs` containing `--outputTransport`, `streamableHttp`, and the joined command `npx -y @modelcontextprotocol/server-filesystem /data`.
4. `package.json` has `"supergateway": "3.4.3"` and `"start": "node start.mjs"`; `Dockerfile` CMD is `["node", "start.mjs"]`.
5. `.env.example` includes `FS_TOKEN=` (from the fixture env added in Step 6).

Cloudflare convert (`{ target: "cloudflare" }`):
6. `r.mcpStdioBridged` is empty; `r.unmapped` HAS the `mcp-stdio` item for `filesystem` (reason mentions Cloudflare).
7. No `start.mjs` in the file set; `package.json` has NO supergateway dep; Dockerfile CMD is `["node", "dist/server.mjs"]`.
8. Determinism: convert the fixture twice with the same options → identical file sets (if such an assertion already exists, confirm it still passes; otherwise add a quick `JSON.stringify(filesA) === JSON.stringify(filesB)` check for the default convert).

**Verify**: `pnpm --filter @inteliside/gateway-converter test` → ALL GOOD with all new assertions.

### Step 6: Fixture env block

In `test/fixtures/claude-project/.mcp.json`, extend the `filesystem` server with `"env": { "FS_TOKEN": "" }` so the env-name surfacing path is exercised (assertion 5).

**Verify**: covered by the Step 5 test run.

### Step 7: Full gates

1. `pnpm --filter @inteliside/gateway-converter typecheck`
2. `pnpm --filter @inteliside/gateway-converter test`
3. `pnpm --filter @inteliside/gateway-converter build`
4. `pnpm --filter @inteliside/gateway-core typecheck`
5. `pnpm --filter @inteliside/gateway-core test`
6. `pnpm --filter @inteliside/gateway-frontend build`

**Verify**: all exit 0.

## Test plan

Steps 4–6 (≥9 assertions). What unit tests CANNOT prove (say so in your report): that supergateway actually boots and serves `/mcp` in a real container — that is the operator's live acceptance: deploy the fixture-like project to docker-local and confirm the agent lists the stdio server's tools (`mcp.call` events) in a chat.

## Done criteria

- [ ] `pnpm --filter @inteliside/gateway-converter test` exits 0 with the new node-bridged and cloudflare-unmapped assertions
- [ ] `pnpm --filter @inteliside/gateway-converter build` exits 0
- [ ] `pnpm --filter @inteliside/gateway-core typecheck` and `test` exit 0 (core consumes the converter from dist — rebuild first)
- [ ] `pnpm --filter @inteliside/gateway-frontend build` exits 0
- [ ] `rg -n "mcp-stdio" packages/converter/src/read.ts` returns NO matches (the decision moved to emit)
- [ ] `rg -c "supergateway" packages/converter/src/emit.ts` ≥ 2 (dependency + start.mjs template)
- [ ] `git status` shows no modified files outside the in-scope list

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check fails or the emit.ts excerpts don't match (PR #37 moved lines; the plan's line refs are approximate — match on CONTENT).
- `ConvertReport` is consumed somewhere that breaks when `mcpStdioBridged` is added (search `report.unmapped` consumers in `packages/core` — `flue-deployer.ts` destructures the report; an added field should be inert, but if core typecheck fails on it, report).
- The deterministic-output property breaks (the existing determinism assertion fails and you cannot trace it to an ordering bug in YOUR sets — sort everything by name).
- You find yourself wanting to modify `flue-deployer.ts` or `api.ts` — the seam was misjudged; report instead.

## Maintenance notes

- **J4 (Engram cloud memory)** builds directly on this: the org's converted agents will bundle `engram mcp` as one more bridged stdio server + cloud autosync env. Keep `emitStartMjs` general (a list of bridges), not filesystem-specific.
- **supergateway is pinned at 3.4.3** — bump deliberately and re-verify the CLI flags (`--stdio`, `--outputTransport streamableHttp`, default path `/mcp`) against its README; they are wire-load-bearing for every converted agent.
- **Reviewer focus**: (1) the cloudflare emission must be byte-identical to pre-plan output except for the unmapped reason text; (2) `tryConnectMcpServer` must wrap ONLY bridged servers — remote HTTP MCP servers keep failing loudly (existing semantics); (3) no env VALUES anywhere in emitted files.
- Live verification debt after merge: docker-local deploy with a stdio server → agent boots, bridge port comes up, tools usable in chat; and a `local-process` run still boots (degraded, warning logged).
