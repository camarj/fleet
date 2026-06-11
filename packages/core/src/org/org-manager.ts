/**
 * OrgManager — state machine + reconcile algorithm for G1 org registry.
 *
 * Orchestrates OrgRegistry (remote I/O) + OrgStore (local binding persistence)
 * + GatewayState (DB upsert/prune). This is the unit-test seam (ADR-7):
 * FakeRegistry replaces GitHubRegistry in tests so no `gh` process is needed.
 *
 * State machine (ADR-3b):
 *   none → owner  via createOrg()
 *   none → member via bindOrg()    (role derived: owner if whoami === meta.owner)
 *   any  → none   via leave()
 *
 * In PR1b this module is DATA-ONLY. Core.ts (PR2) wraps reconcile() and the
 * other public methods to emit Gateway API events (org.status / org.synced /
 * org.error). Do NOT emit WS events here.
 *
 * References: ADR-3b (state machine), ADR-3d (OrgManager role), ADR-5
 * (reconcile algorithm + prune hard rule), ORG-01..ORG-12.
 */

import type { GatewayState } from "../state/db.js";
import type { OrgBinding } from "./org-store.js";
import { OrgStore } from "./org-store.js";
import type { OrgMember, OrgMeta, OrgRegistry, SharedAgentEntry } from "./registry.js";
import { OrgError } from "./registry.js";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Remotely-routable deployment targets that may be shared in the registry.
 * docker-local and local-process are non-routable and MUST NOT be shared
 * (ORG-06). Using ReadonlySet<string> so the runtime has() accepts any value
 * including entries cast from DB rows.
 */
const ROUTABLE_TARGETS: ReadonlySet<string> = new Set([
  "fly",
  "cloudflare",
  "dokploy",
  "github",
]);

// ── Public types ─────────────────────────────────────────────────────────────

/** Returned by reconcile() on success. Core.ts uses this to build org.synced. */
export interface ReconcileResult {
  /** Number of shared agent entries pulled from the remote registry. */
  count: number;
  /** ISO 8601 timestamp at which this reconcile completed. */
  at: string;
  /** Org id that was reconciled (for downstream event payload). */
  orgId: string;
}

// ── OrgManager ────────────────────────────────────────────────────────────────

export class OrgManager {
  readonly #registry: OrgRegistry;
  readonly #store: OrgStore;
  readonly #state: GatewayState;

  /**
   * @param registry  OrgRegistry backend (GitHubRegistry in production;
   *                  FakeRegistry in tests).
   * @param store     OrgStore for local binding persistence.
   * @param state     GatewayState for agent row upsert/prune operations.
   */
  constructor(registry: OrgRegistry, store: OrgStore, state: GatewayState) {
    this.#registry = registry;
    this.#store = store;
    this.#state = state;
  }

  // ── State machine ──────────────────────────────────────────────────────────

