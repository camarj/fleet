/**
 * WU-09 — deploy log DB helpers (lightweight, no running agent required).
 *
 * Level 1: setDeployLog / getDeployLog round-trip via GatewayState directly.
 * Level 2: Persistence — close and reopen GatewayState against the same file.
 *
 * For the full E2E (deploy → log persisted → Core restart), see deploy-log.test.ts.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/deploy-log-db.test.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".deploy-log-db-test");
const DB_PATH = join(DATA_DIR, "fleet.db");
process.env.GATEWAY_DATA_DIR = DATA_DIR;

const { GatewayState } = await import("../src/state/db.js");

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
  mkdirSync(DATA_DIR, { recursive: true });

  // ── Level 1: DB helpers ────────────────────────────────────────────────────

  console.log("\n[1] DB helpers — setDeployLog / getDeployLog …");

  const state1 = new GatewayState(DB_PATH);

  // Register a dummy agent and give it a deploy row so the FK constraint passes.
  const stored = state1.upsertAgent(
    { id: "test-agent-log-db", name: "log-db-test", version: "1.0.0", description: "", model: "anthropic/claude-sonnet-4-6" },
    "flue",
    "http://localhost:19997",
  );
  state1.setDeploy(stored.id, { sourceDir: "/tmp", provider: null, model: null, target: "local-process" });

  // Before any log, getDeployLog should return null.
  assert(state1.getDeployLog(stored.id) === null, "getDeployLog returns null before any log is stored");

  // Set a log and read it back.
  state1.setDeployLog(stored.id, "line 1\nline 2\nline 3");
  const log1 = state1.getDeployLog(stored.id);
  assert(log1 === "line 1\nline 2\nline 3", `getDeployLog returns the stored log (got: "${log1 ?? "null"}")`);

  // Overwrite check — v1 intentionally keeps only the last log.
  state1.setDeployLog(stored.id, "updated log");
  assert(state1.getDeployLog(stored.id) === "updated log", "setDeployLog overwrites the previous log");

  // Unknown agentId returns null (no deploy row at all).
  assert(state1.getDeployLog("does-not-exist") === null, "getDeployLog returns null for unknown agentId");

  state1.close();

  // ── Level 2: Persistence across GatewayState instances ────────────────────

  console.log("\n[2] Persistence across GatewayState instances …");

  const state2 = new GatewayState(DB_PATH);
  assert(state2.getDeployLog(stored.id) === "updated log", "log persists after reopening the DB");
  state2.close();

  // ── Done ───────────────────────────────────────────────────────────────────

  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
