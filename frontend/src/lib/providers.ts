/**
 * Provider + model catalog for the UI. Provider ids/labels are maintained here;
 * the model lists come from src/lib/models.generated.ts, generated from Flue's
 * pi-ai catalog (real ids the runtime can resolve). The wizard also offers a
 * “Custom…” option for anything not listed.
 */

import { PROVIDER_MODELS } from "./models.generated";

export interface ProviderEntry {
  /** Provider id used in the model specifier `<id>/<model>` and for the API key. */
  id: string;
  /** Human label for the UI. */
  label: string;
  /** Real model ids for this provider (from the generated catalog). */
  models: string[];
}

const PROVIDER_LABELS: { id: string; label: string }[] = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "xai", label: "xAI (Grok)" },
  { id: "groq", label: "Groq" },
  { id: "cerebras", label: "Cerebras" },
  { id: "mistral", label: "Mistral" },
  { id: "moonshotai", label: "Moonshot AI" },
  { id: "together", label: "Together AI" },
  { id: "fireworks", label: "Fireworks" },
  { id: "nvidia", label: "NVIDIA NIM" },
  { id: "opencode", label: "OpenCode Zen" },
  { id: "opencode-go", label: "OpenCode Go" },
  { id: "cloudflare", label: "Cloudflare Workers AI" },
];

export const PROVIDER_CATALOG: ProviderEntry[] = PROVIDER_LABELS.map((p) => ({
  ...p,
  models: PROVIDER_MODELS[p.id] ?? [],
}));

/** Just the provider ids, e.g. for the Settings key list. */
export const PROVIDER_IDS = PROVIDER_CATALOG.map((p) => p.id);

export function modelsFor(providerId: string): string[] {
  return PROVIDER_MODELS[providerId] ?? [];
}
