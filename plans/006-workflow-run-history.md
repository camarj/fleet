# Plan 006: Workflow run history — read API + Runs panel in the canvas (BACKLOG K5, absorbs D2)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. Base your branch on `origin/main`.
>
> **Drift check (run first)**: `git diff --stat 20e77a1..HEAD -- packages/core/src/api.ts packages/core/src/core.ts packages/core/src/state/db.ts frontend/src/lib/api.ts frontend/src/components/WorkflowCanvas/ packages/core/test/workflow.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (additive API + read-only UI; no change to how runs are written)
- **Depends on**: none (plan 005 adds usage data this UI could later show, but
  there is no code dependency)
- **Category**: dx / product
- **Planned at**: commit `20e77a1`, 2026-06-12

## Why this matters

Backlog K5 (absorbing D2): every workflow run is persisted to `workflow_runs`
(inputs, outputs, status, timestamps) — but there is **no API to read it and no
UI to show it**. The history is write-only: close the tab and the outputs are
gone, even though they sit in SQLite. This plan adds the missing read path:
a `workflow.runs` request in the Gateway API and a Runs panel in the canvas
sidebar that lists past runs and shows a selected run's outputs. After this,
operators can audit what a workflow did yesterday — a precondition for the K10
real-business pilot.

## Current state

Relevant files:

- `packages/core/src/state/db.ts` — `workflow_runs` schema (167–175);
  `createWorkflowRun` (~520), `finishWorkflowRun` (~530),
  `getWorkflowRunStatus` (537–541, the ONLY read — status+ended_at by id);
  `reconcileOrphanedWorkflowRuns` (544+).
- `packages/core/src/api.ts` — workflow requests (150–155: save/list/delete/
  run/abort — **no read of runs**); workflow server events (262–279).
- `packages/core/src/core.ts` — `handle()` switch dispatches request types
  (`case "workflow.list"` etc. — find the workflow cases near the other
  `case` labels); `#runWorkflow` (510–559).
- `frontend/src/lib/api.ts` — the HAND-MAINTAINED mirror of
  `packages/core/src/api.ts` (repo rule #11: touch one → touch the other, same
  PR). Workflow requests at lines 263–268, events at 374+.
- `frontend/src/components/WorkflowCanvas/WorkflowCanvas.tsx` — the canvas.
  Gets `client: GatewayClient` as a prop (line 30); subscribes via
  `client.on((e: ServerEvent) => ...)` (line 96); sends with
  `client.send({ type: "workflow.run", ... })` (line 222); renders the live
  outputs panel at 347–357 (the structural exemplar for the Runs panel).

### Excerpt 1 — workflow_runs schema (db.ts:167–175, verbatim)

```sql
CREATE TABLE IF NOT EXISTS workflow_runs (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  inputs_json  TEXT NOT NULL,
  outputs_json TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT
);
```

### Excerpt 2 — the only existing read (db.ts:537–541)

```ts
  getWorkflowRunStatus(id: string): { status: string; endedAt: string | null } | null {
    return this.#db
      .prepare(`SELECT status, ended_at FROM workflow_runs WHERE id = ?`)
      .get(id) as ... // (cast as in file)
  }
```

### Excerpt 3 — API request union, workflow section (packages/core/src/api.ts:148–155)

```ts
  // ── Orchestration (workflows) ──
  /** Upsert a workflow (by id). The canvas sends the full graph, positions included. */
  | { type: "workflow.save"; workflow: Workflow }
  | { type: "workflow.list" }
  | { type: "workflow.delete"; workflowId: string }
  /** Run a saved workflow with the given run inputs. */
  | { type: "workflow.run"; workflowId: string; inputs: Record<string, string> }
  | { type: "workflow.abort"; runId: string }
```

### Excerpt 4 — server event union, workflow section (packages/core/src/api.ts:262–279)

```ts
  // ── Orchestration (workflows) ──
  | { type: "workflows"; workflows: Workflow[] }
  | { type: "workflow.run.started"; runId: string; workflowId: string }
  /** Per-node progress during a workflow run (v1 emits node-level status, not the agents' internal events). */
  | { type: "workflow.node.status"; runId: string; nodeId: string; status: "running" | "completed" | "failed"; output?: string; error?: string }
  | { type: "workflow.run.done"; runId: string; status: "completed" | "failed" | "aborted"; outputs: Record<string, string> }
```

Convention note: list-style responses reuse a plural noun (`workflows`,
`agents`). For run history use event type `workflow.runs` (matches the request,
like `usage.summary` does — request and response share the type string,
see api.ts:147 and 220).

### Excerpt 5 — the live outputs panel, structural exemplar for the Runs panel (WorkflowCanvas.tsx:347–357)

```tsx
            {outputs && Object.keys(outputs).length > 0 && (
              <div className="wf-outputs">
                <div className="wf-outputs-head">Outputs</div>
                {Object.entries(outputs).map(([id, value]) => (
                  <div key={id} className="wf-output-row">
                    <code>{id}</code>
                    <pre>{value}</pre>
                  </div>
                ))}
              </div>
            )}
```

