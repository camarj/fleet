/**
 * WU-10 — honest model override (config → redeploy), no running agent required.
 *
 * Level 1: splitSpecifier — provider/model parsing edge cases.
 * Level 2: GatewayCore handlers — AgentSummary.model reflects the deployed
 *   specifier, and config.set reports requiresRedeploy correctly.
 *
 * The actual "redeploy applies the override and rebuilds" step needs a real
 * build and is covered by the manual acceptance smoke (change model → redeploy
 * → agent runs the new model). Here we prove the pure logic that drives it.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/model-override.test.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".model-override-test");
const DB_PATH = join(DATA_DIR, "fleet.db");
process.env.GATEWAY_DATA_DIR = DATA_DIR;

const { GatewayState } = await import("../src/state/db.js");
const { GatewayCore, splitSpecifier } = await import("../src/core.js");
import type { ServerEvent } from "../src/api.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

/** Drive one request and return the first emitted event of a given type. */
async function ask<T extends ServerEvent["type"]>(
  core: InstanceType<typeof GatewayCore>,
  req: Parameters<InstanceType<typeof GatewayCore>["handle"]>[0],
  type: T,
): Promise<Extract<ServerEvent, { type: T }> | undefined> {
  const events: ServerEvent[] = [];
  await core.handle(req, (e) => events.push(e));
  return events.find((e): e is Extract<ServerEvent, { type: T }> => e.type === type);
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  // ── Level 1: splitSpecifier ────────────────────────────────────────────────

  console.log("\n[1] splitSpecifier — provider/model parsing …");

  assert(
    JSON.stringify(splitSpecifier("anthropic/claude-sonnet-4-6")) ===
      JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6" }),
    "splits a normal provider/model specifier",
  );
  assert(
    JSON.stringify(splitSpecifier("openrouter/meta-llama/llama-3")) ===
      JSON.stringify({ provider: "openrouter", model: "meta-llama/llama-3" }),
    "splits on the FIRST slash so models with slashes stay intact",
  );
  assert(splitSpecifier(null) === null, "null specifier → null");
  assert(splitSpecifier("noslash") === null, "no slash → null");
  assert(splitSpecifier("trailing/") === null, "trailing slash (no model) → null");
  assert(splitSpecifier("/leading") === null, "leading slash (no provider) → null");

  // ── Level 2: GatewayCore handlers ──────────────────────────────────────────

  console.log("\n[2] GatewayCore — deployed model + requiresRedeploy …");

  // Seed the DB before constructing the Core: one agent WITH a deploy, one
  // without. Use a closed port for sourceRef so reconnect-on-boot fails fast.
  const seed = new GatewayState(DB_PATH);
  const withDeploy = seed.upsertAgent(
    { id: "agent-with-deploy", name: "deployed", version: "1.0.0", description: "", model: "" },
    "flue",
    "http://127.0.0.1:9",
  );
  seed.setDeploy(withDeploy.id, {
    sourceDir: "/tmp",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    target: "local-process",
  });
  const noDeploy = seed.upsertAgent(
    { id: "agent-no-deploy", name: "connected", version: "1.0.0", description: "", model: "" },
    "flue",
    "http://127.0.0.1:9",
  );
  seed.close();

  const core = new GatewayCore({ dbPath: DB_PATH });
  try {
    const list = await ask(core, { type: "agents.list" }, "agents");
    const a = list?.agents.find((x) => x.id === withDeploy.id);
    const b = list?.agents.find((x) => x.id === noDeploy.id);
    assert(a?.model === "anthropic/claude-sonnet-4-6", "AgentSummary.model derives from the deploy params");
    assert(b?.model === "", "agent with no deploy has empty model (no fallback available)");

    // Same specifier as deployed → nothing to redeploy.
    const same = await ask(
      core,
      { type: "config.set", agentId: withDeploy.id, modelSpecifier: "anthropic/claude-sonnet-4-6" },
      "config.updated",
    );
    assert(same?.requiresRedeploy === false, "config.set with the SAME specifier → requiresRedeploy false");

    // Different specifier → must redeploy to apply.
    const diff = await ask(
      core,
      { type: "config.set", agentId: withDeploy.id, modelSpecifier: "openai/gpt-5.5" },
      "config.updated",
    );
    assert(diff?.requiresRedeploy === true, "config.set with a DIFFERENT specifier → requiresRedeploy true");

    // Clearing the override → nothing to apply.
    const cleared = await ask(
      core,
      { type: "config.set", agentId: withDeploy.id, modelSpecifier: null },
      "config.updated",
    );
    assert(cleared?.requiresRedeploy === false, "config.set with null specifier → requiresRedeploy false");

    // An agent with no deploy can't be redeployed, so never requiresRedeploy.
    const cannot = await ask(
      core,
      { type: "config.set", agentId: noDeploy.id, modelSpecifier: "openai/gpt-5.5" },
      "config.updated",
    );
    assert(cannot?.requiresRedeploy === false, "config.set on a non-redeployable agent → requiresRedeploy false");
  } finally {
    await core.shutdown();
    rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
