# Plan 007: Bound workflow output sizes — cap accumulation, storage, and rendering (BACKLOG K3)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. Base your branch on `origin/main` AND rebase over plan
> 005's branch/PR if it has landed (it edits the same `#agentRunner`).
>
> **Drift check (run first)**: `git diff --stat 20e77a1..HEAD -- packages/core/src/core.ts packages/core/src/state/db.ts frontend/src/components/WorkflowCanvas/WorkflowCanvas.tsx packages/core/test/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. **Expected drift**: if plan 005
> landed, `#agentRunner` now creates sessions/records usage — the `text +=`
> line still exists inside it; cap that same accumulator.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW (defensive caps; behavior unchanged for normal-size outputs)
- **Depends on**: soft-conflicts with plan 005 (same function `#agentRunner` in
  `core.ts`) — execute AFTER 005, or rebase carefully
- **Category**: robustness
- **Planned at**: commit `20e77a1`, 2026-06-12

## Why this matters

Backlog K3: nothing bounds the size of a workflow node's output. A verbose
agent (or a prompt like "dump the whole file") produces an output string that
is (a) accumulated unbounded in Core memory (`text +=`), (b) shipped to every
connected client in a SINGLE WebSocket frame — twice (`workflow.node.status`
with the full output, then `workflow.run.done` with all outputs), (c) written
to `workflow_runs.outputs_json` without any guard, and (d) rendered in the
canvas inside an untruncated `<pre>`. One multi-megabyte output can stall the
WS connection and freeze the canvas tab. This plan adds one cap at the source
(the runner), making every downstream consumer safe, plus a defensive render
cap in the UI.

## Current state

Relevant files:

- `packages/core/src/core.ts` — `#agentRunner()` (487–508 at plan time): the
  unbounded `text +=` accumulator (line 496). NOTE: if plan 005 landed first,
  this function also creates sessions/records usage — the accumulator is still
  there; only its surroundings changed.
- `packages/core/src/orchestration/index.ts` — engine emits
  `hooks.onNodeStatus(id, "completed", { output: out })` (line 252) and the
  output node concatenates upstream outputs (244–249). DO NOT cap in the
  engine: interpolation (`{{node.output}}` into the next prompt) must see the
  real (already-capped-at-source) string; double-capping is pointless.
- `packages/core/src/core.ts` `#runWorkflow` — relays `info?.output` into the
  `workflow.node.status` event (line 550) and the final outputs into
  `workflow.run.done` (line 558).
- `packages/core/src/state/db.ts` — `finishWorkflowRun` (~530–535) stringifies
  `outputs_json` with no size guard.
- `frontend/src/components/WorkflowCanvas/WorkflowCanvas.tsx` — outputs panel
  renders `<pre>{value}</pre>` untruncated (line 353).

### Excerpt 1 — the unbounded accumulator (core.ts:493–498)

```ts
        return new Promise<string>((resolve, reject) => {
          let text = "";
          const sink: RunSink = {
            onEvent: (e) => {
              if (e.type === "message.delta" && e.role === "assistant") text += e.content;
              else if (e.type === "message.completed" && e.role === "assistant") text = e.content;
            },
```

Note BOTH branches are unbounded: the delta accumulation AND the
`message.completed` overwrite (a single completed event can carry the full
giant content).

### Excerpt 2 — db write without guard (db.ts:530–535)

```ts
  finishWorkflowRun(id: string, status: string, outputs: Record<string, string>): void {
    this.#db
      .prepare(`UPDATE workflow_runs SET status = ?, outputs_json = ?, ended_at = ? WHERE id = ?`)
      .run(status, JSON.stringify(outputs), new Date().toISOString(), id);
  }
```

(verify exact shape in file — signature may differ slightly; follow the live code)

### Excerpt 3 — untruncated render (WorkflowCanvas.tsx:350–355)

```tsx
                {Object.entries(outputs).map(([id, value]) => (
                  <div key={id} className="wf-output-row">
                    <code>{id}</code>
                    <pre>{value}</pre>
                  </div>
                ))}
```

