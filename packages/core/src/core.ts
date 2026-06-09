/**
 * GatewayCore — the brain. Connects to Flue agents over Flue's HTTP+WebSocket
 * API, maps their events into the neutral run model, and exposes high-level
 * operations the WebSocket server relays to the frontend.
 */

import { FlueAdapter } from "./adapters/flue.js";
import type { AgentAdapter, AgentKind, RunHandle } from "./adapters/agent-adapter.js";
import { FlueDeployer, pingAgent, type DeployTarget } from "./deploy/flue-deployer.js";
import { SecretsStore } from "./secrets/store.js";
import { computeCostUsd } from "./pricing/pricing.js";
import { GatewayState, type StoredAgent, type SessionSummary } from "./state/index.js";
import type { ModelOverride, RunOptions, RunSink } from "./neutral.js";
import type { AgentSummary, ClientRequest, ServerEvent } from "./api.js";

export type Emit = (event: ServerEvent) => void;

interface RegisteredAgent {
  adapter: AgentAdapter;
  kind: AgentKind;
  sourceRef: string;
}

export interface GatewayCoreOptions {
  /** SQLite path, or ":memory:". */
  dbPath?: string;
  /**
   * Interval in ms between health checks for registered agents.
   * Default 15000. Pass a shorter value in tests to avoid waiting 15 s.
   */
  healthIntervalMs?: number;
}

export class GatewayCore {
  readonly #state: GatewayState;
  readonly #agents = new Map<string, RegisteredAgent>();
  readonly #sessions = new Map<string, RunHandle>();
  /** Reverse index: agentId → Set of active sessionIds (for bulk-abort on stop/delete). */
  readonly #agentSessions = new Map<string, Set<string>>();
  readonly #secrets = new SecretsStore();
  readonly #deployer = new FlueDeployer(this.#secrets);
  /** Registered emit functions for server-pushed events (e.g. health monitor transitions). */
  readonly #emitters = new Set<Emit>();
  /** Last-broadcast online state per agentId — suppresses duplicate agent.updated events. */
  readonly #onlineCache = new Map<string, boolean>();
  #healthInterval: ReturnType<typeof setInterval> | null = null;
  #healthTickInFlight = false;

  constructor(options: GatewayCoreOptions = {}) {
    this.#state = new GatewayState(options.dbPath ?? ":memory:");
    this.#startHealthMonitor(options.healthIntervalMs ?? 15_000);
    // Attempt to reconnect any agents that were persisted from a previous run.
    // Fire-and-forget — construction is synchronous; failures are swallowed and
    // the health loop will bring the agent online when it becomes reachable.
    void this.#reconnectPersisted();
  }

