/**
 * Cost computation. Agents carry usage as TOKENS ONLY — never money. The
 * Gateway turns tokens into cost using this price table, keyed by the neutral
 * model specifier the agent actually used (after overrides).
 *
 * Prices are indicative USD per 1M tokens. The base table is generated from
 * Flue's model catalog (prices.generated.ts — regenerate with
 * `node packages/core/scripts/generate-prices.mjs` after bumping pi-ai).
 * A JSON file at GATEWAY_PRICES_PATH ({"provider/model": {"inputPer1M": n,
 * "outputPer1M": n}, …}) overrides or extends the generated entries at startup.
 * Unknown specifiers return `null` (cost unknown) rather than guessing.
 */

import { readFileSync } from "node:fs";
import type { Usage } from "../neutral.js";
import { GENERATED_PRICES } from "./prices.generated.js";

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
}

/** Load price overrides from GATEWAY_PRICES_PATH; malformed entries are dropped. */
function loadPriceOverrides(): Record<string, ModelPrice> {
  const path = process.env.GATEWAY_PRICES_PATH;
  if (!path) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`[gateway-core] GATEWAY_PRICES_PATH (${path}) must be a JSON object keyed by "provider/model"`);
      return {};
    }
    const out: Record<string, ModelPrice> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const p = value as Partial<ModelPrice> | null;
      if (typeof p?.inputPer1M === "number" && typeof p?.outputPer1M === "number") {
        out[key] = { inputPer1M: p.inputPer1M, outputPer1M: p.outputPer1M };
      }
    }
    console.error(`[gateway-core] loaded ${Object.keys(out).length} price override(s) from ${path}`);
    return out;
  } catch (err) {
    console.error(`[gateway-core] could not load GATEWAY_PRICES_PATH (${path}):`, err);
    return {};
  }
}

export const PRICE_TABLE: Record<string, ModelPrice> = {
  ...GENERATED_PRICES,
  ...loadPriceOverrides(),
};

/** USD cost for a usage snapshot, or null when the specifier is not priced. */
export function computeCostUsd(usage: Usage, table: Record<string, ModelPrice> = PRICE_TABLE): number | null {
  const price = table[usage.model];
  if (!price) return null;
  return (usage.inputTokens / 1_000_000) * price.inputPer1M + (usage.outputTokens / 1_000_000) * price.outputPer1M;
}
