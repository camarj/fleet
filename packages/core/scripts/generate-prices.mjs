/**
 * Generate the Core's price table from Flue's underlying model catalog
 * (@earendil-works/pi-ai dist/models.generated.js) — the same source the agent
 * runtime uses for its own accounting. Produces src/pricing/prices.generated.ts
 * with USD-per-1M-token prices keyed "provider/model", using the converter's
 * provider ids so the keys match how usage rows record `model`.
 *
 * Models without cost data in the catalog are skipped (computeCostUsd returns
 * null for them — cost unknown, never guessed).
 *
 * Re-run after bumping @flue/runtime / pi-ai:
 *   node packages/core/scripts/generate-prices.mjs
 */

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const pnpmDir = join(repoRoot, "node_modules", ".pnpm");

const piEntry = readdirSync(pnpmDir).find((d) => d.startsWith("@earendil-works+pi-ai@"));
if (!piEntry) throw new Error("pi-ai not found under node_modules/.pnpm — run pnpm install first.");
const modelsFile = join(pnpmDir, piEntry, "node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js");

const { MODELS } = await import(pathToFileURL(modelsFile).href);

// Converter provider id → pi-ai catalog key (alias only where they differ).
// Keep in sync with frontend/scripts/generate-models.mjs.
const PROVIDER_TO_CATALOG = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  google: "google",
  deepseek: "deepseek",
  xai: "xai",
  groq: "groq",
  cerebras: "cerebras",
  mistral: "mistral",
  moonshotai: "moonshotai",
  fireworks: "fireworks",
  together: "together",
  nvidia: "nvidia",
  opencode: "opencode",
  "opencode-go": "opencode-go",
  cloudflare: "cloudflare-workers-ai",
};

const out = {};
let skipped = 0;
for (const [id, catalogKey] of Object.entries(PROVIDER_TO_CATALOG)) {
  const models = MODELS[catalogKey] ?? {};
  for (const [modelId, m] of Object.entries(models)) {
    const cost = m?.cost;
    if (typeof cost?.input === "number" && typeof cost?.output === "number") {
      out[`${id}/${modelId}`] = { inputPer1M: cost.input, outputPer1M: cost.output };
    } else {
      skipped++;
    }
  }
}

const ts =
  `// AUTO-GENERATED from @earendil-works/pi-ai (Flue's model catalog). Do not edit.\n` +
  `// Regenerate: node packages/core/scripts/generate-prices.mjs\n` +
  `// USD per 1M tokens, keyed "provider/model" (converter provider ids).\n` +
  `export const GENERATED_PRICES: Record<string, { inputPer1M: number; outputPer1M: number }> = ${JSON.stringify(out, null, 2)};\n`;

writeFileSync(join(here, "..", "src", "pricing", "prices.generated.ts"), ts);
console.log(`wrote src/pricing/prices.generated.ts — ${Object.keys(out).length} priced models (${skipped} without cost data skipped)`);
