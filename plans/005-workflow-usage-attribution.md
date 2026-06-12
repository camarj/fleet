# Plan 005: Attribute workflow-run usage/cost — `#agentRunner` creates real sessions and records usage (BACKLOG K2)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. Base your branch on `origin/main`.
>
> **Drift check (run first)**: `git diff --stat 20e77a1..HEAD -- packages/core/src/core.ts packages/core/src/orchestration/index.ts packages/core/src/state/db.ts packages/core/test/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (additive recording path; no wire-format change to existing events)
- **Depends on**: none (but plan 007 edits the same `#agentRunner` function — execute 005 BEFORE 007)
- **Category**: bug / observability
- **Planned at**: commit `20e77a1`, 2026-06-12

## Why this matters

Backlog K2: when a workflow runs, each agent node executes through
`GatewayCore.#agentRunner()` — which never creates a session and **discards the
usage object** that the adapter hands it on completion. Result: the `usage`
table (and the Usage tab in Settings, shipped as B3/PR #21) is completely blind
to orchestration. Tokens and dollars spent by workflows are invisible. The
`sessions.run_id` and `usage.run_id` columns exist precisely for this and are
never populated. After this plan, every agent-node run records usage attributed
to its agent, its model, and its workflow run — and `usage.summary` picks it up
with zero changes to its SQL (it already groups via `sessions.agent_id`).

## Current state

Relevant files:

- `packages/core/src/core.ts` — `#agentRunner()` (lines 487–508): the injected
  runner the orchestration engine calls per agent node; `#runWorkflow` (510–559)
  creates `runId` and calls `this.#orchestrator.run(...)`; `#startSession`
  (644–679) is the EXEMPLAR — it shows how a normal chat session records usage.
- `packages/core/src/orchestration/index.ts` — the engine. `AgentRunner`
  interface (lines 50–52), `Orchestrator.run()` signature (184–189), the call
  site `this.#runner.run(node.agentId!, prompt, nodeCtl.signal)` (line 231).
- `packages/core/src/state/db.ts` — `createSession` (560–568, hardcodes
  `run_id = NULL`), `endSession` (571–575), `recordUsage` (632+, already accepts
  `runId: string | null`), `usage` table schema (142–153: `session_id` is
  `NOT NULL REFERENCES sessions(id)` — usage CANNOT be recorded without a
  session row), usage-summary SQL groups by `s.agent_id, u.model` (line 674).

### Excerpt 1 — the broken runner (core.ts:487–508, verbatim)

```ts
  #agentRunner(): AgentRunner {
    return {
      run: (agentId, prompt, signal) => {
        const reg = this.#agents.get(agentId);
        if (!reg) return Promise.reject(new Error(`agent "${agentId}" is not connected`));
        return new Promise<string>((resolve, reject) => {
          let text = "";
          const sink: RunSink = {
            onEvent: (e) => {
              if (e.type === "message.delta" && e.role === "assistant") text += e.content;
              else if (e.type === "message.completed" && e.role === "assistant") text = e.content;
            },
            onDone: (status) => (status === "aborted" ? reject(new Error("aborted")) : resolve(text)),
            onError: (_code, message) => reject(new Error(message)),
          };
          const handle = reg.adapter.run({ messages: [{ role: "user", content: prompt }] }, {}, sink);
          if (signal.aborted) void handle.abort();
          else signal.addEventListener("abort", () => void handle.abort(), { once: true });
        });
      },
    };
  }
```

Note `onDone: (status) => ...` — the `RunSink.onDone` signature is
`onDone?(status: RunStatus, usage: Usage | null): void` (`neutral.ts:95`).
The second parameter is silently dropped. That dropped value is this bug.

### Excerpt 2 — how a normal session records usage (core.ts:665–668, the pattern to mirror)

```ts
      onDone: (status, usage) => {
        const costUsd = usage ? computeCostUsd(usage) : null;
        if (usage) this.#state.recordUsage(sessionId, null, usage, costUsd);
        this.#state.endSession(sessionId, status === "aborted" ? "aborted" : "completed");
```

### Excerpt 3 — engine interface + call site (orchestration/index.ts)

```ts
// lines 50–52
export interface AgentRunner {
  run(agentId: string, prompt: string, signal: AbortSignal): Promise<string>;
}
// line 231 (inside Orchestrator.run's runNode)
              out = await this.#runner.run(node.agentId!, prompt, nodeCtl.signal);
```

The engine header comment (lines 10–12) says it "NEVER imports adapters" and is
dependency-injected. Keep that property: the engine may pass *metadata* through,
but must not know about sessions, usage, or the DB.

### Excerpt 4 — createSession hardcodes NULL run_id (db.ts:560–568)

```ts
  createSession(agentId: string, preview = ""): string {
    const id = `sess_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO sessions (id, agent_id, run_id, status, started_at, preview)
         VALUES (?, ?, NULL, 'running', ?, ?)`,
      )
      .run(id, agentId, new Date().toISOString(), preview.slice(0, 80));
    return id;
  }
```

### Excerpt 5 — how the orchestrator is constructed and invoked (core.ts:108, 545–553)

```ts
    this.#orchestrator = new Orchestrator(this.#agentRunner(), {
      nodeTimeoutMs: Number(process.env.GATEWAY_WORKFLOW_NODE_TIMEOUT_MS ?? 600_000),
    });
...
    const result = await this.#orchestrator.run(
      wf,
      req.inputs,
      {
        onNodeStatus: (nodeId, status, info) =>
          emit({ type: "workflow.node.status", runId, nodeId, status, output: info?.output, error: info?.error }),
      },
      controller.signal,
    );
```

The Orchestrator is constructed ONCE with one runner; `runId` is created later,
per run, inside `#runWorkflow`. So the runId must travel through `run()` into
the runner calls — that is the one engine change this plan makes.

Repo conventions that apply:

- Comments are full sentences explaining *why*, citing findings/backlog ids
  where relevant (see the K1/K6 comments in `core.ts:530-531` and
  `orchestration/index.ts:222-225`). Match that.
- Tests are plain tsx scripts with a local `assert(cond, msg)` helper printing
  `✓`/`❌` and setting `process.exitCode` — see `packages/core/test/workflow.test.ts`
  (exercises the full API path through `GatewayCore.handle()` with an in-test
  fake) and `packages/core/test/orchestrator.test.ts` (engine-level with a fake
  AgentRunner).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck core | `pnpm --filter @inteliside/gateway-core typecheck` | exit 0 |
| Engine tests | `pnpm --filter @inteliside/gateway-core exec tsx test/orchestrator.test.ts` | `ALL GOOD` |
| Workflow tests | `pnpm --filter @inteliside/gateway-core exec tsx test/workflow.test.ts` | `ALL GOOD` |
| Full core suite | `pnpm --filter @inteliside/gateway-core test` | all suites `ALL GOOD` |
| Frontend build (unaffected, gate anyway) | `pnpm --filter @inteliside/gateway-frontend build` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `packages/core/src/orchestration/index.ts` — extend `AgentRunner.run` and
  `Orchestrator.run` with an optional run-metadata pass-through.
- `packages/core/src/core.ts` — `#agentRunner()` creates/ends sessions and
  records usage; `#runWorkflow` passes the runId.
- `packages/core/src/state/db.ts` — `createSession` gains an optional `runId`
  parameter (backward compatible).
- `packages/core/test/orchestrator.test.ts` — extend (meta pass-through).
- `packages/core/test/workflow.test.ts` — extend (usage rows recorded).

**Out of scope** (do NOT touch, even though they look related):

- `packages/core/src/api.ts` and `frontend/src/lib/api.ts` — NO wire change in
  this plan. (Run history API is plan 006; do not add events here.)
- `usage.summary` SQL (`db.ts` ~line 660–680) — it already attributes via
  `sessions.agent_id`; once sessions exist for workflow runs it works unchanged.
- The output-size capping in `#agentRunner` (`text +=`) — that is plan 007.
- `packages/core/src/adapters/flue.ts` — the adapter already reports usage.

## Git workflow

- Branch off `origin/main`: `feat/k2-workflow-usage`
- Conventional commits, e.g. `feat(core): attribute workflow node usage to sessions and runs`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Thread run metadata through the engine

In `packages/core/src/orchestration/index.ts`:

1. Extend the `AgentRunner` interface (lines 50–52):

```ts
export interface AgentRunner {
  run(agentId: string, prompt: string, signal: AbortSignal, meta?: { runId?: string; nodeId?: string }): Promise<string>;
}
```

2. Extend `Orchestrator.run`'s signature with a fifth optional parameter
   `meta?: { runId?: string }` (after `signal`), and forward it at the call
   site (line 231):

```ts
              out = await this.#runner.run(node.agentId!, prompt, nodeCtl.signal, { runId: meta?.runId, nodeId: id });
```

Add a one-line why-comment above the interface change: the engine stays
adapter-/storage-agnostic — it only relays opaque run metadata so the Core can
attribute usage (K2).

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0
(existing callers compile because both params are optional), then
`pnpm --filter @inteliside/gateway-core exec tsx test/orchestrator.test.ts` →
`ALL GOOD` (existing fakes ignore the extra arg).

### Step 2: `createSession` accepts an optional runId

In `packages/core/src/state/db.ts`, change `createSession` (560–568) to:

```ts
  createSession(agentId: string, preview = "", runId: string | null = null): string {
    const id = `sess_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO sessions (id, agent_id, run_id, status, started_at, preview)
         VALUES (?, ?, ?, 'running', ?, ?)`,
      )
      .run(id, agentId, runId, new Date().toISOString(), preview.slice(0, 80));
    return id;
  }
```

If `createSession` is re-exported through a state facade
(`packages/core/src/state/index.ts`), check whether the facade declares the
signature; update it identically if so.

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

### Step 3: `#agentRunner` records sessions + usage

In `packages/core/src/core.ts`, rewrite `#agentRunner()` (487–508) so each
`run()` call:

1. Creates a session BEFORE starting the adapter run:
   `const sessionId = this.#state.createSession(agentId, prompt, meta?.runId ?? null);`
   (prompt as preview — `createSession` already truncates to 80 chars).
2. In `onDone(status, usage)`: mirror the `#startSession` pattern (Excerpt 2) —
   `if (usage) this.#state.recordUsage(sessionId, meta?.runId ?? null, usage, computeCostUsd(usage));`
   then `this.#state.endSession(sessionId, status === "aborted" ? "aborted" : "completed");`
   then resolve/reject exactly as today.
3. In `onError`: `this.#state.endSession(sessionId, "error");` then reject as today.
4. Keep the early `if (!reg) return Promise.reject(...)` BEFORE creating the
   session (no session row for a never-started run).
5. Add a why-comment citing K2: workflow node runs were invisible to the usage
   table because no session existed and the usage payload was dropped.

Do NOT emit any `session.*` events for these sessions — they are recording
artifacts, not interactive chat sessions; broadcasting them would confuse the
frontend's session UI. (If a future plan wants live workflow transcripts,
that's a deliberate follow-up.)

`computeCostUsd` is already imported/used in this file (see line 664–666 area);
reuse it.

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

### Step 4: `#runWorkflow` passes the runId

In `core.ts` `#runWorkflow` (the `this.#orchestrator.run(...)` call at 545–553),
add the fifth argument `{ runId }`.

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0, then
`pnpm --filter @inteliside/gateway-core exec tsx test/workflow.test.ts` →
`ALL GOOD` (existing input→output workflow has no agent nodes, so nothing new
fires — this is a regression gate).

### Step 5: Tests

1. `packages/core/test/orchestrator.test.ts` — add assertions that the fake
   runner receives `meta.runId`/`meta.nodeId` when `Orchestrator.run` is called
   with `{ runId: "wfr_test" }` (capture the args in the fake; ≥2 assertions:
   runId forwarded, nodeId is the agent node's id).
2. `packages/core/test/workflow.test.ts` — this test runs through
   `GatewayCore.handle()` with real state. Two options, pick the one the file's
   structure makes natural: (a) if the test already registers a fake agent
   adapter, run a 1-agent-node workflow and assert a `sessions` row with
   `run_id = <runId>` and a `usage` row with the same `run_id` exist; (b) if
   wiring a fake adapter through GatewayCore is NOT feasible without touching
   production code, instead add a DB-level test (modeled on
   `test/flue-instance-id.test.ts`) asserting `createSession(agentId, preview,
   runId)` persists the runId and `recordUsage(sessionId, runId, ...)` rows
   join back to the run. ≥4 assertions total either way.

**Verify**: `pnpm --filter @inteliside/gateway-core test` → all suites `ALL GOOD`.

### Step 6: Full gates

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` &&
`pnpm --filter @inteliside/gateway-core test` &&
`pnpm --filter @inteliside/gateway-frontend build` → all exit 0.

## Test plan

Covered in Step 5: meta pass-through at the engine (orchestrator.test.ts) and
persistence attribution (workflow.test.ts or DB-level). Live acceptance
(deferred to the operator, note it in your report): run a workflow with one
real agent node, then check Settings → Usage shows the tokens, and
`SELECT run_id FROM usage ORDER BY id DESC LIMIT 1` returns the workflow runId.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @inteliside/gateway-core typecheck` exits 0
- [ ] `pnpm --filter @inteliside/gateway-core test` exits 0 with the new assertions
- [ ] `rg -n "onDone: \(status\) =>" packages/core/src/core.ts` returns no
      matches (the usage-dropping closure is gone)
- [ ] `rg -n "VALUES \(\?, \?, NULL, 'running'" packages/core/src/state/db.ts`
      returns no matches (run_id no longer hardcoded NULL)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above don't match the live code (drift since `20e77a1`).
- `usage.session_id` turns out NOT to be `NOT NULL` (schema drift) — the
  session-per-node-run design decision would need revisiting.
- Threading `meta` through `Orchestrator.run` breaks the engine's "no adapter
  imports" rule in any way you can't resolve with an opaque optional param.
- Adding the session rows makes any existing test fail in a way that suggests
  the frontend session list shows workflow sessions unexpectedly — report,
  don't patch the frontend.

## Maintenance notes

- Plan 006 (run history API) and the Usage tab both become more useful with
  this data; if a "per-run cost" column is added to run history later, it joins
  `usage` on `run_id`.
- Plan 007 edits the same `#agentRunner` function (output capping) — whoever
  executes second must rebase carefully over the other's change.
- Reviewer should scrutinize: sessions created by workflows must NOT leak into
  the frontend's interactive session UI (no `session.started` events are
  emitted for them — verify none were added).
- Deferred deliberately: live workflow transcripts (streaming node events to
  the canvas); abort-status sessions are recorded as "aborted" via the existing
  endSession path.
