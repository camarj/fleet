# Plan 001: Emit `sandbox: local()` so converted agents get a real shell and filesystem on Node targets

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cb0a049..HEAD -- packages/converter/src/emit.ts packages/converter/src/types.ts packages/converter/test/convert.test.ts packages/core/src/deploy/flue-deployer.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (changes the emitted artifact for every future conversion; the Cloudflare build must remain untouched)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `cb0a049`, 2026-06-12

## Why this matters

The converter (`@inteliside/gateway-converter`) turns a Claude Code project into a deployable Flue agent. The Flue runtime ships built-in tools (`read`/`write`/`edit`/`bash`/`grep`/`glob`) in every agent session, but with the **default sandbox**: `just-bash`, an in-memory bash *emulator* (~60 POSIX commands reimplemented in TypeScript, no `child_process`). A converted agent whose instructions say "run `git status`" or "execute this script" silently cannot — `git`, `npm`, real files, and real binaries do not exist in the emulated sandbox.

The fix is one config field Flue already supports: `sandbox: local()` from `@flue/runtime/node` switches the agent to real `child_process.exec` + `node:fs`. On Node-based deploy targets (docker-local, dokploy, fly, github → all run inside a Docker container) this gives converted agents capability parity with the source Claude Code project. On Cloudflare Workers it is impossible (no subprocesses/fs in the Workers runtime), so the emission must be **target-conditional** — emitting the import unconditionally would break `flue build --target cloudflare`.

This is the product's core promise: "your Claude Code agent, deployed and working the same."

## Current state

Relevant files:

- `packages/converter/src/types.ts` — converter type definitions; `ConvertOptions` (lines 78–83) currently has only `provider`/`model`.
- `packages/converter/src/emit.ts` — the deterministic emitter. `emitFlueProject()` (line 25) builds the file set; `emitAgentModule()` (line 77) generates `src/agents/<name>.ts`.
- `packages/converter/test/convert.test.ts` — assert-based smoke test over a fixture project at `test/fixtures/claude-project`.
- `packages/core/src/deploy/flue-deployer.ts` — calls the converter at deploy time; **already knows the target** before converting.

### Excerpt 1 — `ConvertOptions` (`packages/converter/src/types.ts:77-83`)

```ts
/** The choosable provider/model — the converter's central feature. */
export interface ConvertOptions {
  /** Target provider id (e.g. "anthropic", "openai", "openrouter", "cloudflare"). */
  provider?: string;
  /** Target model id under that provider. */
  model?: string;
}
```

Note: the `provider: "cloudflare"` value above is a **model provider** (Workers AI), unrelated to the deploy target. Do not confuse the two.

### Excerpt 2 — agent module assembly (`packages/converter/src/emit.ts:138-159`)

```ts
  // createAgent config
  const cfg: string[] = [`  model: ${q(specifier)},`, `  instructions: ${tpl(project.instructions)},`];
  if (skillIdents.length) cfg.push(`  skills: [${skillIdents.join(", ")}],`);
  if (profileIdents.length) cfg.push(`  subagents: [${profileIdents.join(", ")}],`);
  if (mcpIdents.length) cfg.push(`  tools: [${mcpIdents.map((i) => `...${i}.tools`).join(", ")}],`);
```

and further down (lines 151–159):

```ts
  const typeList = [...typeImports].sort().map((t) => `type ${t}`);
  out.push(`import { ${[...imports].sort().join(", ")}, ${typeList.join(", ")} } from "@flue/runtime";`);
  if (skillImports.length) out.push(...skillImports);
  out.push("");
  if (profileBlocks.length) out.push(profileBlocks.join("\n\n"), "");
  if (mcpBlocks.length) out.push(mcpBlocks.join("\n\n"), "");
  out.push(`export default createAgent(() => ({`);
  out.push(...cfg);
  out.push(`}));`);
```

`emitAgentModule` signature today (line 77–83): `(project, specifier, swapped, httpMcp, unmapped)`.

### Excerpt 3 — deployer convert call (`packages/core/src/deploy/flue-deployer.ts:149-153`)