Repo conventions: why-comments citing the backlog id (K3); config via
`process.env.GATEWAY_*` with a sane default (exemplar:
`GATEWAY_WORKFLOW_NODE_TIMEOUT_MS` in `core.ts:109`); tests as plain tsx
scripts with the local `assert` helper.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck core | `pnpm --filter @inteliside/gateway-core typecheck` | exit 0 |
| Orchestrator tests | `pnpm --filter @inteliside/gateway-core exec tsx test/orchestrator.test.ts` | `ALL GOOD` |
| Workflow tests | `pnpm --filter @inteliside/gateway-core exec tsx test/workflow.test.ts` | `ALL GOOD` |
| Full core suite | `pnpm --filter @inteliside/gateway-core test` | all `ALL GOOD` |
| Frontend build | `pnpm --filter @inteliside/gateway-frontend build` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `packages/core/src/core.ts` — cap the accumulator in `#agentRunner`.
- `frontend/src/components/WorkflowCanvas/WorkflowCanvas.tsx` — render cap.
- The canvas stylesheet (found via `rg "wf-outputs" frontend/src`) — if the
  render cap needs a class.
- `packages/core/test/orchestrator.test.ts` OR a new
  `packages/core/test/workflow-output-cap.test.ts` — tests.

**Out of scope** (do NOT touch, even though they look related):

- `packages/core/src/orchestration/index.ts` — the engine. Capping at the
  source (runner) means the engine never sees an oversized string; engine
  changes would double-cap and complicate interpolation semantics.
- `packages/core/src/state/db.ts` — with the source cap, `outputs_json` is
  bounded to (cap × number of nodes); a worst-case 20-node workflow at 256 KB
  each is ~5 MB JSON — acceptable for SQLite, and adding a second truncation
  layer creates ambiguity about which marker survived. (If the operator wants
  a DB guard later, it's a follow-up.)
- `packages/core/src/api.ts` / `frontend/src/lib/api.ts` — no wire change.
- Chat-session streaming (`#startSession`) — interactive sessions stream
  incrementally and have different UX expectations; K3 is about workflows.

## Git workflow

- Branch off `origin/main`: `feat/k3-output-caps`
- Conventional commits, e.g. `feat(core): cap workflow node output accumulation (K3)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Cap at the source — `#agentRunner`

In `packages/core/src/core.ts`:

1. Add a module-level constant near the other config reads (exemplar at
   line 108–110):

```ts
// K3: bound each workflow node's output. A verbose agent must not be able to
// stall the WS connection or freeze the canvas with a multi-megabyte string.
// The cap applies at the source so every consumer (events, interpolation,
// outputs_json, UI) inherits it.
const WORKFLOW_OUTPUT_CAP = Number(process.env.GATEWAY_WORKFLOW_OUTPUT_CAP_BYTES ?? 262_144); // 256 KiB
const OUTPUT_TRUNCATION_MARKER = "\n…[output truncated by Fleet: exceeded GATEWAY_WORKFLOW_OUTPUT_CAP_BYTES]";
```

2. In `#agentRunner`'s sink, cap BOTH branches:

```ts
            onEvent: (e) => {
              if (e.type === "message.delta" && e.role === "assistant") {
                if (text.length < WORKFLOW_OUTPUT_CAP) text += e.content;
              } else if (e.type === "message.completed" && e.role === "assistant") {
                text = e.content;
              }
            },
```

   and truncate ONCE at resolution time (covers the `message.completed`
   overwrite and the slight delta overshoot):

```ts
            onDone: (status, usage) => {
              if (text.length > WORKFLOW_OUTPUT_CAP) {
                text = text.slice(0, WORKFLOW_OUTPUT_CAP) + OUTPUT_TRUNCATION_MARKER;
              }
              // ...existing resolve/reject (and plan-005 usage recording, if landed)
            },
```

   Adjust to the live shape of `onDone` after plan 005 (it takes
   `(status, usage)` there). Keep the cap logic separate from the usage logic.

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0; both
`test/orchestrator.test.ts` and `test/workflow.test.ts` still `ALL GOOD`
(their outputs are tiny — regression gate).

### Step 2: Defensive render cap in the canvas

In `WorkflowCanvas.tsx`, the outputs panel (and the Runs panel if plan 006 has
landed — same markup): render at most a fixed prefix per value with an
expandable remainder, e.g.:

```tsx
<pre>{value.length > 4000 ? value.slice(0, 4000) + "\n… (" + (value.length - 4000) + " more chars)" : value}</pre>
```

A `details`/`summary` expander is also acceptable if it matches the file's
style; keep it simple — this is a seatbelt, not a feature. UI strings in
English. If plan 006's Runs panel exists, apply the same cap there (it renders
stored historical outputs that may predate the source cap).

