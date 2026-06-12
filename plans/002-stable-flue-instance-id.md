# Plan 002: Persist a stable Flue instanceId per agent so server-side conversation memory survives reconnects

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git fetch && git diff --stat 4d8db05..origin/main -- packages/core/src/adapters/flue.ts packages/core/src/state/db.ts packages/core/src/core.ts packages/core/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Base your branch on `origin/main`
> (4d8db05 or later).

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (additive column + passing an id that the adapter already accepts; no wire-format change)
- **Depends on**: none (001 is merged — PR #37)
- **Category**: direction
- **Planned at**: commit `4d8db05` (origin/main), 2026-06-12

## Why this matters

The Flue runtime persists each agent's full conversation history **server-side**, keyed by `instanceId` (its `SessionData`, stored in the agent's own `data/flue.db`; verified against @flue/runtime 0.10.1). Fleet currently generates a **random** instanceId on every `FlueAdapter.connect()` — so every reconnect (Core restart, health-tick recovery, org auto-connect) abandons the previous server-side history and the agent greets the user with total amnesia, even though the memory infrastructure already exists and already stored everything.

This plan persists one stable instanceId per agent in Fleet's `agents` table and reuses it on every connect. Result: cross-session, cross-restart conversation memory for every connected agent, at zero new infrastructure cost. This is backlog item J1 (`docs/BACKLOG.md` §J).

## Current state

Relevant files:

- `packages/core/src/adapters/flue.ts` — the only agent adapter. `FlueConnectSpec.instanceId?` already exists; `connect()` falls back to a random id.
- `packages/core/src/state/db.ts` — SQLite layer (`node:sqlite`). `agents` table schema, `StoredAgent` interface, `rowToAgent()`, and an idempotent migration helper.
- `packages/core/src/core.ts` — four `FlueAdapter.connect(...)` call sites; two registration paths (`upsertAgent` + `#agents.set`).
- `packages/core/package.json` — the `test` script is an explicit `&&` chain of tsx test files; a new test file must be appended there.

### Excerpt 1 — spec + random fallback (`packages/core/src/adapters/flue.ts:38-52` and `:68-71`)

```ts
export interface FlueConnectSpec {
  /** Where the public Flue app is mounted, e.g. http://localhost:8787 */
  baseUrl: string;
  /** Agent name as served at /agents/<name>/<id>. */
  agentName: string;
  /** Persistent agent-instance id; defaults to a generated one per connect. */
  instanceId?: string;
  /** Optional bearer token for the Flue HTTP/WS routes. */
  token?: string;
}
```

```ts
  static async connect(spec: FlueConnectSpec): Promise<FlueAdapter> {
    const client = createFlueClient({ baseUrl: spec.baseUrl, token: spec.token });
    const instanceId = spec.instanceId ?? "fleet_" + Math.random().toString(36).slice(2, 14);
    const resolved: ResolvedFlueSpec = { baseUrl: spec.baseUrl, agentName: spec.agentName, instanceId, token: spec.token };
```

Also relevant: `connect()` builds identity as `info = { id: spec.agentName, name: spec.agentName, ... }` (line 74) — **the stored agent row's `id` equals the Flue agent name** for connected agents.

### Excerpt 2 — agents schema + StoredAgent + migrations (`packages/core/src/state/db.ts`)

Schema (lines 92–102):

```sql
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  version     TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL,
  source_ref  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

`StoredAgent` (lines 28–39) has `id/name/version/description/model/kind/sourceRef/updatedAt`. `rowToAgent()` (line 729) maps snake_case row → camelCase. Migration pattern (lines 201–226): `#applyMigrations()` calls `#addColumnIfMissing(\`ALTER TABLE ... ADD COLUMN ...\`)` which treats only "duplicate column name" as already-applied — every column added after v1 does BOTH (column in `SCHEMA` for new DBs + `ALTER` for old DBs); see the `preview`/`log`/`repo_owner` precedents at lines 204–208.

### Excerpt 3 — the four connect sites + two registration paths (`packages/core/src/core.ts`)