```ts
    const target: DeployTarget = req.target ?? "docker-local";
    // ...
    onProgress("converting");
    const project = convert(req.sourceDir, { provider: req.provider, model: req.model });
```

`DeployTarget` includes `"docker-local" | "local-process" | "fly" | "cloudflare" | "github" | "dokploy"` (see the type near line 48–72 of the same file). The Cloudflare deploy path runs `flue build --target cloudflare` (line 474) **on the same emitted source files** — this is why the sandbox import must not be emitted for that target.

### Excerpt 4 — verified Flue runtime facts (do not re-derive; verified against the installed package on 2026-06-12)

From `@flue/runtime@0.10.1`, file `dist/node/index.d.mts` (find it via
`fd -H -t d "flue+runtime" node_modules/.pnpm --max-depth 1` then look under
`node_modules/@flue/runtime/dist/node/index.d.mts`):

```ts
// line 24 (doc example):  local({ env: { ...process.env } });
// line 32:
declare function local(options?: LocalSandboxOptions): SandboxFactory;
// line 61: export { ..., local, sqlite };
```

From `dist/agent-execution-store-B0BRThzn.d.mts` (line ~480, inside the agent config interface that `createAgent` accepts):

```ts
  /** Sandbox factory used to construct the initialized environment. */
  sandbox?: false | SandboxFactory | BashFactory;
```

The package's `exports` map exposes `"./node"` with types `./dist/node/index.d.mts` — so `import { local } from "@flue/runtime/node"` resolves in the emitted project (whose `package.json` already depends on `@flue/runtime`; no new dependency needed).

### Repo conventions that apply

