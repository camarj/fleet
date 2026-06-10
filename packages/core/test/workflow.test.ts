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

  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
