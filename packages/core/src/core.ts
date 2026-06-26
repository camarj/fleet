/**
 * GatewayCore — the brain. Connects to Flue agents over Flue's HTTP+WebSocket
 * API, maps their events into the neutral run model, and exposes high-level
 * operations the WebSocket server relays to the frontend.
 */

import { createAdapter, createAdapterForStored, sessionInstanceId } from "./adapters/factory.js";
import type { AgentAdapter, AgentKind } from "./adapters/agent-adapter.js";
import { FlueDeployer, pingAgent, type DeployTarget } from "./deploy/flue-deployer.js";
import { SecretsStore } from "./secrets/store.js";
import { GatewayState, type StoredAgent } from "./state/index.js";
import { DeployManager } from "./managers/deploy-manager.js";
import { SessionManager } from "./managers/session-manager.js";
import { WorkflowManager } from "./managers/workflow-manager.js";
import { OrgCoordinator, type OrgHost } from "./managers/org-coordinator.js";
import type { AgentSummary, Capability, ClientRequest, ServerEvent } from "./api.js";
import type { OrgRegistry } from "./org/registry.js";

export type Emit = (event: ServerEvent) => void;

// `splitSpecifier` moved to model-specifier.ts; re-exported so existing importers
// (e.g. model-override.test.ts) keep resolving it from core.
export { splitSpecifier } from "./model-specifier.js";

interface RegisteredAgent {
  adapter: AgentAdapter;
  kind: AgentKind;
  sourceRef: string;
  /**
   * True when this adapter was connected with a bearer token. Used by the
   * ORG-07 guard to block sharing token-protected agents.
   * Note: Fleet does not persist tokens (ADR-4). This flag only covers
   * agents connected in the current session; it is false for reconnections
   * via healthTick/#reconnectPersisted.
   */
  hasToken: boolean;
}

export interface GatewayCoreOptions {
  /** SQLite path, or ":memory:". */
  dbPath?: string;
  /**
   * Interval in ms between health checks for registered agents.
   * Default 15000. Pass a shorter value in tests to avoid waiting 15 s.
   */
  healthIntervalMs?: number;
  /**
   * Inject a custom OrgRegistry for tests. When provided, GitHubRegistry is not
   * used — the injected registry handles all org operations. Passed through to the
   * OrgCoordinator, which uses it for every OrgManager it instantiates.
   */
  orgRegistry?: OrgRegistry;
}

// `capWorkflowOutput` (K3 output cap) moved to managers/workflow-manager.ts;
// re-exported so existing importers (workflow-output-cap.test.ts) keep resolving it.
export { capWorkflowOutput } from "./managers/workflow-manager.js";

export class GatewayCore {
  readonly #state: GatewayState;
  readonly #agents = new Map<string, RegisteredAgent>();
  readonly #sessionManager: SessionManager;
  readonly #secrets = new SecretsStore();
  readonly #deployer = new FlueDeployer(this.#secrets);
  readonly #deployManager: DeployManager;
  /** Registered emit functions for server-pushed events (e.g. health monitor transitions). */
  readonly #emitters = new Set<Emit>();
  /** Last-broadcast online state per agentId — suppresses duplicate agent.updated events. */
  readonly #onlineCache = new Map<string, boolean>();
  #healthInterval: ReturnType<typeof setInterval> | null = null;
  #healthTickInFlight = false;
  readonly #workflowManager: WorkflowManager;
  readonly #orgCoordinator: OrgCoordinator;

