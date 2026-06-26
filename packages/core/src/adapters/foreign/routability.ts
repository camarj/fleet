/**
 * Routability guard for A2A agent registration (pivote A2, ADR-13; CONTEXT.md
 * "Routable"). An agent registered as a remotely-orchestrable A2A agent MUST be
 * reachable by a public URL — the Orchestrator (and other Fleets) have to reach
 * it over the network. A URL pointing at a local or private host is non-routable
 * and is rejected, mirroring the ORG-06 rule for Flue deploy targets (where
 * `docker-local`/`local-process` are non-routable and may not be shared).
 *
 * This is a structural check on the URL's host, not a reachability probe: a public
 * host that happens to be down is still "routable" (the health loop tracks online
 * state separately). Only hosts that are inherently local/private are refused.
 */

export type RoutabilityResult = { ok: true } | { ok: false; reason: string };

/** Validate that `raw` is an absolute http(s) URL whose host is publicly routable. */
export function isRoutableUrl(raw: string): RoutabilityResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid absolute URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Only http(s) A2A endpoints can be registered (got "${url.protocol}").` };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isNonRoutableHost(host)) {
    return {
      ok: false,
      reason: `"${host}" is a local or private host — a remotely orchestrable A2A agent must be reachable by a public URL (see CONTEXT.md "Routable").`,
    };
  }
  return { ok: true };
}

/** Local / private / loopback / link-local hosts that can't be reached remotely. */
function isNonRoutableHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true; // mDNS
  if (host === "host.docker.internal") return true; // Docker host bridge
  if (host === "::1" || host === "::") return true; // IPv6 loopback / unspecified
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0) return true; // "this" network / 0.0.0.0
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local
  }
  return false;
}
