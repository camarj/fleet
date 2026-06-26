/**
 * Deploy pipeline E2E — drives GatewayCore.handle({ type: "agent.deployFlue" })
 * against the converter's Claude Code fixture: convert → build → spawn → connect
 * → register. Proves the whole "Deploy agent" engine end-to-end.
 *
 * GATEWAY_DATA_DIR is pointed under packages/core so the deployed agent resolves
 * @flue from the monorepo (no multi-minute npm install). A dummy provider key is
 * injected before deploy: the deployer fail-fast-guards a missing provider key
 * (flue-deployer), so a deploy requires one to be set.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/deploy.test.ts
 */

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".deploy-test");
process.env.GATEWAY_DATA_DIR = DATA_DIR;

const { GatewayCore } = await import("../src/core.js");
import type { ServerEvent } from "../src/api.js";

// A minimal Claude Code project (no MCP) — a converted agent with an unreachable
// HTTP MCP would block on its top-level connectMcpServer at startup.
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
    // Default target keeps this test Docker-free and fast; set
    // FLEET_DEPLOY_TARGET=docker-local to exercise the real container path.
    // The deployer fail-fast-guards a missing provider key, so set one first.
    await core.handle({ type: "secrets.set", provider: "anthropic", apiKey: "sk-test-deploy" }, emit);
    const target = (process.env.FLEET_DEPLOY_TARGET as "docker-local" | "local-process") ?? "local-process";
    console.log(`(target: ${target})`);
    await core.handle({ type: "agent.deployFlue", sourceDir: FIXTURE, target }, emit);

    const steps = events.filter((e): e is Extract<ServerEvent, { type: "deploy.progress" }> => e.type === "deploy.progress").map((e) => e.step);
    for (const s of ["converting", "building", "starting", "connecting", "done"]) {
      assert(steps.includes(s), `progress emitted "${s}"`);
    }
    assert(!events.some((e) => e.type === "deploy.error"), "no deploy error");

    const registered = events.find((e): e is Extract<ServerEvent, { type: "agent.registered" }> => e.type === "agent.registered");
    assert(!!registered, "agent.registered emitted after deploy");
    assert(registered?.agent.kind === "flue", "deployed agent kind = flue");
    assert(registered?.agent.name === "claude-minimal", "deployed agent name = converted project name");
    assert(registered?.agent.online === true, "deployed agent is online");

    // ── B2: capability registry (derived from the converted agent's Agent Card) ──
    const agentId = registered!.agent.id;
    events.length = 0;
    await core.handle({ type: "capabilities.list" }, emit);
    const cat = [...events].reverse().find((e): e is Extract<ServerEvent, { type: "capabilities" }> => e.type === "capabilities");
    assert(!!cat, "capabilities.list → capabilities event");
    const entry = cat?.agents.find((a) => a.agentId === agentId);
    assert(!!entry, "deployed agent appears in the capability catalog");
    assert((entry?.capabilities.length ?? 0) > 0, "agent has at least one capability (the baseline from its Agent Card)");
    assert(entry?.capabilities.some((c) => c.id === "general") === true, "baseline 'general' capability present");
    assert(
      entry?.capabilities.every((c) => typeof c.id === "string" && typeof c.name === "string" && Array.isArray(c.tags)) === true,
      "every capability has id/name/tags",
    );

    // The registry updates when an agent is removed.
    events.length = 0;
    await core.handle({ type: "agent.delete", agentId }, emit);
    await core.handle({ type: "capabilities.list" }, emit);
    const afterDelete = [...events].reverse().find((e): e is Extract<ServerEvent, { type: "capabilities" }> => e.type === "capabilities");
    assert(afterDelete?.agents.some((a) => a.agentId === agentId) === false, "deleted agent is gone from the capability catalog");

    // secrets store roundtrip (ids only, never values)
    await core.handle({ type: "secrets.set", provider: "anthropic", apiKey: "sk-test-xxx" }, emit);
    const status = [...events].reverse().find((e): e is Extract<ServerEvent, { type: "secrets.status" }> => e.type === "secrets.status");
    assert(status?.providers.includes("anthropic") === true, "secrets.set → secrets.status lists provider (not the value)");
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
