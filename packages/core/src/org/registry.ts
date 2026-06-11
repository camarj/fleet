/**
 * OrgRegistry — the interface that every registry backend must implement.
 * Fleet G1 ships one backend (GitHubRegistry, packages/core/src/org/github-registry.ts)
 * that reads and writes the registry via `gh api` (GitHub Contents REST). A future
 * hosted-service backend is a one-class swap behind this interface.
 *
 * Rule #8: NEVER put secret values here. config.envVarNames carries only names.
 * Rule #4: No Flue wire types here — this module is registry-transport-agnostic.
 */

// ── Typed error ─────────────────────────────────────────────────────────────

/**
 * OrgError — all OrgRegistry implementations MUST throw this instead of a
 * generic Error. Callers branch on `code` without string-matching, which keeps
 * the hosted-registry swap a one-class change.
 */
export class OrgError extends Error {
  constructor(
    public readonly code: "unauthorized" | "notFound" | "networkError" | "conflict" | "alreadyExists",
    message: string,
  ) {
    super(message);
    this.name = "OrgError";
  }
}

// ── Shared repo format types ────────────────────────────────────────────────

/**
 * One entry in the registry repo's `agents/<agentId>.json`.
 *
 * schemaVersion: readers SKIP (and log) entries with schemaVersion greater than
 * the known max for forward compatibility. Current known max: 1.
 *
 * config.envVarNames: env-var NAMES only. Values MUST NEVER be written to the
 * registry repo (rule #8, ADR-4).
 *
 * Sharable targets are restricted to remotely routable deployments:
 * fly | cloudflare | dokploy | github. docker-local and local-process are
 * non-routable and MUST NOT appear here (ORG-06).
 */
export interface SharedAgentEntry {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  description: string;
  model: string;
  target: "fly" | "cloudflare" | "dokploy" | "github";
  url: string;
  /** Authenticated user identity of the sharing owner (format is implementation-defined by the registry backend). */
  sharedBy: string;
  sharedAt: string;  // ISO 8601
  config: {
    /** Env-var NAMES that callers must provide. Never include values. */
    envVarNames: string[];
  };
}

/**
 * Contents of `org.json` in the registry root.
 *
 * schemaVersion: same forward-compat rule as SharedAgentEntry.
 */
export interface OrgMeta {
  schemaVersion: number;
  orgId: string;
  name: string;
  /** Authenticated user identity of the org creator (format is implementation-defined by the registry backend). */
  owner: string;
  createdAt: string; // ISO 8601
}

/** One collaborator row returned by listMembers(). */
export interface OrgMember {
  login: string;
  role: OrgRole;
}

/** Descriptive role — derived from org.json.owner vs whoami (ADR-3b). */
export type OrgRole = "owner" | "member";

/**
 * Snapshot of the local org binding state — emitted as org.status over the
 * Gateway API (ADR-5). sharedAgentIds = ids currently in the registry directory
 * (drives the share-toggle state on the owner side).
 */
export interface OrgStatus {
  bound: boolean;
  orgName: string;
  repo: string;
  myLogin: string;
  role: OrgRole;
  sharedAgentIds: string[];
}

// ── Registry interface ──────────────────────────────────────────────────────

/**
 * OrgRegistry — backend-agnostic org operations.
 *
 * Each method maps directly to a Gateway API request (ORG-16). Implementations
 * MUST throw OrgError (not a generic Error) so callers can branch on `code`
 * without string-matching — this is what keeps the hosted-registry swap a
 * one-class change (ORG-11).
 *
 * inviteMember is optional: the gh admin scope may not be available, in which
 * case the implementation omits it and the Core tells the user to invite on
 * GitHub directly.
 */
export interface OrgRegistry {
  /** Resolve the authenticated user identity. */
  whoami(): Promise<string>;

  /**
   * Create a new org: commit org.json to the registry repo and return OrgMeta.
   * The CALLER is responsible for persisting the local binding (OrgStore is not
   * the registry's concern). Transitions local state: none → owner (ADR-3b).
   *
   * MUST throw OrgError('alreadyExists') if org.json is already present in the repo.
   */
  createOrg(repo: string, name: string): Promise<OrgMeta>;

  /**
   * Join an existing org: read org.json, verify collaborator access, and return
   * OrgMeta. The CALLER is responsible for persisting the local binding (OrgStore
   * is not the registry's concern). Transitions local state: none → member.
   */
  bindOrg(repo: string): Promise<OrgMeta>;

  /**
   * Pull the full shared-agent directory: list agents/*.json then fetch each.
   * Returns all entries whose schemaVersion is ≤ the known max.
   *
   * Throws OrgError on network/auth failure. Individual entries that fail schema
   * validation MUST be skipped (with a console.warn); partial results are acceptable.
   */
  pullDirectory(): Promise<SharedAgentEntry[]>;

  /**
   * Write agents/<entry.id>.json to the registry repo (ORG-04).
   * Entry MUST NOT contain secrets (rule #8).
   */
  shareAgent(entry: SharedAgentEntry): Promise<void>;

  /**
   * Delete agents/<agentId>.json from the registry repo (ORG-05).
   */
  unshareAgent(agentId: string): Promise<void>;

  /**
   * List live collaborators from the GitHub repo (ADR-4: no members.json).
   */
  listMembers(): Promise<OrgMember[]>;

  /**
   * Read-only re-read of org.json. Used by sync loops that need the current
   * remote state without triggering any collaborator-verification side effects.
   */
  getOrgMeta(): Promise<OrgMeta>;

  /**
   * Optional: add a collaborator via GitHub API.
   * Absent when the implementation lacks admin scope.
   */
  inviteMember?(login: string): Promise<void>;
}
