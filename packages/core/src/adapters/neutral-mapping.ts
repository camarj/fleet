/**
 * Transport-agnostic helpers for mapping an agent's wire events onto Fleet's
 * neutral run model (`neutral.ts`).
 *
 * These pieces are deliberately NOT tied to Flue: `parseMcpTool` and
 * `UsageAccumulator` are the reusable "scaffolding" any adapter needs when it
 * translates its own protocol into `RunEvent`s. `FlueAdapter` (`flue.ts`) imports
 * them today; a future second adapter (`A2aAdapter`, ADR-13) will reuse the same
 * scaffolding instead of duplicating ~150 lines, contributing only the
 * discrimination specific to its own wire.
 */

import type { Usage } from "../neutral.js";

/**
 * Structural shape of a per-operation usage record. Mirrors Flue's `PromptUsage`
 * (declared but not exported by `@flue/sdk`) but is intentionally generic: any
 * adapter that can report `{ input, output, totalTokens }` feeds the same
 * accumulator. Accepting it structurally avoids importing a private SDK type.
 */
export interface TokenUsageLike {
  input: number;
  output: number;
  totalTokens: number;
}

/** `mcp__<server>__<tool>` → { server, name }; otherwise null. */
export function parseMcpTool(toolName: string): { server: string; name: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return m ? { server: m[1]!, name: m[2]! } : null;
}

/**
 * Aggregates per-operation usage across a run into the neutral Usage shape.
 * Tokens are `input`/`output`/`totalTokens`; neutral keeps the three core counts
 * plus the model specifier captured from turn metadata.
 */
export class UsageAccumulator {
  #input = 0;
  #output = 0;
  #total = 0;
  #model = "";

  add(usage: TokenUsageLike | undefined): void {
    if (!usage) return;
    this.#input += usage.input ?? 0;
    this.#output += usage.output ?? 0;
    this.#total += usage.totalTokens ?? 0;
  }

  /** Record the model/provider seen on a turn as a neutral specifier. */
  note(model: string | undefined, provider: string | undefined): void {
    if (!model) return;
    this.#model = provider ? `${provider}/${model}` : model;
  }

  total(): Usage {
    return { inputTokens: this.#input, outputTokens: this.#output, totalTokens: this.#total, model: this.#model };
  }
}