```ts
// core.ts:256-261 — manual connect + org sync registration
async #registerConnectedAgent(baseUrl: string, agentName: string, token?: string, instanceId?: string): Promise<StoredAgent> {
  const adapter = await FlueAdapter.connect({ baseUrl, agentName, token, instanceId });
  const stored = this.#state.upsertAgent(adapter.info(), "flue", baseUrl);
  this.#agents.set(stored.id, { adapter, kind: "flue", sourceRef: baseUrl, hasToken: !!token });
  return stored;
}
```

```ts
// core.ts:766 — health tick, offline → online reconnect (has `stored` in scope)
const adapter = await FlueAdapter.connect({ baseUrl: stored.sourceRef, agentName: stored.name });
// core.ts:842 — #connectOrgAgents (has `stored` in scope)
const adapter = await FlueAdapter.connect({ baseUrl: stored.sourceRef, agentName: stored.name });
// core.ts:1076 — #reconnectPersisted on boot (has `stored` in scope)
const adapter = await FlueAdapter.connect({ baseUrl: stored.sourceRef, agentName: stored.name });
```

```ts
// core.ts:362-363 — deploy registration (result.adapter was connected by the
// deployer at flue-deployer.ts:201 with NO instanceId, i.e. a fresh random one)
const stored = this.#state.upsertAgent(result.adapter.info(), "flue", result.baseUrl);
this.#agents.set(stored.id, { adapter: result.adapter, kind: "flue", sourceRef: result.baseUrl, hasToken: false });
```

### Excerpt 4 — core test chain (`packages/core/package.json:17`)

```
"test": "tsx test/flue.test.ts && tsx test/session-history.test.ts && tsx test/deploy-log-db.test.ts && ... && tsx test/org.test.ts"
```

### Repo conventions

- Tests are plain tsx scripts with a local `assert(cond, msg)` helper printing `✓`/`❌` and setting `process.exitCode` — see `packages/core/test/health.test.ts:34-41` for the helper style and `packages/core/test/deploy-log-db.test.ts` for a DB-only test (no live agent).
- Comments explain why, full sentences; cite WU/backlog ids where the precedent does (e.g. "WU-06:", "B3:" in `#applyMigrations`).
- Conventional commits, no AI attribution.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Converter build (core imports converter from dist; fresh worktrees lack it) | `pnpm --filter @inteliside/gateway-converter build` | exit 0 |
| Core typecheck | `pnpm --filter @inteliside/gateway-core typecheck` | exit 0 |
| Core tests | `pnpm --filter @inteliside/gateway-core test` | all pass, exit 0 |
| New test alone | `pnpm --filter @inteliside/gateway-core exec tsx test/flue-instance-id.test.ts` | `ALL GOOD` |
| Frontend build (gate) | `pnpm --filter @inteliside/gateway-frontend build` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):

- `packages/core/src/adapters/flue.ts` (expose the resolved instanceId)
- `packages/core/src/state/db.ts` (column + StoredAgent field + setter + migration)
- `packages/core/src/core.ts` (pass stored id at the 4 connect sites; persist after the 2 registrations)
- `packages/core/test/flue-instance-id.test.ts` (create)
- `packages/core/package.json` (append the new test to the chain)

**Out of scope** (do NOT touch):

- `packages/core/src/api.ts` and `frontend/**` — the Gateway API does not change; rule #11 (api.ts mirror) is NOT triggered. `agent.connectFlue` already carries an optional `instanceId` request field; do not alter it.
- `packages/core/src/deploy/flue-deployer.ts` — the deployer keeps connecting with a fresh id at deploy time; the core persists whatever the adapter actually used (see Step 4). No deployer change.
- `packages/core/src/neutral.ts` — no neutral-protocol change. Passing `session` per conversation is backlog J2, a separate plan; do not implement it here.
- `packages/core/src/orchestration/**`.

## Git workflow

- Branch: `feat/j1-stable-instance-id` based on `origin/main`.
- Conventional commits, e.g. `feat(core): persist stable flue instanceId per agent`.
- Do NOT push or open a PR.

