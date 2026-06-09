/**
 * WU-02 acceptance test — agent stop and delete.
 *
 * Deploys a minimal Claude Code project with the `local-process` target (no
 * Docker needed), then exercises the full stop/delete lifecycle:
 *
 *   1. agent.stop  → process gone, agent still in agents.list but online:false,
 *                    agent.updated emitted.
 *   2. agent.delete → agent.removed emitted, agent no longer in agents.list.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/stop-delete.test.ts
 */

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".stop-delete-test");
process.env.GATEWAY_DATA_DIR = DATA_DIR;

const { GatewayCore } = await import("../src/core.js");
import type { ServerEvent } from "../src/api.js";

const FIXTURE = join(DIR, "fixtures", "claude-minimal");

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const core = new GatewayCore({ dbPath: ":memory:" });
  const events: ServerEvent[] = [];
  const emit = (e: ServerEvent) => {
    events.push(e);
    if (e.type === "deploy.progress") console.log(`  … ${e.step}${e.detail ? ` (${e.detail})` : ""}`);
    if (e.type === "deploy.error") console.error(`  deploy error: ${e.message}`);
  };

  try {
    // ── 1. Deploy with local-process ────────────────────────────────────────
    console.log("\n[1] Deploying (local-process) …");
    // Inject a dummy provider key so the fail-fast guard passes. The agent server
    // starts without a real key — the model is only invoked on actual prompts.
    await core.handle({ type: "secrets.set", provider: "anthropic", apiKey: "sk-test-stop-delete" }, emit);
    await core.handle({ type: "agent.deployFlue", sourceDir: FIXTURE, target: "local-process" }, emit);

    const registered = events.find(
      (e): e is Extract<ServerEvent, { type: "agent.registered" }> => e.type === "agent.registered",
    );
    assert(!!registered, "agent.registered emitted after deploy");
    assert(registered?.agent.online === true, "deployed agent is online");
    const agentId = registered!.agent.id;

    // ── 2. agent.stop ───────────────────────────────────────────────────────
    console.log("\n[2] Stopping agent …");
    events.length = 0; // reset for cleaner assertions
    await core.handle({ type: "agent.stop", agentId }, emit);

    const updated = events.find(
      (e): e is Extract<ServerEvent, { type: "agent.updated" }> => e.type === "agent.updated",
    );
    assert(!!updated, "agent.updated emitted after stop");
    assert(updated?.agent.online === false, "agent.updated carries online:false");
    assert(updated?.agent.id === agentId, "agent.updated carries the correct agentId");
    assert(!events.some((e) => e.type === "error"), "no error event on stop");

    // Agent still appears in agents.list (registration kept)
    events.length = 0;
    await core.handle({ type: "agents.list" }, emit);
    const listAfterStop = events.find((e): e is Extract<ServerEvent, { type: "agents" }> => e.type === "agents");
    assert(!!listAfterStop, "agents event received after stop");
    const agentAfterStop = listAfterStop?.agents.find((a) => a.id === agentId);
    assert(!!agentAfterStop, "agent still in agents.list after stop");
    assert(agentAfterStop?.online === false, "agent is offline in agents.list after stop");

    // ── 3. agent.delete ─────────────────────────────────────────────────────
    console.log("\n[3] Deleting agent …");
    events.length = 0;
    await core.handle({ type: "agent.delete", agentId }, emit);

    const removed = events.find(
      (e): e is Extract<ServerEvent, { type: "agent.removed" }> => e.type === "agent.removed",
    );
    assert(!!removed, "agent.removed emitted after delete");
    assert(removed?.agentId === agentId, "agent.removed carries the correct agentId");
    assert(!events.some((e) => e.type === "error"), "no error event on delete");

    // Agent no longer appears in agents.list
    events.length = 0;
    await core.handle({ type: "agents.list" }, emit);
    const listAfterDelete = events.find((e): e is Extract<ServerEvent, { type: "agents" }> => e.type === "agents");
    assert(!!listAfterDelete, "agents event received after delete");
    assert(
      !listAfterDelete?.agents.some((a) => a.id === agentId),
      "agent is gone from agents.list after delete",
    );
  } catch (err) {
    console.error("PROBE ERROR:", err);
    process.exitCode = 1;
  } finally {
    await core.shutdown();
    rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main();
