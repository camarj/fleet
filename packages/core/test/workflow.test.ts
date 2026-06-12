/**
 * WU-17 — workflow persistence + API, end to end through GatewayCore.handle().
 *
 * Uses an agent-free workflow (input → output) so the whole API path
 * (save → list → run → node events → done → persistence) is exercised without a
 * live agent. The agent-node execution path is covered by orchestrator.test.ts
 * (engine) and the WU-19 manual acceptance.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/workflow.test.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayState } from "../src/state/index.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".workflow-test");
const DB_PATH = join(DATA_DIR, "fleet.db");
process.env.GATEWAY_DATA_DIR = DATA_DIR;

const { GatewayCore } = await import("../src/core.js");
import type { ClientRequest, ServerEvent } from "../src/api.js";
import type { Workflow } from "../src/orchestration/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

/** Drive one request and collect every emitted event. */
async function send(core: InstanceType<typeof GatewayCore>, req: ClientRequest): Promise<ServerEvent[]> {
  const events: ServerEvent[] = [];
  await core.handle(req, (e) => events.push(e));
  return events;
}

const WF: Workflow = {
  id: "wf-greeting",
  name: "Greeting",
  nodes: [
    { id: "in", kind: "input", name: "topic", position: { x: 0, y: 0 } },
    { id: "out", kind: "output", position: { x: 200, y: 0 } },
  ],
  edges: [{ from: "in", to: "out" }],
};

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  const core = new GatewayCore({ dbPath: DB_PATH });
  try {
    // ── save → list ────────────────────────────────────────────────────────
    console.log("\n[1] save + list …");
    const saved = await send(core, { type: "workflow.save", workflow: WF });
    const list1 = saved.find((e): e is Extract<ServerEvent, { type: "workflows" }> => e.type === "workflows");
    assert(list1?.workflows.length === 1, "workflow.save echoes the workflow list");
    assert(list1?.workflows[0]?.id === "wf-greeting", "saved workflow id round-trips");
    assert(list1?.workflows[0]?.nodes.length === 2, "graph (nodes) persisted");
    assert(list1?.workflows[0]?.nodes.find((n) => n.id === "in")?.position.x === 0, "node positions persisted");

    // ── run → node events → done ─────────────────────────────────────────────
    console.log("\n[2] run + node status + done …");
    const ran = await send(core, { type: "workflow.run", workflowId: "wf-greeting", inputs: { topic: "hello" } });
    const started = ran.find((e): e is Extract<ServerEvent, { type: "workflow.run.started" }> => e.type === "workflow.run.started");
    assert(!!started, "workflow.run.started emitted");
    const nodeStatuses = ran.filter((e): e is Extract<ServerEvent, { type: "workflow.node.status" }> => e.type === "workflow.node.status");
    assert(nodeStatuses.some((e) => e.nodeId === "in" && e.status === "completed"), "input node completed");
    assert(nodeStatuses.some((e) => e.nodeId === "out" && e.status === "completed"), "output node completed");
    const done = ran.find((e): e is Extract<ServerEvent, { type: "workflow.run.done" }> => e.type === "workflow.run.done");
    assert(done?.status === "completed", "run.done status completed");
    assert(done?.outputs["out"] === "hello", "output node returned the run input value");

    // ── run with a missing agent is rejected ─────────────────────────────────
    console.log("\n[3] run referencing an offline agent is rejected …");
    const wfAgent: Workflow = {
      id: "wf-agent",
      name: "Needs agent",
      nodes: [
        { id: "in", kind: "input", name: "q", position: { x: 0, y: 0 } },
        { id: "a", kind: "agent", agentId: "ghost", promptTemplate: "{{input.q}}", position: { x: 200, y: 0 } },
      ],
      edges: [{ from: "in", to: "a" }],
    };
    await send(core, { type: "workflow.save", workflow: wfAgent });
    const rejected = await send(core, { type: "workflow.run", workflowId: "wf-agent", inputs: { q: "x" } });
    assert(
      rejected.some((e) => e.type === "error" && e.message.includes("ghost")),
      "running a workflow with an offline agent emits an error naming the agent",
    );

    // ── delete ───────────────────────────────────────────────────────────────
    console.log("\n[4] delete …");
    const afterDelete = await send(core, { type: "workflow.delete", workflowId: "wf-agent" });
    const list2 = afterDelete.find((e): e is Extract<ServerEvent, { type: "workflows" }> => e.type === "workflows");
    assert(list2?.workflows.some((w) => w.id === "wf-agent") === false, "deleted workflow is gone from the list");
    assert(list2?.workflows.some((w) => w.id === "wf-greeting") === true, "other workflows remain");
  } finally {
    await core.shutdown();
  }

  // ── persistence across Core restarts ───────────────────────────────────────
  console.log("\n[5] workflows survive a Core restart …");
  const core2 = new GatewayCore({ dbPath: DB_PATH });
  try {
    const list = await send(core2, { type: "workflow.list" });
    const wfs = list.find((e): e is Extract<ServerEvent, { type: "workflows" }> => e.type === "workflows");
    assert(wfs?.workflows.some((w) => w.id === "wf-greeting") === true, "saved workflow persists after restart");
  } finally {
    await core2.shutdown();
  }

  // ── K4: orphaned run reconciliation ─────────────────────────────────────────
  console.log("\n[6] K4 — orphaned runs are reconciled on Core startup …");
  {
    const K4_DB_PATH = join(DATA_DIR, "k4.db");
    // Seed: create a run that is left 'running' (simulates a crash mid-run).
    const seedState = new GatewayState(K4_DB_PATH);
    // A FK-valid workflow must exist before the run row can be inserted.
    seedState.saveWorkflow({ id: "wf-k4", name: "K4 Test", nodes: [], edges: [] });
    seedState.createWorkflowRun("wfr_orphan", "wf-k4", {});
    seedState.close();

    // Boot a new Core over the same DB — constructor must reconcile immediately.
    const coreK4 = new GatewayCore({ dbPath: K4_DB_PATH });

    // Query through a second GatewayState instance (same file).
    const verifyState = new GatewayState(K4_DB_PATH);
    const runRow = verifyState.getWorkflowRunStatus("wfr_orphan");
    verifyState.close();
    await coreK4.shutdown();

    assert(runRow !== null, "K4: orphaned run row still exists after reconcile");
    assert(runRow?.status === "failed", "K4: orphaned run was moved to status 'failed'");
    assert(runRow?.endedAt !== null, "K4: orphaned run has ended_at set after reconcile");
  }

  // ── K5: workflow.runs read API ───────────────────────────────────────────────
  console.log("\n[K5] workflow.runs — run history read API …");
  {
    const K5_DB_PATH = join(DATA_DIR, "k5.db");
    const coreK5 = new GatewayCore({ dbPath: K5_DB_PATH });
    await send(coreK5, { type: "workflow.save", workflow: WF });

    // Run the workflow twice so we can verify ordering (newest first).
    await send(coreK5, { type: "workflow.run", workflowId: WF.id, inputs: { topic: "first" } });
    await send(coreK5, { type: "workflow.run", workflowId: WF.id, inputs: { topic: "second" } });

    const runsEvents = await send(coreK5, { type: "workflow.runs", workflowId: WF.id });
    const runsEvent = runsEvents.find(
      (e): e is Extract<ServerEvent, { type: "workflow.runs" }> => e.type === "workflow.runs",
    );

    assert(!!runsEvent, "K5: workflow.runs event is emitted");
    assert(runsEvent?.workflowId === WF.id, "K5: workflow.runs event carries the correct workflowId");
    assert((runsEvent?.runs.length ?? 0) >= 2, "K5: runs.length >= 2 after two runs");
    assert(runsEvent?.runs[0]?.status === "completed", "K5: most recent run has status 'completed'");
    assert(JSON.stringify(runsEvent?.runs[0]?.inputs) === JSON.stringify({ topic: "second" }), "K5: most recent run has the second inputs (newest first)");
    assert(runsEvent?.runs[0]?.outputs !== null, "K5: most recent run has non-null outputs");
    assert(runsEvent?.runs[0]?.outputs?.["out"] === "second", "K5: most recent run output node returned the run input");
    // Verify newest-first ordering: runs[0].startedAt >= runs[1].startedAt
    const firstStarted = runsEvent?.runs[0]?.startedAt ?? "";
    const secondStarted = runsEvent?.runs[1]?.startedAt ?? "";
    assert(firstStarted >= secondStarted, "K5: runs are ordered newest first (startedAt descending)");

    await coreK5.shutdown();
  }

  // ── K6: concurrent-run guard ─────────────────────────────────────────────────
  console.log("\n[7] K6 — second concurrent run of the same workflow is rejected …");
  {
    const K6_DB_PATH = join(DATA_DIR, "k6.db");
    const coreK6 = new GatewayCore({ dbPath: K6_DB_PATH });
    // Save the same input→output workflow (no agents).
    await send(coreK6, { type: "workflow.save", workflow: WF });

    const workflowId = WF.id;
    const events1: ServerEvent[] = [];
    const events2: ServerEvent[] = [];
    // Fire both in the same tick before awaiting — guard must reject the second.
    const p1 = coreK6.handle({ type: "workflow.run", workflowId, inputs: {} }, (e) => events1.push(e));
    const p2 = coreK6.handle({ type: "workflow.run", workflowId, inputs: {} }, (e) => events2.push(e));
    await Promise.all([p1, p2]);

    assert(
      events1.some((e) => e.type === "workflow.run.started"),
      "K6: first run emits workflow.run.started",
    );
    assert(
      events1.some((e) => e.type === "workflow.run.done"),
      "K6: first run emits workflow.run.done",
    );
    assert(
      events2.some((e) => e.type === "error" && e.message.includes("already running")),
      "K6: second concurrent run emits error with 'already running'",
    );
    assert(
      !events2.some((e) => e.type === "workflow.run.started"),
      "K6: second concurrent run does NOT emit workflow.run.started",
    );

    // A third run AFTER the first completes must succeed (guard must be cleared).
    const events3: ServerEvent[] = [];
    await coreK6.handle({ type: "workflow.run", workflowId, inputs: {} }, (e) => events3.push(e));
    assert(
      events3.some((e) => e.type === "workflow.run.started"),
      "K6: third run (after first completes) emits workflow.run.started",
    );
    assert(
      events3.some((e) => e.type === "workflow.run.done"),
      "K6: third run (after first completes) emits workflow.run.done",
    );

    await coreK6.shutdown();
  }

  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
