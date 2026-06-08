/**
 * Generate the UI model catalog from Flue's underlying model catalog
 * (@earendil-works/pi-ai dist/models.generated.js). Produces
 * src/lib/models.generated.ts with real model ids per provider, so the deploy
 * wizard's dropdowns never offer ids the runtime can't resolve.
 *
 * Re-run after bumping @flue/runtime / pi-ai:
 *   node frontend/scripts/generate-models.mjs
 */

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const pnpmDir = join(repoRoot, "node_modules", ".pnpm");

const piEntry = readdirSync(pnpmDir).find((d) => d.startsWith("@earendil-works+pi-ai@"));
if (!piEntry) throw new Error("pi-ai not found under node_modules/.pnpm — run pnpm install first.");
const modelsFile = join(pnpmDir, piEntry, "node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js");

const { MODELS } = await import(pathToFileURL(modelsFile).href);

// Converter provider id → pi-ai catalog key (alias only where they differ).
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
for (const [id, catalogKey] of Object.entries(PROVIDER_TO_CATALOG)) {
  out[id] = MODELS[catalogKey] ? Object.keys(MODELS[catalogKey]) : [];
}

const ts =
  `// AUTO-GENERATED from @earendil-works/pi-ai (Flue's model catalog). Do not edit.\n` +
  `// Regenerate: node frontend/scripts/generate-models.mjs\n` +
  `export const PROVIDER_MODELS: Record<string, string[]> = ${JSON.stringify(out, null, 2)};\n`;

writeFileSync(join(here, "..", "src", "lib", "models.generated.ts"), ts);
const total = Object.values(out).reduce((a, b) => a + b.length, 0);
console.log(`wrote src/lib/models.generated.ts — ${Object.keys(out).length} providers, ${total} models`);