Repo conventions that apply:

- **Rule #11 (non-negotiable)**: every `packages/core/src/api.ts` change is
  mirrored BY HAND in `frontend/src/lib/api.ts`, same PR.
- Comments: full sentences, why-focused, cite the backlog id (K5/D2).
- Core tests: plain tsx scripts, `assert(cond,msg)` helper — extend
  `packages/core/test/workflow.test.ts` (it already exercises
  save → list → run → done through `GatewayCore.handle()`).
- Frontend styling: existing `wf-*` class family in the canvas CSS — add
  classes alongside (find the stylesheet via `rg "wf-outputs" frontend/src`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck core | `pnpm --filter @inteliside/gateway-core typecheck` | exit 0 |
| Workflow tests | `pnpm --filter @inteliside/gateway-core exec tsx test/workflow.test.ts` | `ALL GOOD` |
| Full core suite | `pnpm --filter @inteliside/gateway-core test` | all `ALL GOOD` |
| Frontend build | `pnpm --filter @inteliside/gateway-frontend build` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `packages/core/src/state/db.ts` — add `listWorkflowRuns`.
- `packages/core/src/api.ts` — add `workflow.runs` request + event.
- `packages/core/src/core.ts` — handle the new request.
- `frontend/src/lib/api.ts` — mirror the wire change (rule #11).
- `frontend/src/components/WorkflowCanvas/WorkflowCanvas.tsx` — Runs panel.
- The canvas stylesheet (the file `rg "wf-outputs"` finds) — new classes only.
- `packages/core/test/workflow.test.ts` — extend.

**Out of scope** (do NOT touch, even though they look related):

- `workflow_runs` WRITE path (`createWorkflowRun`/`finishWorkflowRun`/
  reconcile) — read-only plan.
- Output size capping anywhere — that is plan 007 (the Runs panel will render
  whatever is stored; 007 caps it at the source).
- Usage/cost columns in the panel — needs plan 005's data; deferred.
- `packages/core/src/orchestration/index.ts` — engine untouched.

## Git workflow

- Branch off `origin/main`: `feat/k5-workflow-run-history`
- Conventional commits, e.g. `feat(core): workflow.runs read API` /
  `feat(ui): runs history panel in workflow canvas`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: DB read function

In `packages/core/src/state/db.ts`, next to `getWorkflowRunStatus`, add:

```ts
  /** K5/D2: run history is write-only without this — list a workflow's past runs, newest first. */
  listWorkflowRuns(workflowId: string, limit = 20): Array<{
    id: string;
    status: string;
    inputs: Record<string, string>;
    outputs: Record<string, string> | null;
    startedAt: string;
    endedAt: string | null;
  }> {
    const rows = this.#db
      .prepare(
        `SELECT id, status, inputs_json, outputs_json, started_at, ended_at
         FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(workflowId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      status: r.status as string,
      inputs: JSON.parse(r.inputs_json as string) as Record<string, string>,
      outputs: r.outputs_json ? (JSON.parse(r.outputs_json as string) as Record<string, string>) : null,
      startedAt: r.started_at as string,
      endedAt: (r.ended_at as string | null) ?? null,
    }));
  }
```

Match the exact row-mapping style used by neighboring functions in the file
(check how `getWorkflowRunStatus` casts; follow it). If a state facade
(`state/index.ts`) re-exports DB methods, expose this one identically.

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

### Step 2: Wire types in BOTH api.ts files

In `packages/core/src/api.ts`:

1. Request union (after `workflow.abort`, line ~155):

```ts
  /** List a workflow's past runs (newest first). K5/D2: history was write-only. */
  | { type: "workflow.runs"; workflowId: string; limit?: number }
```

2. Server event union (after `workflow.run.done`, ~279). Export the row shape
   so the frontend mirror can copy it:

```ts
  | { type: "workflow.runs"; workflowId: string; runs: WorkflowRunSummary[] }