- The emitter is **deterministic**: same input + same options ⇒ byte-identical output (header comment, `emit.ts:1-9`). Your change must keep that property — the target flag is part of "options", so different target ⇒ different output is fine; same inputs must stay byte-identical.
- The emitted module already uses `process.env.*` (MCP URL overrides, `emit.ts:132`), so referencing `process.env` in generated code is established practice.
- Comments in this codebase explain *why*, are full sentences, and cite verified versions where relevant (see `emit.ts:16-23`). Match that.
- Conventional commits, no AI attribution (e.g. `feat(converter): ...`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Converter typecheck | `pnpm --filter @inteliside/gateway-converter typecheck` | exit 0 |
| Converter tests | `pnpm --filter @inteliside/gateway-converter test` | all `✓` lines, exit 0 |
| Converter build (required: core imports converter from `dist`) | `pnpm --filter @inteliside/gateway-converter build` | exit 0 |
| Core typecheck | `pnpm --filter @inteliside/gateway-core typecheck` | exit 0 |
| Core tests | `pnpm --filter @inteliside/gateway-core test` | all pass, exit 0 |
| Frontend build (gate from CLAUDE.md) | `pnpm --filter @inteliside/gateway-frontend build` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `packages/converter/src/types.ts`
- `packages/converter/src/emit.ts`
- `packages/converter/test/convert.test.ts`
- `packages/core/src/deploy/flue-deployer.ts` (one line: pass the target)

**Out of scope** (do NOT touch, even though they look related):

- `packages/converter/src/cli.ts` — a `--target` CLI flag is a separate, deferred improvement.
- `packages/converter/src/read.ts` — no reading changes here.
- `packages/core/src/api.ts` and `frontend/src/lib/api.ts` — the Gateway API does **not** change (deploy requests already carry the target); the repo's mirror rule (#11 in CLAUDE.md) is NOT triggered. Do not edit the frontend at all.
- The emitted `Dockerfile`/`package.json` scaffolding — no new dependencies are needed; `local()` comes from `@flue/runtime` already present.

## Git workflow

- Branch: `feat/i-pr1-sandbox-local` off `origin/main` (note: the repo's `main` may be checked out in another worktree; branch from `origin/main`).
- Conventional commits, e.g. `feat(converter): emit sandbox local() for node targets`. One commit for the converter change + tests, one for the deployer line, or a single commit — either is acceptable here.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `target` to `ConvertOptions`

In `packages/converter/src/types.ts`, extend the interface (lines 78–83) to:

```ts
/** The choosable provider/model — the converter's central feature. */
export interface ConvertOptions {
  /** Target provider id (e.g. "anthropic", "openai", "openrouter", "cloudflare"). */
  provider?: string;
  /** Target model id under that provider. */
  model?: string;
  /**
   * Deploy target the emitted project is destined for. Node targets (the
   * default) get `sandbox: local()` — real shell + filesystem inside the
   * container. "cloudflare" omits it: Workers have no subprocesses or fs,
   * and the `@flue/runtime/node` import would break `flue build --target
   * cloudflare`. Verified against @flue/runtime 0.10.1.
   */
  target?: "node" | "cloudflare";
}
```

**Verify**: `pnpm --filter @inteliside/gateway-converter typecheck` → exit 0.

### Step 2: Emit the sandbox conditionally in `emit.ts`

2a. In `emitFlueProject` (line 25), compute the flag and pass it through:

```ts
const nodeSandbox = opts.target !== "cloudflare";
```

Pass `nodeSandbox` as a new parameter to `emitAgentModule(...)` (update the call at line 36 and the function signature at line 77).

2b. In `emitAgentModule`, when `nodeSandbox` is true:

- After the main `@flue/runtime` import line (line 152), push the import:

```ts
out.push(`import { local } from "@flue/runtime/node";`);
```

- In the `cfg` array (lines 139–142), after the `instructions:` entry, add:

```ts
if (nodeSandbox) cfg.push(`  sandbox: local({ env: { ...process.env } }),`);
```

Add a short why-comment above the emission, matching the file's comment style, e.g.:

```ts
// Real shell + filesystem for Node targets: without `sandbox: local()` the
// agent runs Flue's in-memory just-bash emulator and CLAUDE.md instructions
// that invoke git/npm/scripts silently can't execute. Cloudflare Workers
// have no subprocesses, so the import is omitted there (it would break the
// CF build). Verified against @flue/runtime 0.10.1.
```

2c. In `emitReadme` (line 322), in the `## What this agent has` section (line 345–346), add one line reflecting the mode. Thread the `nodeSandbox` boolean into `emitReadme` (update its call at line 54–57 and signature) and emit:

```ts
lines.push(
  nodeSandbox
    ? `- Real shell and filesystem (\`sandbox: local()\`) — the agent can run commands and use files inside its container.`
    : `- Emulated sandbox only (Cloudflare Workers): no real shell or filesystem; bash-like commands run in an in-memory emulator.`,
);
```

**Verify**: `pnpm --filter @inteliside/gateway-converter typecheck` → exit 0, then `pnpm --filter @inteliside/gateway-converter test` → existing assertions still pass (the fixture conversion defaults to the node target).

### Step 3: Pass the target from the deployer

In `packages/core/src/deploy/flue-deployer.ts`, line 153, change:

```ts
const project = convert(req.sourceDir, { provider: req.provider, model: req.model });
```

to:

```ts
const project = convert(req.sourceDir, {
  provider: req.provider,
  model: req.model,
  target: target === "cloudflare" ? "cloudflare" : "node",
});
```

(`target` is already in scope from line 149. Every non-cloudflare DeployTarget — docker-local, local-process, fly, github, dokploy — runs the Node build, so they all map to `"node"`.)

**Verify**: first `pnpm --filter @inteliside/gateway-converter build` (the core imports the converter from `dist` — stale dist will fail or silently use old types), then `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

### Step 4: Tests

In `packages/converter/test/convert.test.ts`, using the existing `assert(...)`/`fileContent(...)` helpers and the `FIXTURE` project, add:

1. In the default-convert section (after the existing agent-module assertions around lines 53–64):

```ts
assert(agent.includes('import { local } from "@flue/runtime/node";'), "node target imports local() sandbox");
assert(agent.includes("sandbox: local({ env: { ...process.env } }),"), "node target emits real sandbox");
```

2. A new cloudflare-target section:

```ts
// ── cloudflare target: the node sandbox must NOT be emitted ──
const cfOut = convert(FIXTURE, { target: "cloudflare" });
const cfAgent = fileContent(cfOut, "src/agents/claude-project.ts");
assert(!cfAgent.includes("@flue/runtime/node"), "cloudflare target omits the node-only import");
assert(!cfAgent.includes("sandbox:"), "cloudflare target omits the sandbox field");
assert(cfAgent.includes("export default createAgent(() => ({"), "cloudflare agent still emits createAgent");
```

3. If the test file has a determinism assertion (same input ⇒ identical output), confirm it still passes unchanged.

**Verify**: `pnpm --filter @inteliside/gateway-converter test` → all assertions pass including the 5 new ones, exit 0.

### Step 5: Full gates

Run, in order:

1. `pnpm --filter @inteliside/gateway-converter typecheck`
2. `pnpm --filter @inteliside/gateway-converter test`
3. `pnpm --filter @inteliside/gateway-converter build`
4. `pnpm --filter @inteliside/gateway-core typecheck`
5. `pnpm --filter @inteliside/gateway-core test`
6. `pnpm --filter @inteliside/gateway-frontend build`

**Verify**: all exit 0.

## Test plan

- New assertions (listed in Step 4): node-target emission (import + field), cloudflare-target omission (both), agent still valid on CF. Model them on the existing assertion style in `convert.test.ts:53-64`.
- The core test suite (`pnpm --filter @inteliside/gateway-core test`) covers the deployer indirectly; no new core test is required for a pass-through option.
- Live verification (a real `docker-local` deploy chatting with an agent that runs `git --version` via its bash tool) is explicitly deferred to the operator — note it in your completion report.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @inteliside/gateway-converter typecheck` exits 0
- [ ] `pnpm --filter @inteliside/gateway-converter test` exits 0 with the 5 new assertions present and passing
- [ ] `pnpm --filter @inteliside/gateway-converter build` exits 0
- [ ] `pnpm --filter @inteliside/gateway-core typecheck` exits 0
- [ ] `pnpm --filter @inteliside/gateway-core test` exits 0
- [ ] `pnpm --filter @inteliside/gateway-frontend build` exits 0
- [ ] `rg -n "sandbox: local" packages/converter/src/emit.ts` returns exactly one emission site
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows in-scope files changed and the "Current state" excerpts no longer match (especially `emit.ts` lines 138–159 or `flue-deployer.ts:149-153`).
- `@flue/runtime` in this repo is no longer `0.10.1` (check `rg '"@flue/runtime"' packages/converter/src/emit.ts` → `FLUE_VERSION`); the `local()`/`sandbox` facts were verified against 0.10.1 only.
- The converter test reveals the fixture's expected output is asserted byte-for-byte somewhere (snapshot-style) and your change breaks an assertion you cannot trace to Steps 2/4 — that means there is an output contract this plan did not account for.
- Adding the option requires touching `api.ts`, the frontend, or `read.ts` — the seam was misjudged; report instead of expanding scope.

## Maintenance notes

- **Security**: this gives deployed agents a real shell *inside their own container*. The blast radius is the container (Docker isolation), but a reviewer should consciously sign off on that trade-off. A future opt-out (`ConvertOptions.sandbox: "emulated"`) was considered and deferred — keep the emission centralized so the option is trivial to add.
- **Plan I-PR2 (stdio MCP bridge)** will modify the emitted `package.json`/`Dockerfile`/start script; it builds directly on this plan's target-conditional emission. Land this first.
- **Flue upgrades**: if `FLUE_VERSION` is bumped, re-verify `local()` is still exported from `@flue/runtime/node` and `sandbox` is still a config field — these were checked against 0.10.1 (rule #4 of CLAUDE.md: never invent Flue behavior).
- **Reviewer focus**: the cloudflare-omission test is the critical one — an unconditional import would break CF deploys at `flue build` time, far from the converter change that caused it.
