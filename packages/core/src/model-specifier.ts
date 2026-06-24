/**
 * Helpers for the neutral `"provider/model-id"` model specifier.
 */

/**
 * Split a `"provider/model-id"` specifier on its FIRST slash so model ids that
 * themselves contain slashes (e.g. openrouter-style) stay intact. Returns null
 * for an empty/malformed specifier (no provider or no model part).
 */
export function splitSpecifier(specifier: string | null): { provider: string; model: string } | null {
  if (!specifier) return null;
  const slash = specifier.indexOf("/");
  if (slash <= 0 || slash === specifier.length - 1) return null;
  return { provider: specifier.slice(0, slash), model: specifier.slice(slash + 1) };
}