  /** Dispatch a frontend request. Never throws — errors are emitted. */
  async handle(req: ClientRequest, emit: Emit): Promise<void> {
    try {
      switch (req.type) {
        case "agents.list":
          return this.#listAgents(emit);
        case "agent.connectFlue":
          return await this.#connectFlue(req, emit);
        case "agent.deployFlue":
          return await this.#deployFlue(req, emit);
        case "agent.redeploy":
          return await this.#redeploy(req, emit);
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
          return await this.#startSession(req, emit);
        case "session.abort":
          return await this.#abortSession(req.sessionId, emit);
        case "sessions.list":
          return this.#listSessions(req, emit);
        case "session.history":
          return this.#getSessionHistory(req, emit);
        case "config.set":
          this.#state.setConfig(req.agentId, req.modelSpecifier, req.parameters ?? null);
          emit({ type: "config.updated", agentId: req.agentId });
          return;
        case "deploy.preflight":
          return await this.#deployPreflight(req, emit);
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
    for (const reg of this.#agents.values()) {
      await reg.adapter.close().catch(() => {});
    }
    await this.#deployer.shutdown().catch(() => {});
    this.#agents.clear();
    this.#agentSessions.clear();
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

  async #connectFlue(req: Extract<ClientRequest, { type: "agent.connectFlue" }>, emit: Emit): Promise<void> {
    const adapter = await FlueAdapter.connect({
      baseUrl: req.baseUrl,
      agentName: req.agentName,
      instanceId: req.instanceId,
      token: req.token,
    });
    const stored = this.#state.upsertAgent(adapter.info(), "flue", req.baseUrl);
    this.#agents.set(stored.id, { adapter, kind: "flue", sourceRef: req.baseUrl });
    emit({ type: "agent.registered", agent: this.#summary(stored, true) });
  }

  async #deployFlue(req: Extract<ClientRequest, { type: "agent.deployFlue" }>, emit: Emit): Promise<void> {
    await this.#runDeploy(
      { sourceDir: req.sourceDir, provider: req.provider, model: req.model, target: req.target ?? "docker-local" },
      emit,
    );
  }

  /** Redeploy an agent using the params persisted from its original deploy. */
  async #redeploy(req: Extract<ClientRequest, { type: "agent.redeploy" }>, emit: Emit): Promise<void> {
    const params = this.#state.getDeploy(req.agentId);
    if (!params) {
      emit({ type: "deploy.error", message: `Agent "${req.agentId}" has no stored deploy to repeat.` });
      return;
    }
    await this.#runDeploy(params, emit);
  }

  /** Shared convert+deploy+connect flow for both first deploy and redeploy. */
  async #runDeploy(
    params: { sourceDir: string; provider?: string | null; model?: string | null; target: string },
    emit: Emit,
  ): Promise<void> {
    try {
      const result = await this.#deployer.deploy(
        {
          sourceDir: params.sourceDir,
          provider: params.provider ?? undefined,
          model: params.model ?? undefined,
          target: params.target as DeployTarget,
        },
        (step, detail) => emit({ type: "deploy.progress", step, detail }),
        (lines) => emit({ type: "deploy.log", lines }),
      );
      // `github` yields an artifact (a published repo), not a running agent.
      if (result.kind === "artifact") {
        emit({ type: "deploy.artifact", target: result.target, url: result.url, message: result.message });
        return;
      }
      const stored = this.#state.upsertAgent(result.adapter.info(), "flue", result.baseUrl);
      this.#agents.set(stored.id, { adapter: result.adapter, kind: "flue", sourceRef: result.baseUrl });
      // Persist the inputs so this agent can be redeployed in one click later.
      this.#state.setDeploy(stored.id, {
        sourceDir: params.sourceDir,
        provider: params.provider ?? null,
        model: params.model ?? null,
        target: params.target,
      });
      emit({ type: "agent.registered", agent: this.#summary(stored, true) });
    } catch (err) {
      emit({ type: "deploy.error", message: (err as Error).message });
    }
  }

  /** Run preflight checks and emit a deploy.preflight event with the results. */
  async #deployPreflight(req: Extract<ClientRequest, { type: "deploy.preflight" }>, emit: Emit): Promise<void> {
    const checks = await this.#deployer.preflight({
      provider: req.provider,
      model: req.model,
      target: req.target as DeployTarget,
    });
    emit({ type: "deploy.preflight", checks });
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

    // Stop local runtime infra if applicable.
    if (deployParams && stored) {
      const t = deployParams.target;
      if (t === "docker-local" || t === "local-process") {
        this.#deployer.stopDeployment(stored.name, t as DeployTarget);
      }
      // NOTE: For remote targets (fly, cloudflare, github) in v1, only the local
      // adapter is disconnected below — remote infrastructure teardown is out of
      // scope for v1 and must be done manually (e.g. via flyctl/wrangler/PaaS UI).
    }

    // Close the live adapter and remove it from the active registry.
    const reg = this.#agents.get(agentId);
    if (reg) {
      await reg.adapter.close().catch(() => {});
      this.#agents.delete(agentId);
    }

    // Abort every in-flight session for this agent.
    const sessionIds = [...(this.#agentSessions.get(agentId) ?? [])];
    for (const sessionId of sessionIds) {
      const handle = this.#sessions.get(sessionId);
      if (handle) await handle.abort().catch(() => {});
    }
    this.#agentSessions.delete(agentId);
  }

  /** Stop an agent's runtime, keep its registration (it can be redeployed). */
  async #stopAgent(req: Extract<ClientRequest, { type: "agent.stop" }>, emit: Emit): Promise<void> {
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

  // ── Sessions ───────────────────────────────────────────────────────────────

  async #startSession(req: Extract<ClientRequest, { type: "session.start" }>, emit: Emit): Promise<void> {
    const reg = this.#agents.get(req.agentId);
    if (!reg) {
      emit({ type: "error", message: `agent "${req.agentId}" is not connected`, requestType: req.type });
      return;
    }

    const sessionId = this.#state.createSession(req.agentId, req.message);
    emit({ type: "session.started", sessionId, agentId: req.agentId });

    const options: RunOptions = { model: this.#resolveModel(req.agentId, req.modelOverride) };
    let seq = 0;

    const sink: RunSink = {
      onEvent: (event) => {
        const currentSeq = seq++;
        this.#state.appendSessionEvent(sessionId, currentSeq, JSON.stringify(event));
        emit({ type: "session.event", sessionId, seq: currentSeq, event });
      },
      onUsage: (usage) => emit({ type: "session.usage", sessionId, usage, costUsd: computeCostUsd(usage) }),
      onDone: (status, usage) => {
        const costUsd = usage ? computeCostUsd(usage) : null;
        if (usage) this.#state.recordUsage(sessionId, null, usage, costUsd);
        this.#state.endSession(sessionId, status === "aborted" ? "aborted" : "completed");
        emit({ type: "session.done", sessionId, status, usage: usage ?? null, costUsd });
        this.#sessions.delete(sessionId);
        this.#agentSessions.get(req.agentId)?.delete(sessionId);
      },
      onError: (code, message) => {
        this.#state.endSession(sessionId, "error");
        emit({ type: "session.error", sessionId, error: { code, message } });
        this.#sessions.delete(sessionId);
        this.#agentSessions.get(req.agentId)?.delete(sessionId);
      },
    };

    const handle = reg.adapter.run({ messages: [{ role: "user", content: req.message }] }, options, sink);
    this.#sessions.set(sessionId, handle);
    // Register under the reverse agent→sessions index for bulk-abort on stop/delete.
    if (!this.#agentSessions.has(req.agentId)) this.#agentSessions.set(req.agentId, new Set());
    this.#agentSessions.get(req.agentId)!.add(sessionId);
  }

  async #abortSession(sessionId: string, emit: Emit): Promise<void> {
    const handle = this.#sessions.get(sessionId);
    if (!handle) {
      emit({ type: "error", message: `no active session "${sessionId}"`, requestType: "session.abort" });
      return;
    }
    await handle.abort();
  }

  #listSessions(req: Extract<ClientRequest, { type: "sessions.list" }>, emit: Emit): void {
    const sessions: SessionSummary[] = this.#state.listSessions(req.agentId);
    emit({ type: "sessions", agentId: req.agentId, sessions });
  }

  #getSessionHistory(req: Extract<ClientRequest, { type: "session.history" }>, emit: Emit): void {
    const events = this.#state.getSessionEvents(req.sessionId);
    const stored = this.#state.getSessionUsage(req.sessionId);
    emit({
      type: "session.history",
      sessionId: req.sessionId,
      events,
      usage: stored?.usage ?? null,
      costUsd: stored?.costUsd ?? null,
    });
  }

  #resolveModel(agentId: string, override?: ModelOverride): ModelOverride | undefined {
    if (override) return override;
    const cfg = this.#state.getConfig(agentId);
    if (cfg?.modelSpecifier) {
      return { specifier: cfg.modelSpecifier, parameters: cfg.parameters ?? undefined };
    }
    return undefined;
  }

  #summary(a: StoredAgent, online: boolean): AgentSummary {
    return {
      id: a.id,
      name: a.name,
      version: a.version,
      description: a.description,
      kind: a.kind,
      online,
      model: a.model,
      redeployable: this.#state.hasDeploy(a.id),
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
              const adapter = await FlueAdapter.connect({ baseUrl: stored.sourceRef, agentName: stored.name });
              this.#agents.set(stored.id, { adapter, kind: "flue", sourceRef: stored.sourceRef });
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
        const adapter = await FlueAdapter.connect({ baseUrl: stored.sourceRef, agentName: stored.name });
        this.#agents.set(stored.id, { adapter, kind: "flue", sourceRef: stored.sourceRef });
        this.#onlineCache.set(stored.id, true);
        // No broadcast here — there are typically no connected clients at boot time.
        // The first agents.list response will reflect the correct online state.
      } catch {
        // Agent is unreachable — the health loop will reconnect it when it returns.
      }
    }
  }
}