  /**
   * Create a new org and persist the local binding (none → owner, ADR-3b).
   *
   * MUST throw OrgError('alreadyExists') when org.json already exists.
   * MUST throw OrgError('unauthorized') on auth / permission failure.
   * Caller is responsible for emitting org.status after this resolves.
   */
  async createOrg(repo: string, name: string): Promise<OrgMeta> {
    const meta = await this.#registry.createOrg(repo, name);
    const myLogin = await this.#registry.whoami();
    this.#store.save({
      schemaVersion: 1,
      repo,
      orgId: meta.orgId,
      orgName: meta.name,
      myLogin,
      role: "owner",
      lastSyncedAt: null,
    });
    return meta;
  }

  /**
   * Join an existing org and persist the local binding (none → member, ADR-3b).
   * Role is derived: "owner" when whoami === meta.owner, "member" otherwise.
   *
   * MUST throw OrgError on auth or access failure.
   * Caller is responsible for emitting org.status after this resolves.
   */
  async bindOrg(repo: string): Promise<OrgMeta> {
    const meta = await this.#registry.bindOrg(repo);
    const myLogin = await this.#registry.whoami();
    const role = myLogin === meta.owner ? "owner" : "member";
    this.#store.save({
      schemaVersion: 1,
      repo,
      orgId: meta.orgId,
      orgName: meta.name,
      myLogin,
      role,
      lastSyncedAt: null,
    });
    return meta;
  }

  /**
   * Leave the org (any → none, ORG-03):
   * 1. Prune ALL org agent rows for this orgId from the DB (cascade removes
   *    their sessions/usage). The remote registry repo is NOT modified.
   * 2. Clear the local binding file.
   * No-op when not currently bound.
   */
  async leave(): Promise<void> {
    const binding = this.#store.load();
    if (!binding) return;
    const ids = this.#state.listOrgAgentIds(binding.orgId);
    for (const id of ids) {
      this.#state.deleteOrgAgent(id);
    }
    this.#store.clear();
  }

  // ── Reconcile ─────────────────────────────────────────────────────────────

  /**
   * Pull the registry directory and reconcile into the local DB (ADR-5):
   *
   * 1. pullDirectory() — on FAILURE throws OrgError. The caller MUST catch
   *    and emit org.error; NO prune happens (existing org rows are kept intact
   *    so health-tick can still mark them online/offline). PRUNE HARD RULE.
   * 2. Upsert each pulled entry via state.upsertOrgAgent().
   * 3. PRUNE: listOrgAgentIds(orgId) minus pulledIds → deleteOrgAgent each.
   *    Scoped to this orgId; local agents (no org_agents row) are NEVER touched.
   * 4. Touch lastSyncedAt on the binding.
   *
   * Returns ReconcileResult on success.
   * Throws OrgError('notFound') when not bound.
   * Throws OrgError (from pullDirectory) on pull failure.
   */
  async reconcile(): Promise<ReconcileResult> {
    const binding = this.#store.load();
    if (!binding) throw new OrgError("notFound", "OrgManager: not bound to any org");

    const { orgId } = binding;

    // Step 1 — pull. Throws on failure; prune must NOT run on partial/failed pull.
    const entries = await this.#registry.pullDirectory();

    // Step 2 — upsert all pulled entries.
    const pulledIds = new Set<string>();
    for (const entry of entries) {
      this.#state.upsertOrgAgent(entry, orgId);
      pulledIds.add(entry.id);
    }

    // Step 3 — prune vanished entries (scoped to orgId only).
    const existingIds = this.#state.listOrgAgentIds(orgId);
    for (const id of existingIds) {
      if (!pulledIds.has(id)) {
        this.#state.deleteOrgAgent(id);
      }
    }

    // Step 4 — touch lastSyncedAt.
    const at = new Date().toISOString();
    this.#store.touchSyncedAt(at);

    return { count: entries.length, at, orgId };
  }

  // ── Registry pass-through (with guards) ───────────────────────────────────

  /**
   * Share an agent. ORG-06 guard: rejects non-routable targets (docker-local /
   * local-process) and empty url. Throws OrgError('conflict') on violation.
   */
  async shareAgent(entry: SharedAgentEntry): Promise<void> {
    if (!ROUTABLE_TARGETS.has(entry.target as string)) {
      throw new OrgError(
        "conflict",
        `ORG-06: target "${entry.target}" is non-routable and cannot be shared`,
      );
    }
    if (!entry.url) {
      throw new OrgError("conflict", "ORG-06: cannot share agent with empty url");
    }
    await this.#registry.shareAgent(entry);
  }

  /** Unshare an agent from the registry. */
  async unshareAgent(agentId: string): Promise<void> {
    await this.#registry.unshareAgent(agentId);
  }

  /** List live registry members. */
  async listMembers(): Promise<OrgMember[]> {
    return this.#registry.listMembers();
  }

  // ── Binding accessors ─────────────────────────────────────────────────────

  /** Return the current local binding, or null if not bound. */
  getBinding(): OrgBinding | null {
    return this.#store.load();
  }

  /** True when a binding file exists and is parseable. */
  isBound(): boolean {
    return this.#store.isBound();
  }
}
