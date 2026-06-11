/**
 * Unit test — aggregated usage (BACKLOG B3, usage.summary).
 *
 * Exercises GatewayState.aggregateUsage directly against a temp DB:
 *   1. Grouping per agent+model with summed tokens, cost, and run counts.
 *   2. Null-cost semantics: unpriced rows excluded from costUsd, counted in
 *      unpricedRuns; all-unpriced group → costUsd null.
 *   3. Ordering: priced groups first (highest spend on top).
 *   4. `since` filter: rows recorded before the bound are excluded.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/usage-summary.test.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".usage-summary-test");
const DB_PATH = join(DATA_DIR, "fleet.db");

const { GatewayState } = await import("../src/state/db.js");

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

function usage(model: string, tokens: number) {
  return { inputTokens: tokens, outputTokens: tokens * 2, totalTokens: tokens * 3, model };
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  const state = new GatewayState(DB_PATH);

  const info = (id: string) => ({ id, name: id, version: "", description: "", model: "" });
  state.upsertAgent(info("alpha"), "flue", "src-a");
  state.upsertAgent(info("beta"), "flue", "src-b");

  // alpha: two priced runs on model-x (cost 1 + 2) and one unpriced run on model-y.
  const sA1 = state.createSession("alpha");
  state.recordUsage(sA1, null, usage("anthropic/model-x", 100), 1);
  const sA2 = state.createSession("alpha");
  state.recordUsage(sA2, null, usage("anthropic/model-x", 50), 2);
  const sA3 = state.createSession("alpha");
  state.recordUsage(sA3, null, usage("custom/model-y", 10), null);
  // beta: one cheap priced run.
  const sB1 = state.createSession("beta");
  state.recordUsage(sB1, null, usage("anthropic/model-x", 5), 0.5);

  // ── 1+2+3. Grouping, cost semantics, ordering ─────────────────────────────
  console.log("\n[1] Grouping per agent+model");
  const rows = state.aggregateUsage();
  assert(rows.length === 3, `three groups (alpha/x, alpha/y, beta/x) — got ${rows.length}`);

  const alphaX = rows.find((r) => r.agentId === "alpha" && r.model === "anthropic/model-x");
  assert(!!alphaX && alphaX.inputTokens === 150 && alphaX.totalTokens === 450, "alpha/model-x sums tokens across runs");
  assert(!!alphaX && alphaX.costUsd === 3 && alphaX.runs === 2 && alphaX.unpricedRuns === 0, "alpha/model-x sums cost and counts runs");

  console.log("\n[2] Null-cost semantics");
  const alphaY = rows.find((r) => r.agentId === "alpha" && r.model === "custom/model-y");
  assert(!!alphaY && alphaY.costUsd === null && alphaY.unpricedRuns === 1, "all-unpriced group → costUsd null, unpricedRuns counted");

  console.log("\n[3] Ordering — priced first, highest spend on top");
  assert(rows[0]?.agentId === "alpha" && rows[0]?.model === "anthropic/model-x", "highest spend first");
  assert(rows[rows.length - 1]?.costUsd === null, "unpriced group last");

  // ── 4. since filter ────────────────────────────────────────────────────────
  console.log("\n[4] since filter");
  const future = new Date(Date.now() + 60_000).toISOString();
  assert(state.aggregateUsage(future).length === 0, "since in the future → no rows");
  const past = new Date(Date.now() - 60_000).toISOString();
  assert(state.aggregateUsage(past).length === 3, "since in the past → all rows");
  assert(state.aggregateUsage(null).length === 3, "null since → all rows");

  state.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main();
