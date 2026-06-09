/**
 * WU-09 acceptance test — persist and retrieve the last deploy log per agent.
 *
 * Level 1 — DB helpers: setDeployLog / getDeployLog round-trip.
 * Level 2 — Persistence: close and reopen GatewayState against the same file.
 * Level 3 — Core API: deploy a local-process agent via GatewayCore, call
 *   deploy.lastLog → assert log is non-empty, then open a SECOND GatewayCore
 *   on the same file DB and confirm the log still comes back (real persistence).
 *   Also asserts that deploy.lastLog for an unknown agentId returns log: null.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/deploy-log.test.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".deploy-log-test");
const DB_PATH = join(DATA_DIR, "fleet.db");
process.env.GATEWAY_DATA_DIR = DATA_DIR;

const { GatewayState } = await import("../src/state/db.js");
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
  mkdirSync(DATA_DIR, { recursive: true });

  // ── Level 1: DB helpers ────────────────────────────────────────────────────

  console.log("\n[1] DB helpers …");

  const state1 = new GatewayState(DB_PATH);

  // Register a dummy agent so FK constraints pass, then give it a deploy row.
  const stored = state1.upsertAgent(
    { id: "test-agent-log", name: "log-test", version: "1.0.0", description: "", model: "anthropic/claude-sonnet-4-6" },
    "flue",
    "http://localhost:19998",
  );
  state1.setDeploy(stored.id, { sourceDir: "/tmp", provider: null, model: null, target: "local-process" });

  // Before any log is written, getDeployLog should return null.
  assert(state1.getDeployLog(stored.id) === null, "getDeployLog returns null before any log is stored");

  state1.setDeployLog(stored.id, "line 1\nline 2\nline 3");
  const log1 = state1.getDeployLog(stored.id);
  assert(log1 === "line 1\nline 2\nline 3", `getDeployLog returns the stored log (got: "${log1 ?? "null"}")`);

  // Overwrite check — v1 intentionally keeps only the last log.
  state1.setDeployLog(stored.id, "updated log");
  assert(state1.getDeployLog(stored.id) === "updated log", "setDeployLog overwrites the previous log");

  state1.close();

  // ── Level 2: Persistence across GatewayState instances ────────────────────

  console.log("\n[2] Persistence across GatewayState instances …");

  const state2 = new GatewayState(DB_PATH);
  assert(state2.getDeployLog(stored.id) === "updated log", "log persists after reopening the DB");
  state2.close();

  // ── Level 3: Core API — deploy + deploy.lastLog + persistence ──────────────

  console.log("\n[3] Core API (deploy → deploy.lastLog → persistence) …");

  // Need a provider key for local-process (or skip if not set).
  // We set a dummy so the "missing API key" guard doesn't fire.
  const core1 = new GatewayCore({ dbPath: DB_PATH });
  const events1: ServerEvent[] = [];
  const emit1 = (e: ServerEvent) => {
    events1.push(e);
    if (e.type === "deploy.progress") process.stdout.write(`  … ${e.step}\n`);
    if (e.type === "deploy.error") process.stderr.write(`  deploy error: ${e.message}\n`);
  };

  await core1.handle({ type: "secrets.set", provider: "anthropic", apiKey: "sk-test-xxx" }, emit1);
  await core1.handle({ type: "agent.deployFlue", sourceDir: FIXTURE, target: "local-process" }, emit1);

  const registered = events1.find(
    (e): e is Extract<ServerEvent, { type: "agent.registered" }> => e.type === "agent.registered",
  );
  assert(!!registered, "agent registered after deploy");

  const deployedAgentId = registered!.agent.id;

  // Fetch deploy.lastLog for the deployed agent.
  const logEvents1: ServerEvent[] = [];
  await core1.handle({ type: "deploy.lastLog", agentId: deployedAgentId }, (e) => logEvents1.push(e));
  const logResp1 = logEvents1.find(
    (e): e is Extract<ServerEvent, { type: "deploy.lastLog" }> => e.type === "deploy.lastLog",
  );
  assert(!!logResp1, "deploy.lastLog event emitted");
  assert(logResp1!.agentId === deployedAgentId, "deploy.lastLog carries correct agentId");
  assert(typeof logResp1!.log === "string" && logResp1!.log.length > 0, "deploy.lastLog log is non-empty");
  console.log(`  (log length: ${logResp1!.log?.length ?? 0} chars)`);

  // Unknown agent → log: null
  const unknownEvents: ServerEvent[] = [];
  await core1.handle({ type: "deploy.lastLog", agentId: "does-not-exist" }, (e) => unknownEvents.push(e));
  const unknownResp = unknownEvents.find(
    (e): e is Extract<ServerEvent, { type: "deploy.lastLog" }> => e.type === "deploy.lastLog",
  );
  assert(!!unknownResp, "deploy.lastLog event emitted for unknown agent");
  assert(unknownResp!.log === null, "deploy.lastLog returns log: null for unknown agentId");

  await core1.shutdown();

  // ── Level 4: Second GatewayCore — confirms real on-disk persistence ──────

  console.log("\n[4] Log survives Core restart (second GatewayCore instance) …");

  const core2 = new GatewayCore({ dbPath: DB_PATH });
  const logEvents2: ServerEvent[] = [];
  await core2.handle({ type: "deploy.lastLog", agentId: deployedAgentId }, (e) => logEvents2.push(e));
  const logResp2 = logEvents2.find(
    (e): e is Extract<ServerEvent, { type: "deploy.lastLog" }> => e.type === "deploy.lastLog",
  );
  assert(!!logResp2, "deploy.lastLog event emitted on second Core instance");
  assert(typeof logResp2!.log === "string" && logResp2!.log.length > 0, "log persists across Core restarts");
  await core2.shutdown();

  // ── Done ───────────────────────────────────────────────────────────────────

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
