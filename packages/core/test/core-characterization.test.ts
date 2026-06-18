/**
 * Issue #62 — characterization tests for GatewayCore.
 *
 * Pins the OBSERVABLE behavior of the public `handle()` dispatch for the
 * DB-backed flows most at risk during the planned decomposition of GatewayCore
 * into managers. Everything here runs with NO network, NO LLM, NO subprocess:
 *
 *   - session.start guard (agent not connected → error)
 *   - session.abort guard (unknown session → error)
 *   - workflow.abort of an unknown run (no-op, no throw, no event)
 *   - config.set: persistence + requiresRedeploy semantics (#setConfig +
 *     #deployedSpecifier) across no-deploy / same-model / changed-model
 *   - usage.summary: totals aggregation incl. unpriced runs (#usageSummary)
 *   - deploy.lastFailedLog: empty + seeded snapshot round-trip
 *   - #summary projection (model/target/redeployable/origin) after a restart
 *
 * SEAM LIMIT (documented for the refactor): GatewayCore has no clean seam to
 * inject a fake AgentAdapter — agents enter `#agents` only via
 * FlueAdapter.connect (real HTTP) or the deployer (real subprocess). So the
 * agent-connected paths (session events stream, the #agentRunner agent-node
 * execution, the offline→online reconnect transition) cannot be characterized
 * with injected doubles today. They are exercised elsewhere with a real
 * local-process subprocess (stop-delete/health tests). Seeded agents below use
 * an EMPTY sourceRef so the constructor's reconnect/health loops skip them and
 * the test stays provably offline.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/core-characterization.test.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".core-characterization-test");
process.env.GATEWAY_DATA_DIR = DATA_DIR;

const { GatewayState } = await import("../src/state/db.js");
const { GatewayCore } = await import("../src/core.js");
import type { ClientRequest, ServerEvent } from "../src/api.js";

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

/** A large health interval so the periodic loop never fires during the test. */
const NO_HEALTH = 3_600_000;

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  // ── 1. session.start against an agent that is not connected → error ──────────
  console.log("\n[1] session.start — unconnected agent is rejected …");
  {
    const core = new GatewayCore({ dbPath: ":memory:", healthIntervalMs: NO_HEALTH });
    try {
      const events = await send(core, { type: "session.start", agentId: "ghost-agent", message: "hi" });
      const err = events.find((e): e is Extract<ServerEvent, { type: "error" }> => e.type === "error");
      assert(!!err, "an error event is emitted for an unconnected agent");
      assert(err?.message.includes("ghost-agent") === true, "the error names the missing agent");
      assert(err?.requestType === "session.start", "the error carries the originating requestType");
      assert(!events.some((e) => e.type === "session.started"), "no session.started is emitted when the agent is absent");
    } finally {
      await core.shutdown();
    }
  }

  // ── 2. session.abort of an unknown session → error ───────────────────────────
  console.log("\n[2] session.abort — unknown session is rejected …");
  {
    const core = new GatewayCore({ dbPath: ":memory:", healthIntervalMs: NO_HEALTH });
    try {
      const events = await send(core, { type: "session.abort", sessionId: "no-such-session" });
      const err = events.find((e): e is Extract<ServerEvent, { type: "error" }> => e.type === "error");
      assert(!!err, "an error event is emitted for an unknown session");
      assert(err?.message.includes("no-such-session") === true, "the error names the unknown session");
      assert(err?.requestType === "session.abort", "the error carries requestType session.abort");
    } finally {
      await core.shutdown();
    }
  }

  // ── 3. workflow.abort of an unknown run is a silent no-op ─────────────────────
  console.log("\n[3] workflow.abort — unknown run id is a no-op …");
  {
    const core = new GatewayCore({ dbPath: ":memory:", healthIntervalMs: NO_HEALTH });
    try {
      const events = await send(core, { type: "workflow.abort", runId: "wfr_does_not_exist" });
      assert(events.length === 0, "aborting an unknown run emits nothing");
      // The dispatch must not throw — reaching here without an unhandled rejection proves it.
      assert(true, "aborting an unknown run does not throw");
    } finally {
      await core.shutdown();
    }
  }

  // ── 4. config.set — persistence + requiresRedeploy semantics ─────────────────
  console.log("\n[4] config.set — requiresRedeploy follows deploy state and model delta …");
  {
    const DB = join(DATA_DIR, "config.db");
    // Seed two agents: one with NO deploy, one deployed at anthropic/claude-sonnet-4-6.
    // Empty sourceRef keeps the Core's reconnect/health loops offline (see header).
    const seed = new GatewayState(DB);
    seed.upsertAgent({ id: "no-deploy", name: "no-deploy", version: "1.0.0", description: "", model: "anthropic/base" }, "flue", "");
    seed.upsertAgent({ id: "deployed", name: "deployed", version: "1.0.0", description: "", model: "anthropic/base" }, "flue", "");
    seed.setDeploy("deployed", { sourceDir: "/x", provider: "anthropic", model: "claude-sonnet-4-6", target: "fly", repoOwner: null });
    seed.close();

    const core = new GatewayCore({ dbPath: DB, healthIntervalMs: NO_HEALTH });
    try {
      // (a) No deploy → a model change can never require a redeploy.
      const a = await send(core, { type: "config.set", agentId: "no-deploy", modelSpecifier: "anthropic/something-else" });
      const aEv = a.find((e): e is Extract<ServerEvent, { type: "config.updated" }> => e.type === "config.updated");
      assert(!!aEv, "config.set emits config.updated for an agent with no deploy");
      assert(aEv?.requiresRedeploy === false, "no deploy → requiresRedeploy is false even when the model differs");

      // (b) Deployed, SAME specifier as deployed (provider/model) → no redeploy.
      const b = await send(core, { type: "config.set", agentId: "deployed", modelSpecifier: "anthropic/claude-sonnet-4-6" });
      const bEv = b.find((e): e is Extract<ServerEvent, { type: "config.updated" }> => e.type === "config.updated");
      assert(bEv?.requiresRedeploy === false, "deployed agent, model unchanged → requiresRedeploy is false");

      // (c) Deployed, DIFFERENT specifier → redeploy required.
      const c = await send(core, { type: "config.set", agentId: "deployed", modelSpecifier: "openai/gpt-4o" });
      const cEv = c.find((e): e is Extract<ServerEvent, { type: "config.updated" }> => e.type === "config.updated");
      assert(cEv?.requiresRedeploy === true, "deployed agent, model changed → requiresRedeploy is true");
      assert(cEv?.agentId === "deployed", "config.updated carries the agentId");

      // (d) The override persisted: agents.list now reports the configured model
      //     (deployedSpecifier still wins because Flue bakes the model at convert
      //     time — the deploy row, not the pending override, is the source of truth).
      const list = await send(core, { type: "agents.list" });
      const agents = list.find((e): e is Extract<ServerEvent, { type: "agents" }> => e.type === "agents")?.agents ?? [];
      const deployed = agents.find((a) => a.id === "deployed");
      assert(deployed?.model === "anthropic/claude-sonnet-4-6", "agents.list reports the DEPLOYED specifier (provider/model from the deploy row)");
      assert(deployed?.redeployable === true, "a deployed agent is redeployable");
      assert(deployed?.origin === "local", "a non-org agent has origin 'local'");
    } finally {
      await core.shutdown();
    }
  }

  // ── 5. usage.summary — totals aggregate priced + unpriced runs ───────────────
  console.log("\n[5] usage.summary — totals sum tokens and price only priced runs …");
  {
    const DB = join(DATA_DIR, "usage.db");
    const seed = new GatewayState(DB);
    seed.upsertAgent({ id: "u1", name: "u1", version: "1.0.0", description: "", model: "" }, "flue", "");
    // Two priced runs (same model) + one unpriced run (null cost).
    const s1 = seed.createSession("u1", "p1");
    seed.recordUsage(s1, null, { inputTokens: 10, outputTokens: 20, totalTokens: 30, model: "m-priced" }, 0.001);
    seed.endSession(s1, "completed");
    const s2 = seed.createSession("u1", "p2");
    seed.recordUsage(s2, null, { inputTokens: 5, outputTokens: 5, totalTokens: 10, model: "m-priced" }, 0.0005);
    seed.endSession(s2, "completed");
    const s3 = seed.createSession("u1", "p3");
    seed.recordUsage(s3, null, { inputTokens: 1, outputTokens: 2, totalTokens: 3, model: "m-unpriced" }, null);
    seed.endSession(s3, "completed");
    seed.close();

    const core = new GatewayCore({ dbPath: DB, healthIntervalMs: NO_HEALTH });
    try {
      const events = await send(core, { type: "usage.summary" });
      const summary = events.find((e): e is Extract<ServerEvent, { type: "usage.summary" }> => e.type === "usage.summary");
      assert(!!summary, "usage.summary responds with a usage.summary event");
      const t = summary!.totals;
      assert(t.inputTokens === 16, "totals.inputTokens sums every run (10+5+1)");
      assert(t.outputTokens === 27, "totals.outputTokens sums every run (20+5+2)");
      assert(t.totalTokens === 43, "totals.totalTokens sums every run (30+10+3)");
      assert(t.runs === 3, "totals.runs counts all runs across models");
      assert(t.unpricedRuns === 1, "totals.unpricedRuns counts the run whose model has no price");
      assert(t.costUsd !== null && Math.abs(t.costUsd - 0.0015) < 1e-9, "totals.costUsd sums priced runs only (0.001 + 0.0005)");
    } finally {
      await core.shutdown();
    }
  }

  // ── 6. usage.summary — no usage rows yields zeroed totals and null cost ───────
  console.log("\n[6] usage.summary — empty ledger yields zero totals and null cost …");
  {
    const core = new GatewayCore({ dbPath: ":memory:", healthIntervalMs: NO_HEALTH });
    try {
      const events = await send(core, { type: "usage.summary" });
      const summary = events.find((e): e is Extract<ServerEvent, { type: "usage.summary" }> => e.type === "usage.summary");
      assert(summary?.totals.totalTokens === 0, "empty ledger → totals.totalTokens is 0");
      assert(summary?.totals.runs === 0, "empty ledger → totals.runs is 0");
      assert(summary?.totals.costUsd === null, "empty ledger → totals.costUsd is null (no priced rows)");
      assert(summary?.rows.length === 0, "empty ledger → no per-agent rows");
    } finally {
      await core.shutdown();
    }
  }

  // ── 7. deploy.lastFailedLog — empty, then a seeded snapshot ───────────────────
  console.log("\n[7] deploy.lastFailedLog — null when none, returns the seeded snapshot …");
  {
    const DB = join(DATA_DIR, "failed.db");
    const core1 = new GatewayCore({ dbPath: DB, healthIntervalMs: NO_HEALTH });
    try {
      const events = await send(core1, { type: "deploy.lastFailedLog" });
      const ev = events.find((e): e is Extract<ServerEvent, { type: "deploy.lastFailedLog" }> => e.type === "deploy.lastFailedLog");
      assert(ev?.failed === null, "deploy.lastFailedLog is null when no failure has been recorded");
    } finally {
      await core1.shutdown();
    }

    // Seed a failure snapshot via the state layer, then read it back through the Core.
    const seed = new GatewayState(DB);
    seed.setLastFailedDeploy({
      sourceDir: "/proj",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      target: "fly",
      message: "boom during build",
      log: "line1\nline2",
      failedAt: "2026-06-18T00:00:00.000Z",
    });
    seed.close();

    const core2 = new GatewayCore({ dbPath: DB, healthIntervalMs: NO_HEALTH });
    try {
      const events = await send(core2, { type: "deploy.lastFailedLog" });
      const ev = events.find((e): e is Extract<ServerEvent, { type: "deploy.lastFailedLog" }> => e.type === "deploy.lastFailedLog");
      assert(ev?.failed?.message === "boom during build", "deploy.lastFailedLog returns the seeded failure message");
      assert(ev?.failed?.target === "fly", "the seeded snapshot round-trips its target");
      assert(ev?.failed?.log === "line1\nline2", "the seeded snapshot round-trips its accumulated log");
    } finally {
      await core2.shutdown();
    }
  }

  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
