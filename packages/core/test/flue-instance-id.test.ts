/**
 * J1 — stable Flue instanceId per agent (DB-level, no live agent required).
 *
 * 1. A fresh agent row has flueInstanceId === null.
 * 2. setAgentFlueInstanceId persists the id and getAgent reflects it.
 * 3. upsertAgent for the same id (simulating a reconnect upsert) does NOT
 *    clobber flueInstanceId (explicit column list in the ON CONFLICT clause).
 * 4. listAgents() surfaces the field too.
 * 5. Migration idempotence: constructing GatewayState twice against the same
 *    file does not throw even though the ALTER TABLE already ran.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/flue-instance-id.test.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".flue-instance-id-test");
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

  try {
    // ── [1] Fresh agent row has flueInstanceId === null ────────────────────────

    console.log("\n[1] Fresh agent row has flueInstanceId === null …");

    const state1 = new GatewayState(DB_PATH);

    const stored1 = state1.upsertAgent(
      { id: "test-agent-j1", name: "test-agent-j1", version: "1.0.0", description: "", model: "" },
      "flue",
      "http://localhost:19990",
    );
    assert(stored1.flueInstanceId === null, "fresh agent row has flueInstanceId === null");

    // ── [2] setAgentFlueInstanceId persists and getAgent reflects it ───────────

    console.log("\n[2] setAgentFlueInstanceId → getAgent …");

    state1.setAgentFlueInstanceId(stored1.id, "fleet_abc123");
    const after = state1.getAgent(stored1.id);
    assert(after?.flueInstanceId === "fleet_abc123", `getAgent reflects persisted id (got: "${after?.flueInstanceId ?? "null"}")`);

    // ── [3] upsertAgent does not clobber flueInstanceId ────────────────────────

    console.log("\n[3] upsertAgent (simulated reconnect) must not clobber flueInstanceId …");

    state1.upsertAgent(
      { id: "test-agent-j1", name: "test-agent-j1", version: "1.0.1", description: "updated", model: "" },
      "flue",
      "http://localhost:19990",
    );
    const afterUpsert = state1.getAgent(stored1.id);
    assert(
      afterUpsert?.flueInstanceId === "fleet_abc123",
      `flueInstanceId still "fleet_abc123" after upsert (got: "${afterUpsert?.flueInstanceId ?? "null"}")`,
    );

    // ── [4] listAgents() surfaces the field ────────────────────────────────────

    console.log("\n[4] listAgents() surfaces flueInstanceId …");

    const list = state1.listAgents();
    const found = list.find((a) => a.id === stored1.id);
    assert(found?.flueInstanceId === "fleet_abc123", `listAgents includes flueInstanceId (got: "${found?.flueInstanceId ?? "null"}")`);

    state1.close();

    // ── [5] Migration idempotence ──────────────────────────────────────────────

    console.log("\n[5] Migration idempotence — constructing GatewayState twice over the same file …");

    let threw = false;
    try {
      const state2 = new GatewayState(DB_PATH);
      // Verify the persisted value is readable on a fresh instance.
      const reread = state2.getAgent(stored1.id);
      assert(reread?.flueInstanceId === "fleet_abc123", `persisted id readable after re-open (got: "${reread?.flueInstanceId ?? "null"}")`);
      state2.close();
    } catch (err) {
      threw = true;
      console.error("unexpected throw on re-open:", err);
    }
    assert(!threw, "GatewayState construction is idempotent on an already-migrated DB");

    // ── Done ────────────────────────────────────────────────────────────────────

    console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  } finally {
    rmSync(DATA_DIR, { recursive: true, force: true });
    process.exit(process.exitCode ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
