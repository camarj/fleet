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
  // template references a node that is not a declared dependency (no edge)
  const danglingRef: Workflow = {
    id: "w",
    name: "x",
    nodes: [
      node("in", "input", { name: "q" }),
      node("a", "agent", { agentId: "x", promptTemplate: "use {{ghost.output}}" }),
    ],
    edges: [{ from: "in", to: "a" }],
  };
  assert(
    validateWorkflow(danglingRef).some((e) => e.includes("ghost") && e.includes("no edge")),
    "template {{nodeId.output}} without a matching edge is rejected",
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

  // ── node timeout ─────────────────────────────────────────────────────────────
  // A runner that never resolves until aborted — simulates a hung agent.
  const hangingRunner: AgentRunner = {
    run: (_agentId, _prompt, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };

  // Reusable workflow: input → agent → output
  const timeoutWf: Workflow = {
    id: "w",
    name: "timeout",
    nodes: [
      node("in", "input", { name: "q" }),
      node("hang", "agent", { agentId: "hang", promptTemplate: "{{input.q}}" }),
      node("out", "output"),
    ],
    edges: [
      { from: "in", to: "hang" },
      { from: "hang", to: "out" },
    ],
  };

  console.log("\n[7] node timeout — run resolves failed with timed-out message …");
  {
    const res = await new Orchestrator(hangingRunner, { nodeTimeoutMs: 50 }).run(timeoutWf, { q: "x" });
    assert(res.status === "failed", "timed-out run reports status failed");
    assert(res.error?.includes("timed out after 50ms") === true, "error message mentions timed out after 50ms");
  }

  console.log("\n[8] node timeout — onNodeStatus hook fires failed with timed-out error …");
  {
    const statuses: { id: string; s: NodeRunStatus; info?: { output?: string; error?: string } }[] = [];
    await new Orchestrator(hangingRunner, { nodeTimeoutMs: 50 }).run(
      timeoutWf,
      { q: "x" },
      { onNodeStatus: (id, s, info) => statuses.push({ id, s, info }) },
    );
    const hangStatus = statuses.find((x) => x.id === "hang" && x.s === "failed");
    assert(!!hangStatus, "hang node emitted a failed status via onNodeStatus");
    assert(hangStatus?.info?.error?.includes("timed out") === true, "onNodeStatus failure info contains timed out");
  }

  console.log("\n[9] external abort wins over node timeout …");
  {
    const ac = new AbortController();
    const p = new Orchestrator(hangingRunner, { nodeTimeoutMs: 60_000 }).run(timeoutWf, { q: "x" }, {}, ac.signal);
    setTimeout(() => ac.abort(), 20);
    const res = await p;
    assert(res.status === "aborted", "external abort yields status aborted (not a timeout failure)");
  }

  console.log("\n[10] fail-fast still aborts slow sibling branch …");
  {
    // Two branches: one fast-failing, one slow. The slow one should be cancelled.
    const mixedRunner: AgentRunner = {
      run: (agentId, _prompt, signal) => {
        if (agentId === "boom") return Promise.reject(new Error("agent exploded"));
        // slow sibling — hangs until aborted
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const failFastWf: Workflow = {
      id: "w",
      name: "failfast",
      nodes: [
        node("in", "input", { name: "q" }),
        node("bad", "agent", { agentId: "boom", promptTemplate: "{{input.q}}" }),
        node("slow", "agent", { agentId: "slow", promptTemplate: "{{input.q}}" }),
        node("out", "output"),
      ],
      edges: [
        { from: "in", to: "bad" },
        { from: "in", to: "slow" },
        { from: "bad", to: "out" },
        { from: "slow", to: "out" },
      ],
    };
    const res = await new Orchestrator(mixedRunner, { nodeTimeoutMs: 60_000 }).run(failFastWf, { q: "x" });
    assert(res.status === "failed", "fail-fast: run fails when a branch errors");
    assert(res.error?.includes("exploded") === true, "fail-fast: error message is from the failing node");
  }

  // ── K2: run metadata forwarded to the runner ────────────────────────────────
  // Verifies that the engine relays opaque run metadata (runId + nodeId) through
  // to the injected AgentRunner so the Core can attribute usage (K2). The engine
  // must not inspect the values — it only passes them through.
  console.log("\n[11] K2 — meta.runId and meta.nodeId forwarded to the runner …");
  {
    const captured: { runId?: string; nodeId?: string }[] = [];
    const metaRunner: AgentRunner = {
      run: (_agentId, _prompt, _signal, meta) => {
        captured.push({ runId: meta?.runId, nodeId: meta?.nodeId });
        return Promise.resolve("ok");
      },
    };
    const wf: Workflow = {
      id: "w",
      name: "meta-test",
      nodes: [
        node("in", "input", { name: "q" }),
        node("a", "agent", { agentId: "agent1", promptTemplate: "{{input.q}}" }),
        node("out", "output"),
      ],
      edges: [
        { from: "in", to: "a" },
        { from: "a", to: "out" },
      ],
    };
    await new Orchestrator(metaRunner).run(wf, { q: "hi" }, {}, undefined, { runId: "wfr_test" });
    assert(captured.length === 1, "K2: runner was called once for the agent node");
    assert(captured[0]?.runId === "wfr_test", "K2: meta.runId forwarded to the runner");
    assert(captured[0]?.nodeId === "a", "K2: meta.nodeId is the agent node's id");

    // Without meta the runner receives undefined — backward-compat for callers
    // that don't supply run metadata (e.g. tests, future non-workflow uses).
    const capturedNoMeta: { runId?: string; nodeId?: string }[] = [];
    const noMetaRunner: AgentRunner = {
      run: (_agentId, _prompt, _signal, meta) => {
        capturedNoMeta.push({ runId: meta?.runId, nodeId: meta?.nodeId });
        return Promise.resolve("ok");
      },
    };
    await new Orchestrator(noMetaRunner).run(wf, { q: "hi" });
    assert(
      capturedNoMeta[0]?.runId === undefined,
      "K2: meta.runId is undefined when Orchestrator.run is called without meta",
    );
  }

  // ── characterization gaps (issue #62) ───────────────────────────────────────
  // The sections below COMPLETE the behaviors not already pinned above, so the
  // engine can be refactored (ExecutionEngine extraction) without silent drift.

  console.log("\n[12] validation — a structurally valid workflow returns no errors …");
  {
    const valid: Workflow = {
      id: "w",
      name: "valid",
      nodes: [
        node("in", "input", { name: "q" }),
        node("a", "agent", { agentId: "x", promptTemplate: "{{input.q}}" }),
        node("out", "output"),
      ],
      edges: [
        { from: "in", to: "a" },
        { from: "a", to: "out" },
      ],
    };
    assert(validateWorkflow(valid).length === 0, "a valid DAG produces an empty error list");
  }

  console.log("\n[13] validation — a duplicate node id is rejected …");
  {
    const dup: Workflow = {
      id: "w",
      name: "dup",
      nodes: [node("a", "input", { name: "q" }), node("a", "output")],
      edges: [],
    };
    assert(
      validateWorkflow(dup).some((e) => e.includes("duplicate node id") && e.includes("a")),
      "two nodes with the same id are rejected naming the id",
    );
  }

  console.log("\n[14] output node concatenates upstream outputs sorted by node id …");
  {
    // Two agent branches feed ONE output node. The output node joins their
    // outputs with '\n', sorted by upstream node id for determinism — regardless
    // of declared edge order. Here edges are declared zeta-before-alpha on purpose.
    const runner = new FakeRunner();
    const wf: Workflow = {
      id: "w",
      name: "collect",
      nodes: [
        node("in", "input", { name: "q" }),
        node("zeta", "agent", { agentId: "z", promptTemplate: "{{input.q}}" }),
        node("alpha", "agent", { agentId: "al", promptTemplate: "{{input.q}}" }),
        node("out", "output"),
      ],
      edges: [
        { from: "in", to: "zeta" },
        { from: "in", to: "alpha" },
        { from: "zeta", to: "out" },
        { from: "alpha", to: "out" },
      ],
    };
    const res = await new Orchestrator(runner).run(wf, { q: "go" });
    assert(res.status === "completed", "collect workflow completes");
    // alpha sorts before zeta → alpha's output line comes first, joined by '\n'.
    assert(res.outputs["out"] === "al:go\nz:go", "output node joins upstream outputs sorted by node id, newline-separated");
  }

  console.log("\n[15] a pre-aborted signal yields status aborted without running nodes …");
  {
    const runner = new FakeRunner();
    const wf: Workflow = {
      id: "w",
      name: "preabort",
      nodes: [node("in", "input", { name: "q" }), node("a", "agent", { agentId: "x", promptTemplate: "{{input.q}}" })],
      edges: [{ from: "in", to: "a" }],
    };
    const ac = new AbortController();
    ac.abort(); // already aborted before run starts
    const res = await new Orchestrator(runner).run(wf, { q: "x" }, {}, ac.signal);
    assert(res.status === "aborted", "an already-aborted signal yields status aborted");
    assert(runner.calls.length === 0, "no agent node runs when the signal is pre-aborted");
  }

  console.log("\n[16] a shared dependency runs exactly once (memoization) …");
  {
    // 'src' feeds BOTH 'left' and 'right'. The engine memoizes node promises, so
    // 'src' must be invoked once even though two downstream nodes depend on it.
    const runner = new FakeRunner();
    const wf: Workflow = {
      id: "w",
      name: "memo",
      nodes: [
        node("in", "input", { name: "q" }),
        node("src", "agent", { agentId: "src", promptTemplate: "{{input.q}}" }),
        node("left", "agent", { agentId: "left", promptTemplate: "{{src.output}}" }),
        node("right", "agent", { agentId: "right", promptTemplate: "{{src.output}}" }),
        node("out", "output"),
      ],
      edges: [
        { from: "in", to: "src" },
        { from: "src", to: "left" },
        { from: "src", to: "right" },
        { from: "left", to: "out" },
        { from: "right", to: "out" },
      ],
    };
    const res = await new Orchestrator(runner).run(wf, { q: "x" });
    assert(res.status === "completed", "diamond workflow completes");
    assert(runner.calls.filter((c) => c.agentId === "src").length === 1, "the shared dependency ran exactly once");
  }

  console.log("\n[17] a completed output branch survives in outputs when a sibling fails …");
  {
    // 'good' completes and feeds output 'okout'; 'bad' explodes and fails the run.
    // The run status is failed, but the already-completed output node must still
    // appear in the partial outputs map (fail-fast preserves what finished).
    const runner = new FakeRunner({ good: 1, boom: 30 });
    const wf: Workflow = {
      id: "w",
      name: "partial",
      nodes: [
        node("in", "input", { name: "q" }),
        node("good", "agent", { agentId: "good", promptTemplate: "{{input.q}}" }),
        node("okout", "output"),
        node("bad", "agent", { agentId: "boom", promptTemplate: "{{input.q}}" }),
        node("badout", "output"),
      ],
      edges: [
        { from: "in", to: "good" },
        { from: "good", to: "okout" },
        { from: "in", to: "bad" },
        { from: "bad", to: "badout" },
      ],
    };
    const res = await new Orchestrator(runner).run(wf, { q: "x" });
    assert(res.status === "failed", "the run fails when the 'bad' branch throws");
    assert(res.outputs["okout"] === "good:x", "the completed output node is preserved in the partial outputs");
    assert(res.outputs["badout"] === undefined, "the never-completed output node is absent from outputs");
  }

  console.log("\n[18] onNodeStatus emits running before completed for each node …");
  {
    const runner = new FakeRunner();
    const events: { id: string; s: NodeRunStatus }[] = [];
    const wf: Workflow = {
      id: "w",
      name: "hooks",
      nodes: [
        node("in", "input", { name: "q" }),
        node("a", "agent", { agentId: "x", promptTemplate: "{{input.q}}" }),
        node("out", "output"),
      ],
      edges: [
        { from: "in", to: "a" },
        { from: "a", to: "out" },
      ],
    };
    await new Orchestrator(runner).run(wf, { q: "x" }, { onNodeStatus: (id, s) => events.push({ id, s }) });
    for (const id of ["in", "a", "out"]) {
      const running = events.findIndex((e) => e.id === id && e.s === "running");
      const completed = events.findIndex((e) => e.id === id && e.s === "completed");
      assert(running >= 0 && completed >= 0 && running < completed, `node "${id}" emitted running before completed`);
    }
  }

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
