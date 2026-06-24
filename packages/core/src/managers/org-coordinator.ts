/**
 * OrgCoordinator — the org (G1) lifecycle cluster extracted from `GatewayCore`
 * (god-object decomposition, issue #65). It wraps the existing `OrgManager`
 * (`org/org-manager.ts`, the registry/reconcile logic) and owns the local binding
 * store + the active manager handle, plus the request handlers the Gateway API
 * routes here (create/join/leave/sync/share/unshare/members/status, the J4 Engram
 * server deploy, and boot sync).
 *
 * Org is the most coupled cluster: it drives the central agent registry (connect
 * synced org agents, tear them down on leave) and the session maps. Rather than
 * hold those itself, it reaches them through the injected `OrgHost` seam — the
 * Core implements it over its `#agents` map, `#onlineCache`, the SessionManager,
 * and the agent-summary logic. A future AgentRegistry would become this host.
 * The Gateway API is unchanged.
 */

import { createAdapterForStored, sessionInstanceId } from "../adapters/factory.js";
import type { AgentAdapter } from "../adapters/agent-adapter.js";
import type { FlueDeployer } from "../deploy/flue-deployer.js";
import { orgSlugFromName } from "../deploy/engram-server-deployer.js";
import type { GatewayState, StoredAgent } from "../state/index.js";
import type { ClientRequest, ServerEvent } from "../api.js";
import { OrgManager, ROUTABLE_TARGETS } from "../org/org-manager.js";
import { GitHubRegistry } from "../org/github-registry.js";
import { OrgStore } from "../org/org-store.js";
import { OrgError } from "../org/registry.js";
import type { OrgRegistry, SharedAgentEntry } from "../org/registry.js";

type Emit = (event: ServerEvent) => void;

/**
 * Extract a human-readable error message from an error, preferring OrgError
 * messages (which are pre-formatted for the user) over generic Error.message.
 */
function orgErrorMessage(err: unknown): string {
  if (err instanceof OrgError) return err.message;
  return (err as Error)?.message ?? "Unknown org error";
}

/**
 * The seam onto the Core's central agent registry that org coordination needs.
 * Implemented by GatewayCore over its `#agents` map, `#onlineCache`, the
 * SessionManager, and the agent-summary logic.
 */
export interface OrgHost {
  /** True when an agent has a live adapter registered. */
  hasLiveAgent(agentId: string): boolean;
  /** Register a synced org agent's live adapter (no token — G1 shares never carry one). */
  registerOrgAgent(stored: StoredAgent, adapter: AgentAdapter): void;
  /** Close + drop a live org agent and drain its sessions (org leave). */
  teardownOrgAgent(agentId: string): Promise<void>;
  /** Whether the agent was connected with a bearer token (ORG-07 guard). */
  agentHasToken(agentId: string): boolean;
  /** Push a server-initiated event to all connected clients. */
  broadcast(event: ServerEvent): void;
  /** The current `agents` list event (summaries with live-online state). */
  agentsListEvent(): Extract<ServerEvent, { type: "agents" }>;
}

export interface OrgCoordinatorDeps {
  state: GatewayState;
  deployer: FlueDeployer;
  /** Injected OrgRegistry for tests; when set, GitHubRegistry is not used. */
  orgRegistryOverride: OrgRegistry | undefined;
  host: OrgHost;
}

export class OrgCoordinator {
  readonly #state: GatewayState;
  readonly #deployer: FlueDeployer;
  readonly #orgRegistryOverride: OrgRegistry | undefined;
  readonly #host: OrgHost;
  readonly #orgStore = new OrgStore();
  #orgManager: OrgManager | null = null;

  constructor(deps: OrgCoordinatorDeps) {
    this.#state = deps.state;
    this.#deployer = deps.deployer;
    this.#orgRegistryOverride = deps.orgRegistryOverride;
    this.#host = deps.host;
  }

