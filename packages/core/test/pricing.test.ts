/**
 * Unit test — price table and cost computation.
 *
 * Verifies:
 *   1. The generated table covers the major providers (not just anthropic) and
 *      computes a real cost for a known specifier.
 *   2. Unknown specifiers return null (cost unknown, never guessed).
 *   3. GATEWAY_PRICES_PATH overrides win over generated entries and malformed
 *      entries are dropped.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/pricing.test.ts
 */

import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

async function main(): Promise<void> {
  // Set the override path BEFORE importing pricing.js (the table is built at import time).
  const overridePath = join(tmpdir(), `fleet-test-prices-${process.pid}.json`);
  writeFileSync(
    overridePath,
    JSON.stringify({
      "anthropic/claude-haiku-4-5": { inputPer1M: 100, outputPer1M: 200 },
      "custom/my-model": { inputPer1M: 7, outputPer1M: 9 },
      "broken/entry": { inputPer1M: "not-a-number" },
    }),
  );
  process.env.GATEWAY_PRICES_PATH = overridePath;

  try {
    const { computeCostUsd, PRICE_TABLE } = await import("../src/pricing/pricing.js");

    // ── 1. Generated coverage ──────────────────────────────────────────────
    console.log("\n[1] Generated table covers providers beyond anthropic");
    const keys = Object.keys(PRICE_TABLE);
    assert(keys.length > 100, `table has substantial coverage (got ${keys.length} entries)`);
    for (const provider of ["anthropic", "openai", "google", "deepseek", "opencode-go"]) {
      assert(
        keys.some((k) => k.startsWith(`${provider}/`)),
        `at least one priced model for ${provider}`,
      );
    }
    const usage = { model: "opencode-go/kimi-k2.6", inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };
    const kimiCost = computeCostUsd(usage);
    assert(typeof kimiCost === "number" && kimiCost > 0, `opencode-go/kimi-k2.6 has a real cost (got ${kimiCost})`);

    // ── 2. Unknown specifier → null ────────────────────────────────────────
    console.log("\n[2] Unknown specifier returns null");
    assert(
      computeCostUsd({ ...usage, model: "nope/never-heard-of-it" }) === null,
      "unknown model → null, never guessed",
    );

    // ── 3. Overrides ───────────────────────────────────────────────────────
    console.log("\n[3] GATEWAY_PRICES_PATH overrides");
    const overridden = computeCostUsd({ ...usage, model: "anthropic/claude-haiku-4-5" });
    assert(overridden === 300, `override wins over generated entry (got ${overridden}, want 300)`);
    const custom = computeCostUsd({ ...usage, model: "custom/my-model" });
    assert(custom === 16, `override can add models the catalog lacks (got ${custom}, want 16)`);
    assert(!("broken/entry" in PRICE_TABLE), "malformed override entries are dropped");
  } finally {
    delete process.env.GATEWAY_PRICES_PATH;
    rmSync(overridePath, { force: true });
  }

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main();