```

with, near the other exported interfaces:

```ts
/** One persisted workflow run, as listed by the `workflow.runs` request. */
export interface WorkflowRunSummary {
  id: string;
  status: "running" | "completed" | "failed" | "aborted";
  inputs: Record<string, string>;
  outputs: Record<string, string> | null;
  startedAt: string;
  endedAt: string | null;
}
```

3. Mirror BOTH additions by hand in `frontend/src/lib/api.ts` (requests at
   263–268, events at 374+, interfaces near the other mirrored interfaces).
   Keep field order identical to ease future diffing.

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0 AND
`pnpm --filter @inteliside/gateway-frontend build` → exit 0.

### Step 3: Core handler

In `packages/core/src/core.ts`, find the `switch` in `handle()` (the workflow
cases — `rg -n '"workflow.list"' packages/core/src/core.ts`). Add:

```ts
      case "workflow.runs":
        emit({ type: "workflow.runs", workflowId: req.workflowId, runs: this.#state.listWorkflowRuns(req.workflowId, req.limit ?? 20) });
        return;
```

(match the surrounding cases' style — some use a small private method; if
`workflow.list` delegates to one, do the same.)

The `status` field from the DB is a plain string; if typecheck complains about
assigning it to the literal union, cast at the boundary the way neighboring
code does (check how `getWorkflowRunStatus` consumers handle it).

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

### Step 4: Runs panel in the canvas

In `frontend/src/components/WorkflowCanvas/WorkflowCanvas.tsx`:

1. State: `const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);`
   and `const [selectedRun, setSelectedRun] = useState<string | null>(null);`
2. In the existing `client.on(...)` subscription (line 96), handle
   `e.type === "workflow.runs"` → if `e.workflowId` matches the open workflow,
   `setRuns(e.runs)`.
3. Request history when a workflow is opened AND when a run finishes: where the
   canvas already reacts to `workflow.run.done` (line ~109, `setOutputs`), also
   `client.send({ type: "workflow.runs", workflowId: currentId })`; likewise
   send it when `currentId` changes (the `useEffect` that loads the workflow).
4. Render a `wf-runs` panel under the existing outputs panel (exemplar at
   347–357): a "Runs" heading, one row per run showing status, `startedAt`
   (locale time), and duration when `endedAt` is set; clicking a row toggles
   `selectedRun` and shows that run's `outputs` (reuse the same
   `wf-output-row` markup for the entries) and `inputs` (a compact
   `code` line). Empty history → render nothing (match the `outputs &&` guard
   style).
5. Status → visual: reuse whatever status-color convention the canvas already
   applies to node status if one exists (`rg -n "failed|completed" WorkflowCanvas.tsx`
   around the node-status handling); otherwise plain text is fine.
6. Add the few `wf-runs*` CSS classes next to the `wf-outputs` rules in the
   stylesheet found via `rg "wf-outputs" frontend/src`.

All UI strings in English (repo artifact language).

**Verify**: `pnpm --filter @inteliside/gateway-frontend build` → exit 0.

### Step 5: Tests

Extend `packages/core/test/workflow.test.ts` (it already drives
`GatewayCore.handle()` and runs an input→output workflow to completion). After
the existing run completes, send `{ type: "workflow.runs", workflowId }` and
assert (≥4 assertions):

- a `workflow.runs` event arrives with the matching `workflowId`;
- `runs.length >= 1` and `runs[0].status === "completed"`;
- `runs[0].inputs` equals the inputs the test sent;
- `runs[0].outputs` is non-null and contains the output-node text;
- (bonus) a second run makes `runs.length === 2` with newest first
  (`runs[0].startedAt >= runs[1].startedAt`).

**Verify**: `pnpm --filter @inteliside/gateway-core exec tsx test/workflow.test.ts`
→ `ALL GOOD`; then the full `pnpm --filter @inteliside/gateway-core test`.

### Step 6: Full gates

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` &&
`pnpm --filter @inteliside/gateway-core test` &&
`pnpm --filter @inteliside/gateway-frontend build` → all exit 0.

## Test plan

Covered in Step 5 (API-through-core). UI is verified by the frontend build gate
plus operator live acceptance (deferred — note in your report): open a workflow
that has past runs, see the Runs panel populate, click a run, see its outputs.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @inteliside/gateway-core typecheck` exits 0
- [ ] `pnpm --filter @inteliside/gateway-core test` exits 0 incl. new assertions
- [ ] `pnpm --filter @inteliside/gateway-frontend build` exits 0
- [ ] `rg -n '"workflow.runs"' packages/core/src/api.ts frontend/src/lib/api.ts`
      → matches in BOTH files (rule #11 honored)
- [ ] `rg -n "listWorkflowRuns" packages/core/src/state/db.ts` → present
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift since `20e77a1`).
- `frontend/src/lib/api.ts` has structurally diverged from
  `packages/core/src/api.ts` in the workflow section (mirror already broken) —
  report the divergence instead of silently fixing both.
- The canvas's event subscription doesn't receive the `workflow.runs` event
  (plumbing mismatch in GatewayClient) — report; do not modify
  `gatewayClient.ts` (out of scope).
- Rendering a stored run's outputs hangs the UI on a very large outputs_json —
  note it as evidence for plan 007 and continue (do not implement truncation
  here).

## Maintenance notes

- Plan 007 caps stored output sizes at the source; this panel then never sees
  pathological payloads. Until 007 lands, a huge stored run could render
  slowly — known, accepted.
- When plan 005's usage attribution lands, a natural follow-up is a per-run
  cost column here (join `usage` on `run_id`) — deferred deliberately.
- Reviewer should scrutinize: the api.ts mirror (field-for-field), and that
  `workflow.runs` is requested only for the open workflow (no polling loop).