  /**
   * Build the active OrgManager for the given repo. Creates a new GitHubRegistry
   * for the repo (or uses the injected override for tests).
   */
  #makeOrgManager(repo: string): OrgManager {
    const registry = this.#orgRegistryOverride ?? new GitHubRegistry(repo);
    return new OrgManager(registry, this.#orgStore, this.#state);
  }

  /**
   * Build the payload for an org.status event from the current local binding,
   * org_agents DB state, and the OrgManager's in-memory own-shares set.
   * Returns { bound: false } when not bound.
   */
  #buildOrgStatus(): Omit<Extract<ServerEvent, { type: "org.status" }>, "type"> {
    const binding = this.#orgStore.load();
    if (!binding) return { bound: false };
    return {
      bound: true,
      orgName: binding.orgName,
      repo: binding.repo,
      myLogin: binding.myLogin,
      role: binding.role,
      sharedAgentIds: this.#state.listOrgAgentIds(binding.orgId),
      ownSharedAgentIds: this.#orgManager?.getOwnSharedAgentIds() ?? [],
    };
  }

  /**
   * Attempt to connect all org agents for the given orgId that are not yet
   * registered. Best-effort: unreachable agents stay offline; the health loop
   * will reconnect them later (ORG-10).
   */
  async #connectOrgAgents(orgId: string): Promise<void> {
    for (const orgRow of this.#state.listOrgAgents(orgId)) {
      if (this.#host.hasLiveAgent(orgRow.agentId)) continue;
      const stored = this.#state.getAgent(orgRow.agentId);
      if (!stored?.sourceRef) continue;
      try {
        const adapter = await createAdapterForStored(stored);
        if (!this.#host.hasLiveAgent(orgRow.agentId)) {
          this.#host.registerOrgAgent(stored, adapter);
        } else {
          await adapter.close().catch(() => {});
        }
      } catch {
        // Agent unreachable — stays offline; health loop will reconnect (ORG-10).
      }
    }
  }

  /**
   * Non-blocking org sync on boot (ORG-08). Reads the local binding; if bound,
   * creates an OrgManager, runs reconcile, and attempts to connect synced agents.
   * Failures are swallowed with a console.error — startup must NOT be blocked.
   */
  async syncOnBoot(): Promise<void> {
    const binding = this.#orgStore.load();
    if (!binding) return;
    try {
      this.#orgManager = this.#makeOrgManager(binding.repo);
      const result = await this.#orgManager.reconcile();
      await this.#connectOrgAgents(result.orgId);
      // Broadcast the populated org.status to any clients that connected while
      // boot sync was in flight (ORG-08: non-blocking but still observable).
      this.#host.broadcast({ type: "org.status", ...this.#buildOrgStatus() });
    } catch (err) {
      // Boot sync failure must not prevent Fleet from starting (ORG-11).
      console.error("[gateway-core] org boot sync failed:", (err as Error).message ?? err);
    }
  }

  /** Emit the current org binding state. */
  status(emit: Emit): void {
    emit({ type: "org.status", ...this.#buildOrgStatus() });
  }

  /**
   * Deploy (or idempotently redeploy) the per-org Engram cloud shared-memory
   * server to Dokploy (J4 — MEM-01/MEM-02). The org slug defaults to the bound
   * org's name when omitted; secrets are resolved server-side by the deployer
   * from the secure store / operator env (rule #8). Progress and logs stream as
   * `orgMemory.*` events; failures are emitted as `orgMemory.error` (never thrown).
   */
  async deployEngramServer(req: Extract<ClientRequest, { type: "orgMemory.deployServer" }>, emit: Emit): Promise<void> {
    try {
      const binding = this.#orgStore.load();
      const orgSlug = req.orgSlug?.trim() || (binding ? orgSlugFromName(binding.orgName) : "");
      if (!orgSlug) {
        emit({
          type: "orgMemory.error",
          message: "No org slug: bind an org first (Settings → Org) or pass orgSlug explicitly.",
        });
        return;
      }
      const result = await this.#deployer.deployEngramServer({
        orgSlug,
        allowedProjects: req.allowedProjects ?? [],
        onProgress: (step, detail) => emit({ type: "orgMemory.progress", step, detail }),
        onLog: (lines) => emit({ type: "orgMemory.log", lines }),
      });
      emit({ type: "orgMemory.deployed", composeId: result.composeId, composeName: result.composeName, reused: result.reused });
    } catch (err) {
      emit({ type: "orgMemory.error", message: (err as Error).message });
    }
  }

  /** Create a new org and bind this Core instance as owner (ORG-01). */
  async create(req: Extract<ClientRequest, { type: "org.create" }>, emit: Emit): Promise<void> {
    try {
      this.#orgManager = this.#makeOrgManager(req.repo);
      await this.#orgManager.createOrg(req.repo, req.name);
      emit({ type: "org.status", ...this.#buildOrgStatus() });
    } catch (err) {
      emit({ type: "org.error", message: orgErrorMessage(err), requestType: "org.create" });
    }
  }

  /** Join an existing org as a member (ORG-02). */
  async join(req: Extract<ClientRequest, { type: "org.join" }>, emit: Emit): Promise<void> {
    try {
      this.#orgManager = this.#makeOrgManager(req.repo);
      await this.#orgManager.bindOrg(req.repo);
      emit({ type: "org.status", ...this.#buildOrgStatus() });
    } catch (err) {
      emit({ type: "org.error", message: orgErrorMessage(err), requestType: "org.join" });
    }
  }

  /**
   * Leave the org (ORG-03): close all org agent adapters, let OrgManager prune
   * the DB, clear the local binding, and broadcast the updated agent list.
   */
  async leave(emit: Emit): Promise<void> {
    const binding = this.#orgStore.load();
    if (!binding) {
      emit({ type: "org.status", bound: false });
      return;
    }
    try {
      // Close adapters and drain in-flight sessions for org agents so no ghost
      // connections or ghost sessions linger after the org binding is cleared.
      for (const id of this.#state.listOrgAgentIds(binding.orgId)) {
        await this.#host.teardownOrgAgent(id);
      }
      if (this.#orgManager) {
        await this.#orgManager.leave();
      } else {
        // No active manager (e.g. boot binding not yet wired) — clear directly.
        this.#orgStore.clear();
      }
      this.#orgManager = null;
      emit({ type: "org.status", bound: false });
      // Broadcast refreshed agent list (org agents removed).
      emit(this.#host.agentsListEvent());
    } catch (err) {
      emit({ type: "org.error", message: orgErrorMessage(err), requestType: "org.leave" });
    }
  }

  /** Manual pull+reconcile (ORG-09). Emits org.synced + updated agents + org.status. */
  async sync(emit: Emit): Promise<void> {
    const manager = this.#orgManager;
    if (!manager?.isBound()) {
      emit({ type: "org.error", message: "Not bound to any org — join or create an org first", requestType: "org.sync" });
      return;
    }
    try {
      const result = await manager.reconcile();
      await this.#connectOrgAgents(result.orgId);
      emit({ type: "org.synced", count: result.count, at: result.at });
      emit({ type: "org.status", ...this.#buildOrgStatus() });
      emit(this.#host.agentsListEvent());
    } catch (err) {
      emit({ type: "org.error", message: orgErrorMessage(err), requestType: "org.sync" });
    }
  }

  /**
   * Share a locally deployed remote agent to the org registry (ORG-04).
   * Guards at this layer (defense in depth, ADR-5):
   * - ORG-06: target must be remotely routable (non-local).
   * - ORG-07: agent must not have been connected with a bearer token.
   * - Source agent must exist, must NOT be an org agent itself, must have a deploy record.
   * OrgManager.shareAgent also enforces ORG-06 for a second layer of defense.
   */
  async share(req: Extract<ClientRequest, { type: "org.share" }>, emit: Emit): Promise<void> {
    const manager = this.#orgManager;
    if (!manager?.isBound()) {
      emit({ type: "org.error", message: "Not bound to any org — join or create an org first", requestType: "org.share" });
      return;
    }
    // Cannot share an org-sourced agent (connect-only, not the owner).
    if (this.#state.isOrgAgent(req.agentId)) {
      emit({ type: "org.error", message: "Cannot share an org-sourced agent — only locally owned agents can be shared", requestType: "org.share" });
      return;
    }
    const stored = this.#state.getAgent(req.agentId);
    if (!stored) {
      emit({ type: "org.error", message: `Agent "${req.agentId}" not found`, requestType: "org.share" });
      return;
    }
    // ORG-07: reject token-protected agents. Fleet doesn't persist tokens (ADR-4),
    // so we can only check the in-memory registration for the current session.
    // OFFLINE BYPASS (G1 limitation): an agent not currently in #agents (offline /
    // not yet reconnected) has no hasToken info — a token-protected-but-offline
    // agent can be shared without detection. Best-effort guard only.
    if (this.#host.agentHasToken(req.agentId)) {
      emit({ type: "org.error", message: "Token-protected agents cannot be shared in G1 — members would be unable to connect without the secret", requestType: "org.share" });
      return;
    }
    const deploy = this.#state.getDeploy(req.agentId);
    if (!deploy || !ROUTABLE_TARGETS.has(deploy.target)) {
      emit({
        type: "org.error",
        requestType: "org.share",
        message: deploy
          ? `Local agents cannot be shared (non-routable target: ${deploy.target})`
          : `Agent "${stored.name}" has no deploy record — only remotely deployed agents can be shared`,
      });
      return;
    }
    const bindingShare = manager.getBinding()!;
    const entry: SharedAgentEntry = {
      schemaVersion: 1,
      id: stored.id,
      name: stored.name,
      version: stored.version,
      description: stored.description,
      model: stored.model,
      target: deploy.target as "fly" | "cloudflare" | "dokploy" | "github",
      url: stored.sourceRef,
      sharedBy: bindingShare.myLogin,
      sharedAt: new Date().toISOString(),
      // envVarNames not tracked in G1 — only display metadata and URL are shared.
      config: { envVarNames: [] },
    };
    try {
      await manager.shareAgent(entry);
      emit({ type: "org.status", ...this.#buildOrgStatus() });
    } catch (err) {
      emit({ type: "org.error", message: orgErrorMessage(err), requestType: "org.share" });
    }
  }

  /** Unshare a previously shared agent from the registry (ORG-05). */
  async unshare(req: Extract<ClientRequest, { type: "org.unshare" }>, emit: Emit): Promise<void> {
    const manager = this.#orgManager;
    if (!manager?.isBound()) {
      emit({ type: "org.error", message: "Not bound to any org — join or create an org first", requestType: "org.unshare" });
      return;
    }
    try {
      await manager.unshareAgent(req.agentId);
      emit({ type: "org.status", ...this.#buildOrgStatus() });
    } catch (err) {
      emit({ type: "org.error", message: orgErrorMessage(err), requestType: "org.unshare" });
    }
  }

  /** List live org members (ORG-11 uses GitHub collaborators as the ACL). */
  async members(emit: Emit): Promise<void> {
    const manager = this.#orgManager;
    if (!manager?.isBound()) {
      emit({ type: "org.error", message: "Not bound to any org — join or create an org first", requestType: "org.members" });
      return;
    }
    try {
      const members = await manager.listMembers();
      emit({ type: "org.members", members });
    } catch (err) {
      emit({ type: "org.error", message: orgErrorMessage(err), requestType: "org.members" });
    }
  }
}
