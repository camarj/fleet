/**
 * WU-07 acceptance test — deploy preflight checks.
 *
 * Exercises GatewayCore.handle({ type: "deploy.preflight" }) for each target,
 * asserting:
 *   - The expected check ids are present for each target.
 *   - github is exempt from the apiKey check.
 *   - The apiKey check is deterministic: ok=false with no secret, ok=true after set.
 *   - Every check entry conforms to the PreflightCheck shape.
 * CLI/daemon checks (docker, flyctl, git, gh, wrangler) are environment-
 * dependent — we assert on their PRESENCE and SHAPE, not their boolean value.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/preflight.test.ts
 */

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Isolate the secrets store to a clean dir so the apiKey check is deterministic
// (otherwise it reads the developer's real ~/.fleet/secrets.json and ok=true).
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".preflight-test");
process.env.GATEWAY_DATA_DIR = DATA_DIR;
rmSync(DATA_DIR, { recursive: true, force: true });

const { GatewayCore } = await import("../src/core.js");
import type { PreflightCheck, ServerEvent } from "../src/api.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

function isPreflightCheck(v: unknown): v is PreflightCheck {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c["id"] === "string" &&
    typeof c["label"] === "string" &&
    typeof c["ok"] === "boolean" &&
    (c["detail"] === undefined || typeof c["detail"] === "string")
  );
}

async function runPreflight(
  core: InstanceType<typeof GatewayCore>,
  params: Extract<{ type: "deploy.preflight"; provider?: string; model?: string; target: string }, object>,
): Promise<PreflightCheck[]> {
  const events: ServerEvent[] = [];
  await core.handle(params as Parameters<typeof core.handle>[0], (e) => events.push(e));
  const ev = events.find(
    (e): e is Extract<ServerEvent, { type: "deploy.preflight" }> => e.type === "deploy.preflight",
  );
  if (!ev) throw new Error("No deploy.preflight event emitted");
  return ev.checks;
}

async function main(): Promise<void> {
  const core = new GatewayCore({ dbPath: ":memory:" });

  try {
    // ── 1. docker-local without a provider key ────────────────────────────────
    console.log("\n[1] docker-local — no API key set");
    const checks1 = await runPreflight(core, { type: "deploy.preflight", target: "docker-local" });

    assert(checks1.every(isPreflightCheck), "all checks conform to PreflightCheck shape");
    assert(checks1.some((c) => c.id === "docker"), "docker-local: 'docker' check present");
    assert(checks1.some((c) => c.id === "apiKey"), "docker-local: 'apiKey' check present");

    const apiKeyCheck1 = checks1.find((c) => c.id === "apiKey")!;
    assert(apiKeyCheck1.ok === false, "apiKey check ok=false when no secret is set");
    assert(typeof apiKeyCheck1.detail === "string" && apiKeyCheck1.detail.length > 0, "apiKey check carries a detail hint when failing");

    // ── 2. docker-local after setting a provider key ──────────────────────────
    console.log("\n[2] docker-local — with anthropic key set");
    await core.handle({ type: "secrets.set", provider: "anthropic", apiKey: "sk-test-preflight" }, () => {});
    const checks2 = await runPreflight(core, {
      type: "deploy.preflight",
      target: "docker-local",
      provider: "anthropic",
    });

    const apiKeyCheck2 = checks2.find((c) => c.id === "apiKey")!;
    assert(apiKeyCheck2.ok === true, "apiKey check ok=true after setting the secret");
    assert(apiKeyCheck2.detail === undefined, "apiKey check has no detail when passing");

    // ── 3. fly ────────────────────────────────────────────────────────────────
    console.log("\n[3] fly target — check ids and shape");
    const checks3 = await runPreflight(core, { type: "deploy.preflight", target: "fly" });

    assert(checks3.every(isPreflightCheck), "fly: all checks conform to PreflightCheck shape");
    assert(checks3.some((c) => c.id === "flyctl"), "fly: 'flyctl' check present");
    assert(checks3.some((c) => c.id === "fly-api-token"), "fly: 'fly-api-token' check present");
    assert(checks3.some((c) => c.id === "apiKey"), "fly: 'apiKey' check present");

    // ── 4. cloudflare ─────────────────────────────────────────────────────────
    console.log("\n[4] cloudflare target — check ids and shape");
    const checks4 = await runPreflight(core, { type: "deploy.preflight", target: "cloudflare" });

    assert(checks4.every(isPreflightCheck), "cloudflare: all checks conform to PreflightCheck shape");
    assert(checks4.some((c) => c.id === "wrangler"), "cloudflare: 'wrangler' check present");
    assert(checks4.some((c) => c.id === "cloudflare-api-token"), "cloudflare: 'cloudflare-api-token' check present");
    assert(checks4.some((c) => c.id === "apiKey"), "cloudflare: 'apiKey' check present");
    // wrangler check is always ok=true (deployer auto-installs via npm)
    const wranglerCheck = checks4.find((c) => c.id === "wrangler")!;
    assert(wranglerCheck.ok === true, "cloudflare: wrangler check is always ok=true (auto-installs)");

    // ── 5. github — no apiKey check ───────────────────────────────────────────
    console.log("\n[5] github target — exempt from apiKey check");
    const checks5 = await runPreflight(core, { type: "deploy.preflight", target: "github" });

    assert(checks5.every(isPreflightCheck), "github: all checks conform to PreflightCheck shape");
    assert(checks5.some((c) => c.id === "git"), "github: 'git' check present");
    assert(checks5.some((c) => c.id === "gh"), "github: 'gh' check present");
    assert(!checks5.some((c) => c.id === "apiKey"), "github: NO 'apiKey' check (github is exempt)");

    // ── 6. unknown provider → apiKey check ok=false with an error detail ──────
    console.log("\n[6] unknown provider");
    const checks6 = await runPreflight(core, {
      type: "deploy.preflight",
      target: "docker-local",
      provider: "totally-unknown-provider-xyz",
    });
    const apiKeyCheck6 = checks6.find((c) => c.id === "apiKey")!;
    assert(apiKeyCheck6.ok === false, "unknown provider: apiKey check ok=false");
    assert(typeof apiKeyCheck6.detail === "string", "unknown provider: apiKey check has a detail message");
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
