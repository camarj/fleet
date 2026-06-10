/**
 * WU-16 — orchestration engine (DAG runner), no real agents.
 *
 * Uses a fake AgentRunner so the engine is tested in isolation: validation,
 * topological execution, parallelism, templating, node-failure, and abort.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/orchestrator.test.ts
 */

import {
  Orchestrator,
  validateWorkflow,
  interpolate,
  type AgentRunner,
  type Workflow,
  type NodeRunStatus,
} from "../src/orchestration/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

const node = (id: string, kind: "input" | "agent" | "output", extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  position: { x: 0, y: 0 },
  ...extra,
});

/** A runner that echoes "[agentId] prompt" and records call order/concurrency. */
class FakeRunner implements AgentRunner {
  calls: { agentId: string; prompt: string }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  /** agentId → delay ms (to exercise parallelism / ordering). */
  constructor(private readonly delays: Record<string, number> = {}) {}

  async run(agentId: string, prompt: string, signal: AbortSignal): Promise<string> {
    this.calls.push({ agentId, prompt });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await sleep(this.delays[agentId] ?? 5, signal);
      if (agentId === "boom") throw new Error("agent exploded");
      return `${agentId}:${prompt}`;
    } finally {
      this.inFlight--;
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

async function main(): Promise<void> {
  // ── interpolate ─────────────────────────────────────────────────────────────
  console.log("\n[1] interpolate …");
  assert(
    interpolate("Hi {{input.who}}, see {{n1.output}}", { who: "Sam" }, { n1: "RESULT" }) === "Hi Sam, see RESULT",
    "resolves {{input.X}} and {{nodeId.output}}",
  );
  assert(interpolate("{{input.missing}}", {}, {}) === "", "unknown reference → empty string");

  // ── validation ──────────────────────────────────────────────────────────────
  console.log("\n[2] validation …");
  const cyclic: Workflow = {
    id: "w",
    name: "cyclic",
    nodes: [node("a", "agent", { agentId: "x", promptTemplate: "{{b.output}}" }), node("b", "agent", { agentId: "x", promptTemplate: "{{a.output}}" })],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
  };
  assert(validateWorkflow(cyclic).some((e) => e.includes("cycle")), "cycle is rejected by validation");
  assert(
    validateWorkflow({ id: "w", name: "x", nodes: [node("a", "agent")], edges: [] }).some((e) => e.includes("no agentId")),
    "agent node without agentId is rejected",
  );
  assert(
    validateWorkflow({ id: "w", name: "x", nodes: [node("a", "input")], edges: [{ from: "a", to: "z" }] }).some((e) => e.includes("unknown node")),
    "edge to unknown node is rejected",
  );

  // ── sequential chain ────────────────────────────────────────────────────────
  console.log("\n[3] sequential chain input → agent → output …");
  {
    const runner = new FakeRunner();
    const wf: Workflow = {
      id: "w",
      name: "chain",
      nodes: [
        node("in", "input", { name: "topic" }),
        node("a", "agent", { agentId: "writer", promptTemplate: "Write about {{input.topic}}" }),
        node("out", "output"),
      ],
      edges: [
        { from: "in", to: "a" },
        { from: "a", to: "out" },
      ],
    };
    const res = await new Orchestrator(runner).run(wf, { topic: "cats" });
    assert(res.status === "completed", "chain completes");
    assert(runner.calls[0]?.prompt === "Write about cats", "template interpolated the run input");
    assert(res.outputs["out"] === "writer:Write about cats", "output node carries the agent's output");
  }

  // ── fan-out / fan-in parallelism ────────────────────────────────────────────
  console.log("\n[4] fan-out/fan-in runs branches in parallel …");
  {
    const runner = new FakeRunner({ left: 30, right: 30 });
    const wf: Workflow = {
      id: "w",
      name: "fan",
      nodes: [
        node("in", "input", { name: "q" }),
        node("left", "agent", { agentId: "left", promptTemplate: "L:{{input.q}}" }),
        node("right", "agent", { agentId: "right", promptTemplate: "R:{{input.q}}" }),
        node("merge", "agent", { agentId: "merge", promptTemplate: "{{left.output}} + {{right.output}}" }),
        node("out", "output"),
      ],
      edges: [
        { from: "in", to: "left" },
        { from: "in", to: "right" },
        { from: "left", to: "merge" },
        { from: "right", to: "merge" },
        { from: "merge", to: "out" },
      ],
    };
    const res = await new Orchestrator(runner).run(wf, { q: "go" });
    assert(res.status === "completed", "fan-out/fan-in completes");
    assert(runner.maxInFlight >= 2, "left and right ran concurrently (maxInFlight >= 2)");
    assert(res.outputs["out"] === "merge:left:L:go + right:R:go", "merge interpolated both branch outputs");
  }

  // ── node failure fails the whole run ────────────────────────────────────────
  console.log("\n[5] a node failure fails the run …");
  {
    const runner = new FakeRunner();
    const statuses: { id: string; s: NodeRunStatus }[] = [];
    const wf: Workflow = {
      id: "w",
      name: "boom",
      nodes: [
        node("in", "input", { name: "q" }),
        node("bad", "agent", { agentId: "boom", promptTemplate: "{{input.q}}" }),
        node("out", "output"),
      ],
      edges: [
        { from: "in", to: "bad" },
        { from: "bad", to: "out" },
      ],
    };
    const res = await new Orchestrator(runner).run(wf, { q: "x" }, { onNodeStatus: (id, s) => statuses.push({ id, s }) });
    assert(res.status === "failed", "run fails when a node throws");
    assert(res.error?.includes("exploded") === true, "failure carries the agent error message");
    assert(statuses.some((x) => x.id === "bad" && x.s === "failed"), "failed node emitted a failed status");
    assert(!statuses.some((x) => x.id === "out" && x.s === "completed"), "downstream output node never completed");
  }

  // ── abort ───────────────────────────────────────────────────────────────────
  console.log("\n[6] external abort yields status aborted …");
  {
    const runner = new FakeRunner({ slow: 1000 });
    const wf: Workflow = {
      id: "w",
      name: "abort",
      nodes: [node("in", "input", { name: "q" }), node("slow", "agent", { agentId: "slow", promptTemplate: "{{input.q}}" })],
      edges: [{ from: "in", to: "slow" }],
    };
    const ac = new AbortController();
    const p = new Orchestrator(runner).run(wf, { q: "x" }, {}, ac.signal);
    setTimeout(() => ac.abort(), 20);
    const res = await p;
    assert(res.status === "aborted", "aborted run reports status aborted");
  }

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
