/**
 * Provider registry + model-specifier resolution — the heart of the
 * "choosable provider/model" feature. Maps a target provider id to the env var
 * the Flue agent reads its key from, and resolves the final `provider/model`
 * specifier from the source model plus the convert options.
 */

import type { ConvertOptions } from "./types.js";

export class ConvertError extends Error {}

export interface ProviderInfo {
  id: string;
  /** Env var the Flue runtime reads the API key from for this provider. */
  apiKeyEnv: string;
}

/**
 * Providers Flue can resolve out of the box via the `@earendil-works/pi-ai`
 * catalog (verified against the installed pi-ai 0.79.0 — no `registerProvider`
 * needed). The value is the env var the runtime reads the API key from. Truly
 * unknown providers are rejected so the converter never emits an unresolvable
 * model. Providers that need a custom baseUrl (e.g. ollama) are out of scope.
 */
const PROVIDERS: Record<string, ProviderInfo> = {
  anthropic: { id: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
  openai: { id: "openai", apiKeyEnv: "OPENAI_API_KEY" },
  openrouter: { id: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
  google: { id: "google", apiKeyEnv: "GEMINI_API_KEY" },
  deepseek: { id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" },
  xai: { id: "xai", apiKeyEnv: "XAI_API_KEY" },
  groq: { id: "groq", apiKeyEnv: "GROQ_API_KEY" },
  cerebras: { id: "cerebras", apiKeyEnv: "CEREBRAS_API_KEY" },
  mistral: { id: "mistral", apiKeyEnv: "MISTRAL_API_KEY" },
  moonshotai: { id: "moonshotai", apiKeyEnv: "MOONSHOT_API_KEY" },
  fireworks: { id: "fireworks", apiKeyEnv: "FIREWORKS_API_KEY" },
  together: { id: "together", apiKeyEnv: "TOGETHER_API_KEY" },
  nvidia: { id: "nvidia", apiKeyEnv: "NVIDIA_API_KEY" },
  opencode: { id: "opencode", apiKeyEnv: "OPENCODE_API_KEY" },
  "opencode-go": { id: "opencode-go", apiKeyEnv: "OPENCODE_API_KEY" },
  cloudflare: { id: "cloudflare", apiKeyEnv: "CLOUDFLARE_API_KEY" },
};

/** Sensible default model per provider when only `--provider` is given. */
const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.5",
  openrouter: "anthropic/claude-sonnet-4-6",
  google: "gemini-2.5-pro",
  deepseek: "deepseek-chat",
  xai: "grok-4",
  groq: "llama-3.3-70b-versatile",
  cerebras: "llama-3.3-70b",
  mistral: "mistral-large-latest",
  moonshotai: "kimi-k2.6",
  fireworks: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  together: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  nvidia: "meta/llama-3.3-70b-instruct",
  cloudflare: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

export function knownProviders(): string[] {
  return Object.keys(PROVIDERS);
}

export interface ResolvedModel {
  /** Final Flue specifier, e.g. "anthropic/claude-sonnet-4-6". */
  specifier: string;
  provider: ProviderInfo;
}

/**
 * Resolve the final model specifier.
 * - no options → keep the source model under its source provider (Claude Code = anthropic)
 * - `--provider` only → that provider's default model
 * - `--model` only → new model under the source provider (anthropic)
 * - both → exactly `<provider>/<model>`
 */
export function resolveModel(sourceModel: string | undefined, opts: ConvertOptions): ResolvedModel {
  const sourceId = bareModelId(sourceModel) ?? DEFAULT_MODEL.anthropic!;
  const providerId = opts.provider ?? "anthropic";

  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new ConvertError(
      `Unknown target provider "${providerId}". Known built-in providers: ${knownProviders().join(", ")}. ` +
        `Other providers need a custom registerProvider() (not yet supported by the converter).`,
    );
  }

  let modelId: string;
  if (opts.model) {
    modelId = opts.model;
  } else if (opts.provider) {
    const def = DEFAULT_MODEL[providerId];
    if (!def) {
      throw new ConvertError(
        `Provider "${providerId}" has no default model — pass an explicit model, e.g. ${providerId}/<model-id>.`,
      );
    }
    modelId = def;
  } else {
    modelId = sourceId;
  }

  return { specifier: `${providerId}/${modelId}`, provider };
}

/** Strip a leading `provider/` from a model spec, returning the bare model id. */
function bareModelId(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}
