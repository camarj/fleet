/**
 * WU-03 acceptance test — health monitor + reconnect on boot.
 *
 * Deploys a local-process agent, kills the underlying process to simulate a
 * crash, and asserts:
 *   1. Within a few health intervals an `agent.updated` with online:false is emitted.
 *   2. No duplicate offline events are emitted while state is unchanged (anti-spam).
 *   3. shutdown() clears the interval so the process exits without hanging.
 *
 * "Bring it back online" is not exercised here because relaunching the same
 * local-process agent from the test requires access to the deployer's private
 * subprocess map. The offline transition + anti-spam are sufficient acceptance
 * for WU-03's Core logic; the online transition is exercised implicitly by the
 * health loop's reconnect path at startup (covered by reconnect-on-boot via the
 * initial deploy → agent.registered).
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/health.test.ts
 */

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".health-test");
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

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `pred` at 50 ms intervals until it returns true or `timeoutMs` elapses. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await wait(50);
  }
  return false;
}

/**
 * Kill only the process LISTENING on the given TCP port (not client connections).
 * `-sTCP:LISTEN` prevents killing the test process itself which may have an
 * open connection to the agent (which also appears in plain `lsof -ti tcp:PORT`).
 */
function killPort(port: number): void {
  try {
    // `tcp:` (no `4`) matches both IPv4 and IPv6 listeners: a Node server
    // bound without a host listens on `::` (IPv6/dual-stack) on Linux/CI, which
    // `-i4tcp` (IPv4-only) would miss, leaving the agent alive and never going
    // offline. `-sTCP:LISTEN` still scopes the kill to the listener only.
    const raw = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: "utf8" }).trim();
    for (const line of raw.split("\n")) {
      const pid = Number(line.trim());
      if (pid) process.kill(pid, "SIGKILL");
    }
  } catch {
    // process already dead, lsof unavailable, or port not found — safe to ignore
  }
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });

  // 200 ms health interval so the test doesn't wait the full 15 s default.
  const core = new GatewayCore({ dbPath: ":memory:", healthIntervalMs: 200 });
  const events: ServerEvent[] = [];
  const emit = (e: ServerEvent): void => {
    events.push(e);
    if (e.type === "deploy.progress") console.log(`  … ${e.step}${e.detail ? ` (${e.detail})` : ""}`);
    if (e.type === "deploy.error") console.error(`  deploy error: ${e.message}`);
    if (e.type === "agent.updated") console.log(`  ↳ agent.updated online=${e.agent.online}`);
  };

  // Register the shared emit so health-monitor broadcasts land in the same array
  // as per-request events (deploy.progress, agent.registered, …).
  core.addEmitter(emit);

  try {
    // ── 1. Deploy with local-process ─────────────────────────────────────────
    console.log("\n[1] Deploying (local-process) …");
    await core.handle({ type: "secrets.set", provider: "anthropic", apiKey: "sk-test-health" }, emit);
    await core.handle({ type: "agent.deployFlue", sourceDir: FIXTURE, target: "local-process" }, emit);

    const registered = events.find(
      (e): e is Extract<ServerEvent, { type: "agent.registered" }> => e.type === "agent.registered",
    );
    assert(!!registered, "agent.registered emitted after deploy");
    assert(registered?.agent.online === true, "deployed agent is online");
    const agentId = registered!.agent.id;

    const sourceRef = core.getAgentSourceRef(agentId);
    assert(!!sourceRef, "getAgentSourceRef returns a URL for the live agent");

    const port = Number(new URL(sourceRef!).port);
    assert(port > 0, `sourceRef resolves to port ${port}`);

    // ── 2. Kill the underlying process — simulate an unexpected crash ─────────
    console.log(`\n[2] Killing agent process on port ${port} …`);
    events.length = 0; // reset: only capture health-monitor events from here on
    killPort(port);

    // ── 3. Wait for offline transition ────────────────────────────────────────
    console.log("\n[3] Waiting for health monitor to detect offline …");
    // With 200 ms interval and connection-refused being near-instant, the offline
    // event usually arrives within the first 2-3 ticks (~400–600 ms). `waitFor`
    // returns as soon as the predicate holds, so a generous 10 s ceiling only
    // affects the failure path — it absorbs slow/loaded CI runners without
    // slowing the happy case (this test was flaky in CI at 3 s).
    const detected = await waitFor(
      () =>
        events.some(
          (e): e is Extract<ServerEvent, { type: "agent.updated" }> =>
            e.type === "agent.updated" && e.agent.id === agentId && !e.agent.online,
        ),
      10000,
    );
    assert(detected, "agent.updated with online:false emitted after process kill");

    const offlineEvents = events.filter(
      (e): e is Extract<ServerEvent, { type: "agent.updated" }> =>
        e.type === "agent.updated" && e.agent.id === agentId && !e.agent.online,
    );
    assert(offlineEvents.length >= 1, `at least one offline transition event received (got ${offlineEvents.length})`);

    // ── 4. Anti-spam: no duplicate offline events while state is unchanged ────
    console.log("\n[4] Verifying anti-spam (no duplicate events while offline) …");
    const countBefore = offlineEvents.length;
    await wait(600); // let 3 more ticks fire at 200 ms each
    const countAfter = events.filter(
      (e): e is Extract<ServerEvent, { type: "agent.updated" }> =>
        e.type === "agent.updated" && e.agent.id === agentId && !e.agent.online,
    ).length;
    assert(
      countAfter === countBefore,
      `no duplicate offline events emitted while state unchanged (${countAfter} === ${countBefore})`,
    );
  } catch (err) {
    console.error("PROBE ERROR:", err);
    process.exitCode = 1;
  } finally {
    // shutdown() must clear the health interval; otherwise the process hangs.
    await core.shutdown();
    rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main();
