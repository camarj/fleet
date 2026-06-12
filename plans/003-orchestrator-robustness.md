# Plan 003: Orchestrator robustness — node timeouts, orphaned-run reconciliation, concurrent-run guard

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git fetch && git diff --stat 5b950de..origin/main -- packages/core/src/orchestration/index.ts packages/core/src/core.ts packages/core/src/state/db.ts packages/core/test/orchestrator.test.ts packages/core/test/workflow.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Base your branch on `origin/main`
> (5b950de or later).

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches the engine's run loop; fail-fast and abort semantics must not regress — the existing test suite covers them)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5b950de` (origin/main), 2026-06-12

## Why this matters

The DAG orchestrator (Phase F5) works but is demo-grade. Three production blockers, all confirmed by code audit (backlog K1/K4/K6, `docs/BACKLOG.md` §K):

1. **K1 — no timeout**: an agent node's `await this.#runner.run(...)` has no deadline. A hung agent (dead connection, deadlocked container) freezes the whole run FOREVER; the user's only out is a manual abort.
2. **K4 — orphaned runs**: `workflow_runs` rows are created with `status='running'` and updated only on completion. If the Core crashes or restarts mid-run, the row stays `'running'` eternally; nothing reconciles it at startup.
3. **K6 — unlimited concurrent runs**: two `workflow.run` requests for the same workflow both start. Concurrent runs against the same agents can interleave state and double cost with no warning.

This plan fixes all three with no Gateway API change (the guard uses the existing `error` event), so frontend rule #11 is NOT triggered.

## Current state

Relevant files:

- `packages/core/src/orchestration/index.ts` — the engine. `Orchestrator` class (line 161), `run()` (line 174), the memoized `runNode` closure (lines 196–232), fail-fast catch (lines 237–241).
- `packages/core/src/core.ts` — wiring: `#workflowRuns` map (line 92), abort handler (line 171), shutdown abort loop (lines 208–209), constructor (lines 100–112), `#agentRunner()` sink (lines 478–491), `#runWorkflow` (lines 494–534).
- `packages/core/src/state/db.ts` — `createWorkflowRun`/`finishWorkflowRun` (lines 506–518).
- `packages/core/test/orchestrator.test.ts` — engine unit tests with `FakeRunner implements AgentRunner` (line 36).
- `packages/core/test/workflow.test.ts` — E2E through `GatewayCore.handle()` with a temp DB.

### Excerpt 1 — engine: constructor and the agent-node await (`orchestration/index.ts:161-166` and `:206-228`)

```ts
export class Orchestrator {
  readonly #runner: AgentRunner;

  constructor(runner: AgentRunner) {
    this.#runner = runner;
  }
```

```ts
        hooks.onNodeStatus?.(id, "running");
        try {
          let out: string;
          if (node.kind === "input") {
            out = inputs[node.name ?? id] ?? "";
          } else if (node.kind === "agent") {
            const prompt = interpolate(node.promptTemplate ?? "", inputs, outputs);
            out = await this.#runner.run(node.agentId!, prompt, controller.signal);
          } else {
            // output: concatenate upstream outputs (sorted by node id for determinism).
            ...
          }
          outputs[id] = out;
          hooks.onNodeStatus?.(id, "completed", { output: out });
          return out;
        } catch (err) {
          hooks.onNodeStatus?.(id, "failed", { error: (err as Error).message });
          throw err;
        }
```

`controller` is the run-level AbortController (line 188); external abort and fail-fast both flow through it. The run-level catch (lines 237–241) maps an externally-aborted run to status `"aborted"`, anything else to `"failed"`.

### Excerpt 2 — core wiring (`core.ts`)

```ts
// line 92
readonly #workflowRuns = new Map<string, AbortController>();
// line 171 (workflow.abort handler)
this.#workflowRuns.get(req.runId)?.abort();
// lines 208-209 (shutdown)
for (const controller of this.#workflowRuns.values()) controller.abort();
this.#workflowRuns.clear();
```

Constructor (lines 100–112) — synchronous; no workflow-run reconciliation today:

```ts
constructor(options: GatewayCoreOptions = {}) {
  this.#state = new GatewayState(options.dbPath ?? ":memory:");
  this.#orgStore = new OrgStore();
  this.#orgRegistryOverride = options.orgRegistry;
  this.#orchestrator = new Orchestrator(this.#agentRunner());
  this.#startHealthMonitor(options.healthIntervalMs ?? 15_000);
  void this.#reconnectPersisted();
  void this.#orgSyncOnBoot();
}
```

`#runWorkflow` (lines 494–534, abridged): looks up the workflow, checks agent availability (both synchronous), then:

```ts
const runId = `wfr_${randomUUID()}`;
const controller = new AbortController();
this.#workflowRuns.set(runId, controller);
this.#state.createWorkflowRun(runId, req.workflowId, req.inputs);
emit({ type: "workflow.run.started", runId, workflowId: req.workflowId });

const result = await this.#orchestrator.run(wf, req.inputs, { onNodeStatus: ... }, controller.signal);

this.#state.finishWorkflowRun(runId, result.status, result.outputs);
this.#workflowRuns.delete(runId);
emit({ type: "workflow.run.done", runId, status: result.status, outputs: result.outputs });
```

Note: everything before `await this.#orchestrator.run` is synchronous — a guard checked-and-set in that segment cannot race another `handle()` call (Node is single-threaded).

### Excerpt 3 — DB (`state/db.ts:506-518`)

```ts
createWorkflowRun(id: string, workflowId: string, inputs: Record<string, string>): void {
  this.#db
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_id, status, inputs_json, started_at)
       VALUES (?, ?, 'running', ?, ?)`,
    )
    .run(id, workflowId, JSON.stringify(inputs), new Date().toISOString());
}

finishWorkflowRun(id: string, status: string, outputs: Record<string, string>): void {
  this.#db
    .prepare(`UPDATE workflow_runs SET status = ?, outputs_json = ?, ended_at = ? WHERE id = ?`)
    .run(status, JSON.stringify(outputs), new Date().toISOString(), id);
}
```

### Excerpt 4 — conventions

- Env-var config precedent: `process.env.GATEWAY_*` read at the use site (`server.ts:23-28`, `pricing.ts:27`).
- Engine tests use `FakeRunner implements AgentRunner` (`test/orchestrator.test.ts:36-41`) and the repo's `assert(cond, msg)` helper.
- `workflow.test.ts` boots `GatewayCore` against a temp data dir and drives it via `core.handle(req, emit)` collecting emitted events.
- The engine "NEVER imports adapters" and stays dependency-injected (header comment, `orchestration/index.ts:9-12`). Keep it that way — the timeout lives in the engine, configured via an options object.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Converter build (worktree prerequisite) | `pnpm --filter @inteliside/gateway-converter build` | exit 0 |
| Core typecheck | `pnpm --filter @inteliside/gateway-core typecheck` | exit 0 |
| Engine tests alone | `pnpm --filter @inteliside/gateway-core exec tsx test/orchestrator.test.ts` | `ALL GOOD` |
| Workflow E2E alone | `pnpm --filter @inteliside/gateway-core exec tsx test/workflow.test.ts` | `ALL GOOD` |
| Core tests (full chain) | `pnpm --filter @inteliside/gateway-core test` | all pass, exit 0 |
| Frontend build (gate) | `pnpm --filter @inteliside/gateway-frontend build` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `packages/core/src/orchestration/index.ts` (K1: per-node timeout)
- `packages/core/src/core.ts` (K1 config wiring; K4 reconcile call; K6 guard)
- `packages/core/src/state/db.ts` (K4: reconcile method)
- `packages/core/test/orchestrator.test.ts` (timeout tests)
- `packages/core/test/workflow.test.ts` (K4 + K6 tests)

**Out of scope** (do NOT touch):

- `packages/core/src/api.ts` and `frontend/**` — no new request/event types; the K6 rejection reuses the existing `error` event. Rule #11 NOT triggered.
- Run-history read API (`workflow.runs` list) — that is backlog K5/D2, a separate plan.
- Output size limits (K3), input-key validation (K7) — separate plans.
- `packages/core/src/adapters/**`, `packages/converter/**`.

## Git workflow

- Branch: `feat/k-pr1-orchestrator-robustness` based on `origin/main`.
- Conventional commits, e.g. `feat(orchestration): per-node timeout, orphan reconcile, concurrent-run guard`.
- Do NOT push or open a PR.

## Steps

### Step 1: K1 — per-node timeout in the engine

In `packages/core/src/orchestration/index.ts`:

1a. Add an options type and extend the constructor (keep the old call signature working):

```ts
export interface OrchestratorOptions {
  /** Max wall-clock per agent node. A node exceeding it fails (and fail-fast
   * aborts the run). Input/output nodes are instantaneous and not subject to it. */
  nodeTimeoutMs?: number;
}
```

```ts
const DEFAULT_NODE_TIMEOUT_MS = 600_000; // 10 minutes — generous for real agent work, finite for hangs.

export class Orchestrator {
  readonly #runner: AgentRunner;
  readonly #nodeTimeoutMs: number;