  constructor(options: GatewayCoreOptions = {}) {
    this.#state = new GatewayState(options.dbPath ?? ":memory:");
    // K4: runs left 'running' by a previous process are unfinishable — fail them now.
    this.#state.reconcileOrphanedWorkflowRuns();
    this.#orgCoordinator = new OrgCoordinator({
      state: this.#state,
      deployer: this.#deployer,
      orgRegistryOverride: options.orgRegistry,
      host: this.#orgHost(),
    });
    this.#workflowManager = new WorkflowManager({
      state: this.#state,
      getAdapter: (agentId) => this.#agents.get(agentId)?.adapter,
    });
    this.#deployManager = new DeployManager({
      deployer: this.#deployer,
      state: this.#state,
      registerLiveAgent: (adapter, baseUrl, capabilities) => this.#registerLiveAgent(adapter, baseUrl, capabilities),
      summarize: (stored, online) => this.#summary(stored, online),
    });
    this.#sessionManager = new SessionManager({
      state: this.#state,
      getAdapter: (agentId) => this.#agents.get(agentId)?.adapter,
    });
    this.#startHealthMonitor(options.healthIntervalMs ?? 15_000);
    // Attempt to reconnect any agents that were persisted from a previous run.
    // Fire-and-forget — construction is synchronous; failures are swallowed and
    // the health loop will bring the agent online when it becomes reachable.
    void this.#reconnectPersisted();
    // Non-blocking org sync on boot (ORG-08). Failures must not prevent startup.
    void this.#orgCoordinator.syncOnBoot();
  }

  /** Dispatch a frontend request. Never throws — errors are emitted. */
  async handle(req: ClientRequest, emit: Emit): Promise<void> {
    try {
      switch (req.type) {
        case "agents.list":
          return this.#listAgents(emit);
        case "capabilities.list":
          return this.#listCapabilities(emit);
        case "agent.connectFlue":
          return await this.#connectFlue(req, emit);
        case "agent.deployFlue":
          return await this.#deployManager.deployFlue(req, emit);
        case "agent.redeploy":
          return await this.#deployManager.redeploy(req, emit);
        case "agent.stop":
          return await this.#stopAgent(req, emit);
        case "agent.delete":
          return await this.#deleteAgent(req, emit);
        case "secrets.set":
          this.#secrets.set(req.provider, req.apiKey);
          emit({ type: "secrets.status", providers: this.#secrets.list() });
          return;
        case "secrets.list":
          emit({ type: "secrets.status", providers: this.#secrets.list() });
          return;
        case "session.start":
          return await this.#sessionManager.start(req, emit);
        case "session.abort":
          return await this.#sessionManager.abort(req.sessionId, emit);
        case "sessions.list":
          return this.#sessionManager.list(req, emit);
        case "session.history":
          return this.#sessionManager.history(req, emit);
        case "config.set":
          return this.#setConfig(req, emit);
        case "deploy.preflight":
          return await this.#deployManager.preflight(req, emit);
        case "deploy.githubOwners":
          return await this.#deployManager.githubOwners(emit);
        case "deploy.lastLog":
          return this.#deployManager.getLastDeployLog(req, emit);
        case "deploy.lastFailedLog":
          return emit({ type: "deploy.lastFailedLog", failed: this.#state.getLastFailedDeploy() });
        case "usage.summary":
          return this.#usageSummary(req, emit);
        case "workflow.save":
          return this.#workflowManager.save(req, emit);
        case "workflow.list":
          return this.#workflowManager.list(emit);
        case "workflow.delete":
          return this.#workflowManager.delete(req, emit);
        case "workflow.run":
          return await this.#workflowManager.run(req, emit);
        case "workflow.abort":
          return this.#workflowManager.abort(req.runId);
        case "workflow.runs":
          return this.#workflowManager.runs(req, emit);
        // ── Org registry (G1) ────────────────────────────────────────────────
        case "org.create":
          return await this.#orgCoordinator.create(req, emit);
        case "org.join":
          return await this.#orgCoordinator.join(req, emit);
        case "org.leave":
          return await this.#orgCoordinator.leave(emit);
        case "org.sync":
          return await this.#orgCoordinator.sync(emit);
        case "org.share":
          return await this.#orgCoordinator.share(req, emit);
        case "org.unshare":
          return await this.#orgCoordinator.unshare(req, emit);
        case "org.members":
          return await this.#orgCoordinator.members(emit);
        case "org.status":
          return this.#orgCoordinator.status(emit);
        // ── Org shared memory (J4) ────────────────────────────────────────────
        case "orgMemory.deployServer":
          return await this.#orgCoordinator.deployEngramServer(req, emit);
        default: {
          const _exhaustive: never = req;
          void _exhaustive;
        }
      }
    } catch (err) {
      emit({ type: "error", message: (err as Error).message, requestType: (req as { type?: string }).type });
    }
  }

  /** Close every adapter, kill deployed agents, close the store. */
  async shutdown(): Promise<void> {
    // Clear the health interval first so no ticks race with teardown.
    if (this.#healthInterval !== null) {
      clearInterval(this.#healthInterval);
      this.#healthInterval = null;
    }
    // Abort any in-flight workflow runs so their agent calls stop.
    this.#workflowManager.abortAll();
    for (const reg of this.#agents.values()) {
      await reg.adapter.close().catch(() => {});
    }
    await this.#deployer.shutdown().catch(() => {});
    this.#agents.clear();
    this.#sessionManager.clear();
    this.#emitters.clear();
    this.#state.close();
  }

  // ── Emitter registry (server-pushed events) ────────────────────────────────

  /**
   * Register a connected client's emit function so the Core can push server-
   * initiated events (e.g. health monitor transitions). Returns an unsubscribe
   * function — call it when the client disconnects.
   */
  addEmitter(emit: Emit): () => void {
    this.#emitters.add(emit);
    return () => this.#emitters.delete(emit);
  }

  /**
   * Returns the Flue base URL for a registered (or persisted-offline) agent.
   * Useful for introspection and testing without reaching into private state.
   */
  getAgentSourceRef(agentId: string): string | null {
    return this.#state.getAgent(agentId)?.sourceRef ?? null;
  }

  #broadcast(event: ServerEvent): void {
    for (const emit of this.#emitters) emit(event);
  }

  // ── Agents ─────────────────────────────────────────────────────────────────

  #listAgents(emit: Emit): void {
    const agents = this.#state.listAgents().map((a) => this.#summary(a, this.#agents.has(a.id)));
    emit({ type: "agents", agents });
  }

  /**
   * Emit the fleet capability catalog (B2): every registered agent and its declared
   * capabilities (from its Agent Card). Reflects the live store, so it is naturally
   * up to date as agents are registered (capabilities persisted at deploy) or removed
   * (their row, and thus their capabilities, are gone). The Orchestrator (series D)
   * consults this to decide delegations; the UI shows what each agent can do.
   */
  #listCapabilities(emit: Emit): void {
    const agents = this.#state.listAgents().map((a) => ({
      agentId: a.id,
      agentName: a.name,
      capabilities: a.capabilities,
    }));
    emit({ type: "capabilities", agents });
  }

  /**
   * Connect to a Flue agent, upsert its agent row, and register the live adapter.
   * Shared internal path used by both manual `agent.connectFlue` and org sync.
   * Returns the stored agent row so callers can build summaries or emit events.
   */
  async #registerConnectedAgent(baseUrl: string, agentName: string, token?: string, instanceId?: string): Promise<StoredAgent> {
    // Reuse the persisted instanceId (J1) unless the caller explicitly provided one.
    const prior = this.#state.getAgent(agentName);
    const adapter = await createAdapter({
      kind: "flue", baseUrl, agentName, token,
      instanceId: instanceId ?? prior?.flueInstanceId ?? undefined,
    });
    const stored = this.#state.upsertAgent(adapter.info(), adapter.kind, baseUrl);
    const iid = sessionInstanceId(adapter);
    if (iid && stored.flueInstanceId !== iid) this.#state.setAgentFlueInstanceId(stored.id, iid);
    this.#agents.set(stored.id, { adapter, kind: adapter.kind, sourceRef: baseUrl, hasToken: !!token });
    return stored;
  }

  async #connectFlue(req: Extract<ClientRequest, { type: "agent.connectFlue" }>, emit: Emit): Promise<void> {
    const stored = await this.#registerConnectedAgent(req.baseUrl, req.agentName, req.token, req.instanceId);
    emit({ type: "agent.registered", agent: this.#summary(stored, true) });
  }

  /**
   * Register a freshly connected agent's live adapter in the central agent map
   * and persist its identity (J1 instanceId). Returns the StoredAgent so callers
   * (DeployManager) can build the registered summary and persist deploy state.
   * The `#agents` map and agent-summary logic still live here; a later #65 slice
   * may move them into a dedicated AgentRegistry.
   */
  #registerLiveAgent(adapter: AgentAdapter, baseUrl: string, capabilities: Capability[] = []): StoredAgent {
    const stored = this.#state.upsertAgent(adapter.info(), adapter.kind, baseUrl);
    // B2: persist the capabilities derived from the agent's Agent Card. Only on the
    // deploy path (a connect carries no card) — never overwrite a known set with [].
    if (capabilities.length > 0) this.#state.setAgentCapabilities(stored.id, capabilities);
    this.#agents.set(stored.id, { adapter, kind: adapter.kind, sourceRef: baseUrl, hasToken: false });
    // J1: a (re)deploy is a fresh lifecycle epoch — adopt the adapter's instanceId.
    const iid = sessionInstanceId(adapter);
    if (iid) this.#state.setAgentFlueInstanceId(stored.id, iid);
    return stored;
  }

  /**
   * Persist a config change and report whether it needs a redeploy to take
   * effect. Flue bakes the model at convert time, so a model specifier that
   * differs from what the agent currently runs only applies after a redeploy.
   */
  #setConfig(req: Extract<ClientRequest, { type: "config.set" }>, emit: Emit): void {
    // ORG-12 guard: org agents are connect-only — configuration is the owner's responsibility.
    if (this.#state.isOrgAgent(req.agentId)) {
      const orgRow = this.#state.getOrgAgent(req.agentId);
      emit({ type: "error", message: `Agent is managed by the org (shared by ${orgRow?.sharedBy ?? "org"}) — connect-only; configuration changes are not allowed`, requestType: req.type });
      return;
    }
    this.#state.setConfig(req.agentId, req.modelSpecifier, req.parameters ?? null);
    const stored = this.#state.getAgent(req.agentId);
    const current = stored ? this.#deployedSpecifier(req.agentId, stored.model) : "";
    const requiresRedeploy =
      !!req.modelSpecifier && req.modelSpecifier !== current && this.#state.hasDeploy(req.agentId);
    emit({ type: "config.updated", agentId: req.agentId, requiresRedeploy });
  }

  /** Aggregate usage per agent+model (optionally since an ISO timestamp) plus grand totals. */
  #usageSummary(req: Extract<ClientRequest, { type: "usage.summary" }>, emit: Emit): void {
    const since = req.since ?? null;
    const rows = this.#state.aggregateUsage(since);
    const priced = rows.filter((r) => r.costUsd !== null);
    emit({
      type: "usage.summary",
      since,
      rows,
      totals: {
        inputTokens: rows.reduce((a, r) => a + r.inputTokens, 0),
        outputTokens: rows.reduce((a, r) => a + r.outputTokens, 0),
        totalTokens: rows.reduce((a, r) => a + r.totalTokens, 0),
        costUsd: priced.length > 0 ? priced.reduce((a, r) => a + (r.costUsd ?? 0), 0) : null,
        runs: rows.reduce((a, r) => a + r.runs, 0),
        unpricedRuns: rows.reduce((a, r) => a + r.unpricedRuns, 0),
      },
    });
  }

  // ── Stop / Delete ─────────────────────────────────────────────────────────

  /**
   * Shared teardown: stops local infra (container or process), closes the live
   * adapter, and aborts all in-flight sessions for the agent.
   * Does NOT emit any events — callers decide what to broadcast after this.
   * Safe to call when the agent is already offline (no adapter in #agents).
   */
  async #teardownAgent(agentId: string): Promise<void> {
    const stored = this.#state.getAgent(agentId);
    const deployParams = this.#state.getDeploy(agentId);

    // Stop runtime infra if applicable. For dokploy this also stops the remote
    // application (best-effort) — a failure to reach the Dokploy API must never
    // block the local teardown.
    if (deployParams && stored) {
      const t = deployParams.target;
      if (t === "docker-local" || t === "local-process" || t === "dokploy") {
        await this.#deployer.stopDeployment(stored.name, t as DeployTarget).catch((err) => {
          console.error(`[gateway-core] remote stop failed for "${stored.name}" (${t}):`, err);
        });
      }
      // NOTE: For fly, cloudflare and github, only the local adapter is
      // disconnected below — remote infrastructure teardown must be done
      // manually (e.g. via flyctl/wrangler/PaaS UI).
    }

    // Close the live adapter and remove it from the active registry.
    const reg = this.#agents.get(agentId);
    if (reg) {
      await reg.adapter.close().catch(() => {});
      this.#agents.delete(agentId);
    }

    // Abort every in-flight session for this agent.
    await this.#sessionManager.abortAgentSessions(agentId);
  }

  /** Stop an agent's runtime, keep its registration (it can be redeployed). */
  async #stopAgent(req: Extract<ClientRequest, { type: "agent.stop" }>, emit: Emit): Promise<void> {
    // ORG-12 guard: org agents are connect-only — stopping is the owner's responsibility.
    if (this.#state.isOrgAgent(req.agentId)) {
      const orgRow = this.#state.getOrgAgent(req.agentId);
      emit({ type: "error", message: `Agent is managed by the org (shared by ${orgRow?.sharedBy ?? "org"}) — connect-only; use org.leave to remove org agents`, requestType: req.type });
      return;
    }
    const stored = this.#state.getAgent(req.agentId);
    if (!stored) {
      emit({ type: "error", message: `Agent "${req.agentId}" not found`, requestType: req.type });
      return;
    }
    await this.#teardownAgent(req.agentId);
    emit({ type: "agent.updated", agent: this.#summary(stored, false) });
  }

  /** Stop an agent's runtime and permanently delete its registration + deploy params. */
  async #deleteAgent(req: Extract<ClientRequest, { type: "agent.delete" }>, emit: Emit): Promise<void> {
    // ORG-12 guard: org agents are connect-only — deletion is the owner's responsibility.
    if (this.#state.isOrgAgent(req.agentId)) {
      const orgRow = this.#state.getOrgAgent(req.agentId);
      emit({ type: "error", message: `Agent is managed by the org (shared by ${orgRow?.sharedBy ?? "org"}) — connect-only; use org.leave to remove org agents`, requestType: req.type });
      return;
    }
    const stored = this.#state.getAgent(req.agentId);
    if (!stored) {
      emit({ type: "error", message: `Agent "${req.agentId}" not found`, requestType: req.type });
      return;
    }
    await this.#teardownAgent(req.agentId);
    // Build the summary while the DB row still exists (cascade removes deploys too).
    const summary = this.#summary(stored, false);
    this.#state.deleteAgent(req.agentId);
    emit({ type: "agent.updated", agent: summary });
    emit({ type: "agent.removed", agentId: req.agentId });
  }

  /**
   * The model specifier the agent currently RUNS — derived from its deploy
   * params (Flue bakes the model at convert time, so the deployed provider/model
   * is the source of truth), falling back to the agent's own default. Empty
   * string when nothing is known (e.g. a connected-by-URL agent with no deploy).
   */
  #deployedSpecifier(agentId: string, fallback: string): string {
    const d = this.#state.getDeploy(agentId);
    if (d?.provider && d.model) return `${d.provider}/${d.model}`;
    return fallback;
  }

  #summary(a: StoredAgent, online: boolean): AgentSummary {
    // Derive org provenance — symmetric with getDeploy/hasDeploy for local agents (ADR-1/ADR-2).
    const orgRow = this.#state.getOrgAgent(a.id);
    return {
      id: a.id,
      name: a.name,
      version: a.version,
      description: a.description,
      kind: a.kind,
      online,
      model: this.#deployedSpecifier(a.id, a.model),
      url: a.sourceRef,
      // Org agents carry their target in org_agents; local agents read from deploys.
      target: orgRow?.target ?? this.#state.getDeploy(a.id)?.target ?? null,
      redeployable: this.#state.hasDeploy(a.id),
      origin: orgRow ? "org" : "local",
      sharedBy: orgRow?.sharedBy ?? null,
    };
  }

  // ── Health monitor ─────────────────────────────────────────────────────────

  /**
   * Start the periodic health loop. The timer is unref'd so it never keeps the
   * process alive by itself — `shutdown()` also clears it explicitly.
   */
  #startHealthMonitor(intervalMs: number): void {
    const handle = setInterval(() => void this.#healthTick(), intervalMs);
    handle.unref();
    this.#healthInterval = handle;
  }

  /**
   * One health-check iteration across all persisted agents that have a sourceRef.
   * Detects online→offline and offline→online transitions; emits `agent.updated`
   * only on a state change (anti-spam). Protected by an in-flight guard to prevent
   * overlapping ticks when the interval fires faster than the checks complete.
   */
  async #healthTick(): Promise<void> {
    if (this.#healthTickInFlight) return;
    this.#healthTickInFlight = true;
    try {
      for (const stored of this.#state.listAgents()) {
        if (!stored.sourceRef) continue;

        const isOnline = this.#agents.has(stored.id);
        const reachable = await pingAgent(stored.sourceRef);

        if (isOnline && !reachable) {
          // online → offline transition
          const reg = this.#agents.get(stored.id);
          if (reg) {
            await reg.adapter.close().catch(() => {});
            this.#agents.delete(stored.id);
          }
          const wasOnline = this.#onlineCache.get(stored.id) ?? true;
          this.#onlineCache.set(stored.id, false);
          if (wasOnline) {
            this.#broadcast({ type: "agent.updated", agent: this.#summary(stored, false) });
          }
        } else if (!isOnline && reachable) {
          // offline → online: attempt to reconnect the adapter.
          // Re-check #agents in case reconnect-on-boot completed while we were pinging.
          if (!this.#agents.has(stored.id)) {
            try {
              const adapter = await createAdapterForStored(stored);
              if (this.#agents.has(stored.id)) {
                // Reconnect-on-boot won the race while we were connecting — keep
                // its adapter and discard ours so neither leaks.
                await adapter.close().catch(() => {});
                continue;
              }
              this.#agents.set(stored.id, { adapter, kind: adapter.kind, sourceRef: stored.sourceRef, hasToken: false });
              const iid = sessionInstanceId(adapter);
              if (iid && !stored.flueInstanceId) this.#state.setAgentFlueInstanceId(stored.id, iid);
              const wasOnline = this.#onlineCache.get(stored.id) ?? false;
              this.#onlineCache.set(stored.id, true);
              if (!wasOnline) {
                this.#broadcast({ type: "agent.updated", agent: this.#summary(stored, true) });
              }
            } catch {
              // Connect failed despite ping succeeding — leave offline, retry next tick.
            }
          }
        } else {
          // State unchanged — keep cache in sync so anti-spam works correctly on future transitions.
          this.#onlineCache.set(stored.id, isOnline);
        }
      }
    } finally {
      this.#healthTickInFlight = false;
    }
  }

  /**
   * The seam the OrgCoordinator uses to drive the central agent registry — the
   * `#agents` map, `#onlineCache`, the SessionManager, and agent summaries. These
   * are the same central structures the Core owns; a future AgentRegistry would
   * become this host.
   */
  #orgHost(): OrgHost {
    return {
      hasLiveAgent: (agentId) => this.#agents.has(agentId),
      registerOrgAgent: (stored, adapter) => {
        // No token for org agents (G1 — shared entries never carry tokens, ADR-4/rule #8).
        this.#agents.set(stored.id, { adapter, kind: adapter.kind, sourceRef: stored.sourceRef, hasToken: false });
        const iid = sessionInstanceId(adapter);
        if (iid && !stored.flueInstanceId) this.#state.setAgentFlueInstanceId(stored.id, iid);
      },
      teardownOrgAgent: async (agentId) => {
        const reg = this.#agents.get(agentId);
        if (reg) {
          await reg.adapter.close().catch(() => {});
          this.#agents.delete(agentId);
          this.#onlineCache.delete(agentId);
        }
        // Drain sessions (mirrors #teardownAgent — abort each active session and
        // eagerly remove it from the session map so no ghost sessions remain).
        await this.#sessionManager.abortAgentSessions(agentId);
      },
      agentHasToken: (agentId) => this.#agents.get(agentId)?.hasToken ?? false,
      broadcast: (event) => this.#broadcast(event),
      agentsListEvent: () => ({
        type: "agents",
        agents: this.#state.listAgents().map((a) => this.#summary(a, this.#agents.has(a.id))),
      }),
    };
  }

  /**
   * On construction, attempt to reconnect each agent that was persisted from a
   * prior run. Called once, fire-and-forget. Agents that are unreachable are left
   * offline; the health loop will bring them online when they return.
   */
  async #reconnectPersisted(): Promise<void> {
    for (const stored of this.#state.listAgents()) {
      if (!stored.sourceRef || this.#agents.has(stored.id)) continue;
      // Mark as offline by default; updated below if the connect succeeds.
      if (!this.#onlineCache.has(stored.id)) {
        this.#onlineCache.set(stored.id, false);
      }
      try {
        const adapter = await createAdapterForStored(stored);
        if (this.#agents.has(stored.id)) {
          // A health tick connected this agent while we were awaiting — keep
          // its adapter and discard ours so neither leaks.
          await adapter.close().catch(() => {});
          continue;
        }
        this.#agents.set(stored.id, { adapter, kind: adapter.kind, sourceRef: stored.sourceRef, hasToken: false });
        const iid = sessionInstanceId(adapter);
        if (iid && !stored.flueInstanceId) this.#state.setAgentFlueInstanceId(stored.id, iid);
        this.#onlineCache.set(stored.id, true);
        // No broadcast here — there are typically no connected clients at boot time.
        // The first agents.list response will reflect the correct online state.
      } catch {
        // Agent is unreachable — the health loop will reconnect it when it returns.
      }
    }
  }
}