## Steps

### Step 1: Expose the resolved instanceId on `FlueAdapter`

In `packages/core/src/adapters/flue.ts`, add a public getter near `info()` (line ~86):

```ts
/** The agent-instance id this adapter resolved at connect time. Fleet persists
 * it per agent so Flue's server-side SessionData (keyed by instanceId) survives
 * reconnects instead of being abandoned to a fresh random id (backlog J1). */
get instanceId(): string {
  return this.#spec.instanceId;
}
```

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

### Step 2: DB — column, field, setter

In `packages/core/src/state/db.ts`:

2a. In the `agents` CREATE TABLE (lines 92–102), add after `source_ref`:

```sql
  flue_instance_id TEXT,
```

2b. In `#applyMigrations()` (line ~201), following the existing precedents:

```ts
// J1: stable Flue instanceId per agent — Flue keys server-side conversation
// memory (SessionData) by instanceId; persisting it makes memory survive reconnects.
this.#addColumnIfMissing(`ALTER TABLE agents ADD COLUMN flue_instance_id TEXT`);
```

2c. `StoredAgent` (lines 28–39): add `flueInstanceId: string | null;` with a doc comment. Update `rowToAgent()` (line 729) to map `flue_instance_id` (add the field to the `AgentDbRow` interface near it). Confirm `upsertAgent()` (line 233) does NOT write this column (it must survive upserts — read the UPDATE/INSERT it issues; if the upsert uses explicit column lists, the new column is naturally untouched).

2d. Add a setter next to the other agent methods:

```ts
/** Persist the Flue instanceId an adapter resolved for this agent (J1). */
setAgentFlueInstanceId(agentId: string, instanceId: string): void {
  // UPDATE agents SET flue_instance_id = ?, updated_at = ? WHERE id = ?
}
```

(match the statement style used by neighboring methods).

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

### Step 3: Reuse the stored id at the three reconnect sites

In `packages/core/src/core.ts`, at lines 766, 842, and 1076 — each already has the `stored: StoredAgent` row in scope — change the connect call to:

```ts
const adapter = await FlueAdapter.connect({
  baseUrl: stored.sourceRef,
  agentName: stored.name,
  instanceId: stored.flueInstanceId ?? undefined,
});
```

and immediately after each site's successful registration into `this.#agents`, persist a newly minted id once:

```ts
if (!stored.flueInstanceId) this.#state.setAgentFlueInstanceId(stored.id, adapter.instanceId);
```

(Each of the three sites has a race-guard branch that discards the adapter when another path won — only persist on the branch that KEEPS the adapter.)

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

### Step 4: The two registration paths

4a. `#registerConnectedAgent` (core.ts:256-261): the row id equals the agent name for Flue agents (flue.ts:74), so a prior row can be looked up BEFORE connecting:

```ts
async #registerConnectedAgent(baseUrl: string, agentName: string, token?: string, instanceId?: string): Promise<StoredAgent> {
  // Reuse the persisted instanceId (J1) unless the caller explicitly provided one.
  const prior = this.#state.getAgent(agentName);
  const adapter = await FlueAdapter.connect({
    baseUrl, agentName, token,
    instanceId: instanceId ?? prior?.flueInstanceId ?? undefined,
  });
  const stored = this.#state.upsertAgent(adapter.info(), "flue", baseUrl);
  if (stored.flueInstanceId !== adapter.instanceId) this.#state.setAgentFlueInstanceId(stored.id, adapter.instanceId);
  this.#agents.set(stored.id, { adapter, kind: "flue", sourceRef: baseUrl, hasToken: !!token });
  return stored;
}
```

4b. Deploy registration (core.ts:362-363): after the `upsertAgent` line, persist what the deployer's adapter actually used — a deploy starts a new lifecycle epoch, so OVERWRITE unconditionally:

```ts
// J1: a (re)deploy is a fresh lifecycle epoch — adopt the adapter's instanceId.
this.#state.setAgentFlueInstanceId(stored.id, result.adapter.instanceId);
```

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

