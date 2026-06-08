/**
 * Provider + model catalog for the UI. Mirrors the converter's accepted providers
 * (resolved via Flue's pi-ai catalog). Model lists are a curated convenience — the
 * converter accepts any model id, so the wizard also offers a “Custom…” option.
 */

export interface ProviderEntry {
  /** Provider id used in the model specifier `<id>/<model>` and for the API key. */
  id: string;
  /** Human label for the UI. */
  label: string;
  /** Common models for this provider (best-effort; Custom… covers the rest). */
  models: string[];
}

export const PROVIDER_CATALOG: ProviderEntry[] = [
  { id: "anthropic", label: "Anthropic", models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"] },
  { id: "openai", label: "OpenAI", models: ["gpt-5.5", "gpt-5", "gpt-5-mini"] },
  { id: "google", label: "Google Gemini", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  {
    id: "openrouter",
    label: "OpenRouter",
    models: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5", "google/gemini-2.5-pro", "moonshotai/kimi-k2.6"],
  },
  { id: "deepseek", label: "DeepSeek", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "xai", label: "xAI (Grok)", models: ["grok-4", "grok-3"] },
  { id: "groq", label: "Groq", models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
  { id: "cerebras", label: "Cerebras", models: ["llama-3.3-70b"] },
  { id: "mistral", label: "Mistral", models: ["mistral-large-latest", "mistral-small-latest"] },
  { id: "together", label: "Together AI", models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"] },
  { id: "fireworks", label: "Fireworks", models: ["accounts/fireworks/models/llama-v3p3-70b-instruct"] },
  // OpenCode Zen / Go gateways — model ids vary, so leave the catalog empty and
  // let the wizard fall back to the Custom… field.
  { id: "opencode", label: "OpenCode Zen", models: [] },
  { id: "opencode-go", label: "OpenCode Go", models: [] },
  { id: "cloudflare", label: "Cloudflare Workers AI", models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"] },
];

/** Just the provider ids, e.g. for the Settings key list. */
export const PROVIDER_IDS = PROVIDER_CATALOG.map((p) => p.id);

export function modelsFor(providerId: string): string[] {
  return PROVIDER_CATALOG.find((p) => p.id === providerId)?.models ?? [];
}
