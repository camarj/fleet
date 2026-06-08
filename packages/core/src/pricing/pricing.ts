/**
 * Cost computation. Agents carry usage as TOKENS ONLY — never money. The
 * Gateway turns tokens into cost using this price table, keyed by the neutral
 * model specifier the agent actually used (after overrides).
 *
 * Prices are indicative USD per 1M tokens and meant to be configurable later
 * (e.g. loaded from a file or the per-agent config). Unknown specifiers return
 * `null` (cost unknown) rather than guessing.
 */

import type { Usage } from "../neutral.js";

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
}

export const PRICE_TABLE: Record<string, ModelPrice> = {
  "anthropic/claude-opus-4-8": { inputPer1M: 15, outputPer1M: 75 },
  "anthropic/claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
  "anthropic/claude-haiku-4-5": { inputPer1M: 1, outputPer1M: 5 },
};

/** USD cost for a usage snapshot, or null when the specifier is not priced. */
export function computeCostUsd(usage: Usage, table: Record<string, ModelPrice> = PRICE_TABLE): number | null {
  const price = table[usage.model];
  if (!price) return null;
  return (usage.inputTokens / 1_000_000) * price.inputPer1M + (usage.outputTokens / 1_000_000) * price.outputPer1M;
}