### Step 5: Test

Create `packages/core/test/flue-instance-id.test.ts` — DB-level, no live agent, modeled on `deploy-log-db.test.ts` (instantiate the state layer against a temp `GATEWAY_DATA_DIR`, like `health.test.ts:26-28` does). Assert at least:

1. A fresh agent row has `flueInstanceId === null`.
2. `setAgentFlueInstanceId(id, "fleet_abc123")` → `getAgent(id).flueInstanceId === "fleet_abc123"`.
3. `upsertAgent(...)` again for the same id (simulating a reconnect's upsert) → `flueInstanceId` is STILL `"fleet_abc123"` (upsert must not clobber).
4. `listAgents()` surfaces the field too.
5. Migration idempotence: constructing the state layer twice over the same file does not throw (the ALTER runs on an already-migrated DB).

Clean up the temp data dir in a `finally` (match the rmSync pattern of existing tests). Print `ALL GOOD` on success like the others.

Append `&& tsx test/flue-instance-id.test.ts` to the `test` script in `packages/core/package.json` (before or after `deploy-log-db.test.ts` — keep the chain readable).

**Verify**: `pnpm --filter @inteliside/gateway-core exec tsx test/flue-instance-id.test.ts` → `ALL GOOD`; then the full `pnpm --filter @inteliside/gateway-core test` → all suites pass.

### Step 6: Full gates

1. `pnpm --filter @inteliside/gateway-converter build` (worktree prerequisite)
2. `pnpm --filter @inteliside/gateway-core typecheck`
3. `pnpm --filter @inteliside/gateway-core test`
4. `pnpm --filter @inteliside/gateway-frontend build`

**Verify**: all exit 0.

## Test plan

Covered in Step 5 (5 assertions minimum, DB-level). The reconnect-reuse behavior at the three core.ts sites is exercised indirectly by the existing suites (org.test.ts, health flows) and definitively by the operator's live verification: connect an agent, chat, restart the Core, chat again — the agent must remember the earlier conversation (this is the user-visible acceptance of J1; note it in your report as deferred to the operator).

## Done criteria

- [ ] `pnpm --filter @inteliside/gateway-core typecheck` exits 0
- [ ] `pnpm --filter @inteliside/gateway-core test` exits 0 and includes `flue-instance-id.test.ts` in the chain
- [ ] `rg -n "Math.random" packages/core/src/adapters/flue.ts` still matches ONLY line ~70 (the fallback stays — it runs at most once per agent now)
- [ ] `rg -c "setAgentFlueInstanceId" packages/core/src/core.ts` ≥ 4 (three reconnect sites + two registration paths may share code; at minimum 4 distinct persist points: 766-site, 842-site, 1076-site, #registerConnectedAgent, deploy registration)
- [ ] `pnpm --filter @inteliside/gateway-frontend build` exits 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows in-scope files changed vs 4d8db05 and the excerpts no longer match (especially the four connect sites' line numbers).
- `upsertAgent()` turns out to use a column-less `INSERT OR REPLACE` (which would WIPE `flue_instance_id` on every upsert) — that requires a different approach (preserve-on-replace), report first.
- The stored-row-id-equals-agentName assumption fails for any connect path you can see in the code (e.g. org agents are registered under a different id scheme) — report what you found.
- Any existing test in the chain fails for reasons you cannot trace to your change.

## Maintenance notes

- **Backlog J2** (pass `session: <conversation-id>` in the invoke payload) builds directly on this: instanceId scopes the agent's server-side store; `session` names threads within it. Same files (`flue.ts` run(), `core.ts` session start). Plan it next.
- **Privacy trade-off to surface in review**: with a stable instanceId, the remote agent now accumulates conversation history server-side across sessions (that is the point). `agent.delete` does not erase remote state (documented v1 behavior — deletes are local-only); G2/org governance will need a "forget" story.
- **Redeploy semantics**: deploy OVERWRITES the stored id (new epoch). If continuity across redeploys is wanted later, the deployer must accept a pre-resolved instanceId — deliberate non-goal here.