**Verify**: `pnpm --filter @inteliside/gateway-frontend build` → exit 0.

### Step 3: Tests

Engine-level is the cheapest place to prove the cap end-to-end through the
runner: in `packages/core/test/orchestrator.test.ts` the runner is a fake — the
cap lives in core.ts, NOT the engine, so instead test through `GatewayCore`:

Preferred: new file `packages/core/test/workflow-output-cap.test.ts`, modeled
on `test/workflow.test.ts` (GatewayCore against a temp `GATEWAY_DATA_DIR`).
Drive `#agentRunner` indirectly: set
`process.env.GATEWAY_WORKFLOW_OUTPUT_CAP_BYTES = "1024"` BEFORE importing
`../src/core.js`, register a fake agent adapter the same way workflow.test.ts
does for its scenarios — **if workflow.test.ts has no fake-adapter precedent,
STOP on this step and fall back to**: exporting nothing new; instead assert the
cap constant indirectly is NOT possible — in that case write the test at the
unit seam: extract the truncation into a small exported helper
`capWorkflowOutput(text: string, cap: number): string` in `core.ts` (pure
function, no class state), use it in the sink, and unit-test the helper
(≥4 assertions: under-cap unchanged; over-cap truncated with marker; exact-cap
unchanged; marker present only when truncated).

The helper-extraction route is the DEFAULT if wiring a fake adapter through
GatewayCore requires touching production code beyond `core.ts`.

**Verify**: `pnpm --filter @inteliside/gateway-core exec tsx test/<the test file>.ts`
→ `ALL GOOD`; full `pnpm --filter @inteliside/gateway-core test` → all pass.

### Step 4: Full gates

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` &&
`pnpm --filter @inteliside/gateway-core test` &&
`pnpm --filter @inteliside/gateway-frontend build` → all exit 0.

## Test plan

Covered in Step 3 (cap helper / through-core) plus existing suites as
regression gates. Live acceptance (deferred to operator): run a workflow whose
prompt asks the agent to dump a long output; confirm the canvas stays
responsive and the stored output ends with the truncation marker.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @inteliside/gateway-core typecheck` exits 0
- [ ] `pnpm --filter @inteliside/gateway-core test` exits 0 incl. new cap tests
- [ ] `pnpm --filter @inteliside/gateway-frontend build` exits 0
- [ ] `rg -n "GATEWAY_WORKFLOW_OUTPUT_CAP_BYTES" packages/core/src/core.ts` → present
- [ ] `rg -n "text \+= e.content" packages/core/src/core.ts` shows the
      accumulation only behind a length guard
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `#agentRunner` doesn't match either the plan-time excerpt or plan 005's
  expected post-state (unexpected third shape — drift).
- The fake-adapter route AND the helper-extraction route both require touching
  files outside scope.
- Capping breaks an existing test's expectation about exact output content —
  report which test; do not weaken the test.

## Maintenance notes

- The cap interacts with `{{node.output}}` interpolation: a downstream node's
  prompt sees the truncated text (with the marker). That is intentional —
  document-sized handoffs between nodes should use a future artifact store
  (BACKLOG G3), not inline strings. Reviewer should confirm the marker text
  makes that failure mode obvious to an operator reading a downstream prompt.
- If plan 006's Runs panel landed, historical runs stored BEFORE this plan may
  still hold giant outputs — the UI render cap (Step 2) is the seatbelt there.
- Deferred: a DB-level guard in `finishWorkflowRun` (second truncation layer —
  ambiguity not worth it), and chat-session caps (different UX contract).
