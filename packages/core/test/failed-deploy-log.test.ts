/**
 * B4 — preserve the log when the FIRST deploy fails (no agent registered yet).
 *
 * Level 1: setLastFailedDeploy / getLastFailedDeploy round-trip via GatewayState.
 * Level 2: Persistence — close and reopen GatewayState against the same file.
 * Level 3: Core API — run a first deploy that fails (bogus sourceDir), then
 *   call deploy.lastFailedLog → assert the failure snapshot comes back, and
 *   confirm it survives a Core restart (second GatewayCore on the same DB).
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/failed-deploy-log.test.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".failed-deploy-log-test");
const DB_PATH = join(DATA_DIR, "fleet.db");
process.env.GATEWAY_DATA_DIR = DATA_DIR;

const { GatewayState } = await import("../src/state/db.js");
const { GatewayCore } = await import("../src/core.js");
import type { ServerEvent } from "../src/api.js";

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

  console.log("\n[1] DB helpers — setLastFailedDeploy / getLastFailedDeploy …");

  const state1 = new GatewayState(DB_PATH);

  assert(state1.getLastFailedDeploy() === null, "getLastFailedDeploy returns null before any failure");

  const failed = {
    sourceDir: "/tmp/my-project",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    target: "docker-local",
    message: "docker build exited with code 1",
    log: "step 1 ok\nstep 2 boom",
    failedAt: "2026-06-11T00:00:00.000Z",
  };
  state1.setLastFailedDeploy(failed);
  const got = state1.getLastFailedDeploy();
  assert(!!got && got.sourceDir === failed.sourceDir, "round-trips sourceDir");
  assert(!!got && got.log === failed.log, "round-trips log");
  assert(!!got && got.message === failed.message, "round-trips message");

  // Overwrite check — only the most recent failure is kept.
  state1.setLastFailedDeploy({ ...failed, message: "newer failure", log: "" });
  assert(state1.getLastFailedDeploy()?.message === "newer failure", "a new failure overwrites the previous one");

  // Clear check — a later successful deploy forgets the failure.
  state1.clearLastFailedDeploy();
  assert(state1.getLastFailedDeploy() === null, "clearLastFailedDeploy removes the snapshot");
  state1.setLastFailedDeploy({ ...failed, message: "newer failure", log: "" });

  state1.close();

  // ── Level 2: Persistence across GatewayState instances ────────────────────

  console.log("\n[2] Persistence across GatewayState instances …");

  const state2 = new GatewayState(DB_PATH);
  assert(state2.getLastFailedDeploy()?.message === "newer failure", "failure snapshot persists after reopening the DB");
  state2.close();

  // ── Level 3: Core API — failing first deploy → deploy.lastFailedLog ───────

  console.log("\n[3] Core API (failing first deploy → deploy.lastFailedLog) …");

  const core1 = new GatewayCore({ dbPath: DB_PATH });
  const events1: ServerEvent[] = [];
  const emit1 = (e: ServerEvent) => events1.push(e);

  await core1.handle({ type: "secrets.set", provider: "anthropic", apiKey: "sk-test-xxx" }, emit1);
  // A sourceDir that does not exist makes the convert step fail before any agent registers.
  const BOGUS_DIR = join(DATA_DIR, "does-not-exist");
  await core1.handle({ type: "agent.deployFlue", sourceDir: BOGUS_DIR, target: "local-process" }, emit1);

  const errEvent = events1.find((e): e is Extract<ServerEvent, { type: "deploy.error" }> => e.type === "deploy.error");
  assert(!!errEvent, "deploy.error emitted for the failing first deploy");
  assert(!events1.some((e) => e.type === "agent.registered"), "no agent was registered");

  const failedEvents1: ServerEvent[] = [];
  await core1.handle({ type: "deploy.lastFailedLog" }, (e) => failedEvents1.push(e));
  const resp1 = failedEvents1.find(
    (e): e is Extract<ServerEvent, { type: "deploy.lastFailedLog" }> => e.type === "deploy.lastFailedLog",
  );
  assert(!!resp1, "deploy.lastFailedLog event emitted");
  assert(resp1!.failed !== null, "failure snapshot recorded");
  assert(resp1!.failed!.sourceDir === BOGUS_DIR, "snapshot carries the sourceDir");
  assert(resp1!.failed!.target === "local-process", "snapshot carries the target");
  assert(resp1!.failed!.message === errEvent!.message, "snapshot message matches the deploy.error message");
  assert(typeof resp1!.failed!.failedAt === "string" && resp1!.failed!.failedAt.length > 0, "snapshot carries failedAt");

  await core1.shutdown();

  // ── Level 4: Snapshot survives Core restart ───────────────────────────────

  console.log("\n[4] Snapshot survives Core restart (second GatewayCore instance) …");

  const core2 = new GatewayCore({ dbPath: DB_PATH });
  const failedEvents2: ServerEvent[] = [];
  await core2.handle({ type: "deploy.lastFailedLog" }, (e) => failedEvents2.push(e));
  const resp2 = failedEvents2.find(
    (e): e is Extract<ServerEvent, { type: "deploy.lastFailedLog" }> => e.type === "deploy.lastFailedLog",
  );
  assert(!!resp2 && resp2.failed !== null, "failure snapshot still retrievable after Core restart");
  assert(resp2!.failed!.sourceDir === BOGUS_DIR, "snapshot sourceDir intact across restart");
  await core2.shutdown();

  // ── Level 5: redeploy failures stay per-agent — never the global snapshot ──

  console.log("\n[5] Redeploy failure does NOT write the global snapshot …");

  // Seed a registered agent whose stored deploy points at the bogus dir, and
  // clear the snapshot so any write below would be detectable.
  const state3 = new GatewayState(DB_PATH);
  const seeded = state3.upsertAgent(
    { id: "redeploy-fail-agent", name: "redeploy-fail", version: "1.0.0", description: "", model: "anthropic/claude-sonnet-4-6" },
    "flue",
    "http://localhost:19996",
  );
  state3.setDeploy(seeded.id, { sourceDir: BOGUS_DIR, provider: null, model: null, target: "local-process" });
  state3.clearLastFailedDeploy();
  state3.close();

  const core3 = new GatewayCore({ dbPath: DB_PATH });
  const events3: ServerEvent[] = [];
  await core3.handle({ type: "agent.redeploy", agentId: seeded.id }, (e) => events3.push(e));
  assert(events3.some((e) => e.type === "deploy.error"), "redeploy with a bogus sourceDir fails");
  await core3.shutdown();

  const state4 = new GatewayState(DB_PATH);
  assert(state4.getLastFailedDeploy() === null, "redeploy failure did not write the global snapshot");
  state4.close();

  // ── Done ───────────────────────────────────────────────────────────────────

  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
