/**
 * OrgRegistry — the interface that every registry backend must implement.
 * Fleet G1 ships one backend (GitHubRegistry, packages/core/src/org/github-registry.ts)
 * that reads and writes the registry via `gh api` (GitHub Contents REST). A future
 * hosted-service backend is a one-class swap behind this interface.
 *
 * Rule #8: NEVER put secret values here. config.envVarNames carries only names.
 * Rule #4: No Flue wire types here — this module is registry-transport-agnostic.
 */

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
  sharedBy: string;  // gh login of the owner who shared
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
  owner: string;     // gh login of the org creator
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
 * Each method maps directly to a Gateway API request (ORG-16). Error paths
 * MUST throw with human-readable messages; callers surface them as org.error
 * events (ORG-11).
 *
 * inviteMember is optional: the gh admin scope may not be available, in which
 * case the implementation omits it and the Core tells the user to invite on
 * GitHub directly.
 */
export interface OrgRegistry {
  /** Resolve the authenticated GitHub login. */
  whoami(): Promise<string>;

  /**
   * Create a new org: commit org.json to the repo, persist the owner binding.
   * Transitions local state: none → owner (ADR-3b).
   */
  createOrg(repo: string, name: string): Promise<OrgMeta>;

  /**
   * Join an existing org: read org.json, verify collaborator access, persist
   * the member binding. Transitions local state: none → member.
   */
  bindOrg(repo: string): Promise<OrgMeta>;

  /**
   * Pull the full shared-agent directory: list agents/*.json then fetch each.
   * Returns all entries whose schemaVersion is ≤ the known max.
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
   * Optional: add a collaborator via GitHub API.
   * Absent when the implementation lacks admin scope.
   */
  inviteMember?(login: string): Promise<void>;
}
