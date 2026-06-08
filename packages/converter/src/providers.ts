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
 * Flue's BUILT-IN provider ids (no `registerProvider` needed). Others (e.g.
 * Google) would require a custom `registerProvider` and are rejected here so the
 * converter never emits an agent that cannot resolve its model.
 */
const PROVIDERS: Record<string, ProviderInfo> = {
  anthropic: { id: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
  openai: { id: "openai", apiKeyEnv: "OPENAI_API_KEY" },
  openrouter: { id: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
  cloudflare: { id: "cloudflare", apiKeyEnv: "CLOUDFLARE_API_TOKEN" },
};

/** Sensible default model per provider when only `--provider` is given. */
const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.5",
  openrouter: "anthropic/claude-sonnet-4-6",
  cloudflare: "@cf/meta/llama-3.1-8b-instruct",
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
  if (opts.model) modelId = opts.model;
  else if (opts.provider) modelId = DEFAULT_MODEL[providerId]!;
  else modelId = sourceId;

  return { specifier: `${providerId}/${modelId}`, provider };
}

/** Strip a leading `provider/` from a model spec, returning the bare model id. */
function bareModelId(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}
