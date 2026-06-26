/**
 * A2 — register a third-party A2A agent by its Agent Card URL.
 *
 * Drives the Gateway API (GatewayCore.handle) in :memory': registering a routable
 * A2A endpoint builds an A2aAdapter (kind "a2a") and lists it alongside Flue
 * agents; a non-routable endpoint (localhost) is rejected by the routability guard.
 *
 * No network: the A2A endpoint host is the reserved `.invalid` TLD (RFC 2606), so
 * the well-known Agent Card fetch fails fast and A2aAdapter.connect falls back to
 * the name-only identity — exactly the unreachable-card path. The agent still
 * registers with kind "a2a".
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/a2a-register.test.ts
 */

import { GatewayCore } from "../src/core.js";
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
  // A long health interval so the loop never marks the unreachable agent offline
  // (or emits agent.updated) before the assertions run.
  const core = new GatewayCore({ dbPath: ":memory:", healthIntervalMs: 600_000 });
  const events: ServerEvent[] = [];
  const emit = (e: ServerEvent): void => {
    events.push(e);
  };

  try {
    // ── routable A2A endpoint registers ──
    await core.handle(
      { type: "agent.connectA2a", baseUrl: "https://orders-agent.example.invalid/a2a", agentName: "orders-agent" },
      emit,
    );
    const registered = events.find((e): e is Extract<ServerEvent, { type: "agent.registered" }> => e.type === "agent.registered");
    assert(!!registered, "agent.registered emitted for a routable A2A endpoint");
    assert(registered?.agent.kind === "a2a", "registered agent kind = a2a");
    assert(registered?.agent.name === "orders-agent", "identity falls back to the given name when the card is unreachable");
    assert(registered?.agent.target === null, "A2A agent has no deploy target (attached by URL)");
    assert(registered?.agent.redeployable === false, "A2A agent is not redeployable");
    assert(registered?.agent.online === true, "A2A agent registers online");

    // ── it lists alongside Flue agents, distinguishable by kind ──
    events.length = 0;
    await core.handle({ type: "agents.list" }, emit);
    const list = [...events].reverse().find((e): e is Extract<ServerEvent, { type: "agents" }> => e.type === "agents");
    assert(!!list, "agents.list → agents event");
    const a2a = list?.agents.find((a) => a.name === "orders-agent");
    assert(!!a2a, "the A2A agent appears in agents.list");
    assert(a2a?.kind === "a2a", "listed A2A agent is distinguishable from Flue by kind");

    // ── routability guard: a non-routable (localhost) endpoint is refused ──
    events.length = 0;
    await core.handle(
      { type: "agent.connectA2a", baseUrl: "http://localhost:9999/a2a", agentName: "local-agent" },
      emit,
    );
    const err = events.find((e): e is Extract<ServerEvent, { type: "error" }> => e.type === "error");
    assert(!!err, "non-routable A2A endpoint emits an error");
    assert(err?.requestType === "agent.connectA2a", "the guard error names the request type");
    assert(/routable|public URL/i.test(err?.message ?? ""), "the guard error explains the routability requirement");
    assert(!events.some((e) => e.type === "agent.registered"), "no agent.registered for a non-routable endpoint");

    // it never reached the registry
    events.length = 0;
    await core.handle({ type: "agents.list" }, emit);
    const list2 = [...events].reverse().find((e): e is Extract<ServerEvent, { type: "agents" }> => e.type === "agents");
    assert(list2?.agents.some((a) => a.name === "local-agent") === false, "the rejected agent is absent from the registry");
  } catch (err) {
    console.error("TEST ERROR:", err);
    process.exitCode = 1;
  } finally {
    await core.shutdown();
  }

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main();