  constructor(runner: AgentRunner, options: OrchestratorOptions = {}) {
    this.#runner = runner;
    this.#nodeTimeoutMs = options.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;
  }
```

1b. In the agent-node branch (currently line 210–212), replace the direct await with a node-scoped controller chained to the run controller plus a timer:

```ts
} else if (node.kind === "agent") {
  const prompt = interpolate(node.promptTemplate ?? "", inputs, outputs);
  // K1: bound each agent node with a wall-clock deadline. The node gets its own
  // controller chained to the run controller, so fail-fast/external abort still
  // cancel it, while a timeout cancels ONLY this node's run (fail-fast then
  // propagates through the normal failure path).
  const nodeCtl = new AbortController();
  const onRunAbort = (): void => nodeCtl.abort();
  controller.signal.addEventListener("abort", onRunAbort, { once: true });
  const timer = setTimeout(() => nodeCtl.abort(), this.#nodeTimeoutMs);
  try {
    out = await this.#runner.run(node.agentId!, prompt, nodeCtl.signal);
  } catch (err) {
    // Distinguish "this node timed out" from "the run was aborted/failed elsewhere".
    if (nodeCtl.signal.aborted && !controller.signal.aborted) {
      throw new Error(`agent node "${id}" timed out after ${this.#nodeTimeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onRunAbort);
  }
}
```

Note `out` is declared with `let out: string;` above the branch — assign, don't redeclare.

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0, then `pnpm --filter @inteliside/gateway-core exec tsx test/orchestrator.test.ts` → existing tests still ALL GOOD (default timeout is far above the fake delays).

### Step 2: K1 — wire the timeout from the Core

In `core.ts` constructor (line 104), pass the option, env-overridable per the repo precedent:

```ts
this.#orchestrator = new Orchestrator(this.#agentRunner(), {
  nodeTimeoutMs: Number(process.env.GATEWAY_WORKFLOW_NODE_TIMEOUT_MS ?? 600_000),
});
```

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

### Step 3: K4 — reconcile orphaned runs at startup

3a. In `state/db.ts`, next to `finishWorkflowRun`:

```ts
/** K4: a Core crash mid-run leaves workflow_runs rows stuck at 'running'.
 * Called once at startup — anything still 'running' belongs to a dead process. */
reconcileOrphanedWorkflowRuns(): number {
  const res = this.#db
    .prepare(
      `UPDATE workflow_runs SET status = 'failed',
         outputs_json = COALESCE(outputs_json, '{}'),
         ended_at = ?
       WHERE status = 'running'`,
    )
    .run(new Date().toISOString());
  return Number(res.changes);
}
```

3b. In the `GatewayCore` constructor, immediately after `this.#state = new GatewayState(...)`:

```ts
// K4: runs left 'running' by a previous process are unfinishable — fail them now.
this.#state.reconcileOrphanedWorkflowRuns();
```

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

### Step 4: K6 — concurrent-run guard per workflow

In `core.ts`:

4a. Next to `#workflowRuns` (line 92):

```ts
/** K6: one active run per workflow — workflowId → runId of the run in flight. */
readonly #activeWorkflowRuns = new Map<string, string>();
```

4b. In `#runWorkflow`, after the missing-agents check and BEFORE creating the runId (all in the synchronous segment — single-threaded Node makes check-then-set safe here):

```ts
// K6: reject a second concurrent run of the same workflow — concurrent runs
// interleave against the same agents and double cost with no benefit in v1.
const activeRun = this.#activeWorkflowRuns.get(req.workflowId);
if (activeRun) {
  emit({ type: "error", message: `workflow is already running (run ${activeRun}) — abort it or wait`, requestType: req.type });
  return;
}
```

and register/unregister alongside the existing map:

```ts
this.#workflowRuns.set(runId, controller);
this.#activeWorkflowRuns.set(req.workflowId, runId);
...
this.#workflowRuns.delete(runId);
this.#activeWorkflowRuns.delete(req.workflowId);
```

Make the delete UNCONDITIONAL on the path after `await this.#orchestrator.run(...)` (it already is — the engine's `run()` never throws; it returns a failed/aborted result). Also clear the map in `shutdown()` next to `#workflowRuns.clear()` (line 209).

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

### Step 5: Engine timeout tests

In `test/orchestrator.test.ts`, add a section using an inline hanging runner (don't modify `FakeRunner` unless trivial):

```ts
// A runner that never resolves until aborted — simulates a hung agent.
const hangingRunner: AgentRunner = {
  run: (_agentId, _prompt, signal) =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
};
```

Assertions (workflow: `input → agent → output`, any minimal valid graph):

1. `new Orchestrator(hangingRunner, { nodeTimeoutMs: 50 })` → `run()` resolves with `status === "failed"` and `error` containing `"timed out after 50ms"`.
2. The failed node's `onNodeStatus` hook received `("failed", { error: /timed out/ })`.
3. External abort still wins: with a long timeout (e.g. 60_000) and an external `AbortController` aborted ~20ms after start, the result is `status === "aborted"` (NOT a timeout failure) — proves the chained-controller logic distinguishes the two.
4. Fail-fast unaffected: a two-branch graph where one agent fails immediately still aborts the slow sibling (this exists — just confirm the existing parallel/failure tests still pass).

**Verify**: `pnpm --filter @inteliside/gateway-core exec tsx test/orchestrator.test.ts` → ALL GOOD including new assertions.

### Step 6: E2E tests for K4 + K6

In `test/workflow.test.ts`, following its existing GatewayCore-with-temp-db pattern:

**K4**: using the state layer through a first core (or `GatewayState` directly against the same db file): insert a run via `createWorkflowRun("wfr_orphan", <wfId>, {})`, close/discard that core, construct a NEW `GatewayCore` over the same `dbPath`, then assert the row's status is `'failed'` and `ended_at` is set (query through whatever read surface exists; if none, use a direct `GatewayState` instance on the same file — both objects must be closed/cleaned at the end).

**K6**: with a saved minimal workflow (input → output, no agents — same fixture style the file already uses):

```ts
const events1: ServerEvent[] = [];
const events2: ServerEvent[] = [];
const p1 = core.handle({ type: "workflow.run", workflowId, inputs: {} }, (e) => events1.push(e));
// fired in the same tick, BEFORE awaiting p1 — the guard must reject it:
const p2 = core.handle({ type: "workflow.run", workflowId, inputs: {} }, (e) => events2.push(e));
await Promise.all([p1, p2]);
```

Assert: `events1` contains `workflow.run.started` and `workflow.run.done`; `events2` contains an `error` event whose message includes `"already running"` and NO `workflow.run.started`. Then assert a THIRD run (after the first completed) starts normally — the guard must clear.

**Verify**: `pnpm --filter @inteliside/gateway-core exec tsx test/workflow.test.ts` → ALL GOOD.

### Step 7: Full gates

1. `pnpm --filter @inteliside/gateway-converter build`
2. `pnpm --filter @inteliside/gateway-core typecheck`
3. `pnpm --filter @inteliside/gateway-core test`
4. `pnpm --filter @inteliside/gateway-frontend build`

**Verify**: all exit 0.

## Test plan

Steps 5–6 (≥7 new assertions): timeout fail + hook message + abort-vs-timeout distinction + fail-fast regression; orphan reconcile on boot; concurrent guard reject + guard clears. Live acceptance deferred to the operator: a real workflow against a deliberately stopped agent container must fail with the timeout message instead of hanging.

## Done criteria

- [ ] `pnpm --filter @inteliside/gateway-core typecheck` exits 0
- [ ] `pnpm --filter @inteliside/gateway-core test` exits 0 (orchestrator + workflow suites include the new assertions)
- [ ] `rg -n "nodeTimeoutMs" packages/core/src/orchestration/index.ts packages/core/src/core.ts` shows the option in both (engine definition + core wiring)
- [ ] `rg -n "reconcileOrphanedWorkflowRuns" packages/core/src` shows exactly 2 sites (db.ts definition + core.ts constructor call)
- [ ] `rg -c "activeWorkflowRuns" packages/core/src/core.ts` ≥ 4 (declaration, guard, set, delete, shutdown clear)
- [ ] `pnpm --filter @inteliside/gateway-frontend build` exits 0
- [ ] `git status` shows no modified files outside the in-scope list

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows in-scope files changed vs 5b950de and the excerpts don't match (especially `orchestration/index.ts:206-228` and `core.ts:494-534`).
- The engine's `run()` turns out to THROW anywhere (the guard-cleanup in Step 4 assumes it always returns a result) — report before adding try/finally.
- The existing abort test in `orchestrator.test.ts` fails after Step 1 — the chained-controller change broke abort semantics; report with the failing assertion.
- `workflow.test.ts`'s same-tick double-handle turns out to be racy in practice (events interleave differently than specified) — report what you observed instead of loosening the assertions.

## Maintenance notes

- **K5/D2 (run history API)** will read the same `workflow_runs` rows this plan reconciles; the `'failed'`-on-boot semantics should be surfaced there as "interrupted by restart" if a distinct error column is added later.
- **Per-run wall-clock cap** was deliberately omitted: every agent node is bounded, and a DAG is finite, so runs terminate. If unbounded-node-count workflows appear, add a run-level deadline in `#runWorkflow`.
- **Reviewer focus**: the abort-vs-timeout distinction in Step 1 (test 3) is the subtle part — an external abort aborts the run controller, which aborts the node controller via the chained listener; the `!controller.signal.aborted` check is what keeps that case reporting "aborted", not "timed out".
- `GATEWAY_WORKFLOW_NODE_TIMEOUT_MS` is intentionally undocumented in the UI; it's an operator escape hatch, consistent with `GATEWAY_PRICES_PATH`.
