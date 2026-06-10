/**
 * GatewayCore — the brain. Connects to Flue agents over Flue's HTTP+WebSocket
 * API, maps their events into the neutral run model, and exposes high-level
 * operations the WebSocket server relays to the frontend.
 */

import { randomUUID } from "node:crypto";
import { FlueAdapter } from "./adapters/flue.js";
import type { AgentAdapter, AgentKind, RunHandle } from "./adapters/agent-adapter.js";
import { FlueDeployer, pingAgent, type DeployTarget } from "./deploy/flue-deployer.js";
import { SecretsStore } from "./secrets/store.js";
import { computeCostUsd } from "./pricing/pricing.js";
import { GatewayState, type StoredAgent, type SessionSummary } from "./state/index.js";
import type { RunOptions, RunSink } from "./neutral.js";
import { Orchestrator, type AgentRunner } from "./orchestration/index.js";
import type { AgentSummary, ClientRequest, ServerEvent } from "./api.js";

export type Emit = (event: ServerEvent) => void;

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
  /** Active workflow runs → their abort controller (for workflow.abort). */
  readonly #workflowRuns = new Map<string, AbortController>();
  readonly #orchestrator: Orchestrator;

  constructor(options: GatewayCoreOptions = {}) {
    this.#state = new GatewayState(options.dbPath ?? ":memory:");
    this.#orchestrator = new Orchestrator(this.#agentRunner());
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
          return this.#setConfig(req, emit);
        case "deploy.preflight":
          return await this.#deployPreflight(req, emit);
        case "deploy.lastLog":
          return this.#getLastDeployLog(req, emit);
        case "workflow.save":
          this.#state.saveWorkflow(req.workflow);
          emit({ type: "workflows", workflows: this.#state.listWorkflows() });
          return;
        case "workflow.list":
          emit({ type: "workflows", workflows: this.#state.listWorkflows() });
          return;
        case "workflow.delete":
          this.#state.deleteWorkflow(req.workflowId);
          emit({ type: "workflows", workflows: this.#state.listWorkflows() });
          return;
        case "workflow.run":
          return await this.#runWorkflow(req, emit);
        case "workflow.abort":
          this.#workflowRuns.get(req.runId)?.abort();
          return;
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
    for (const controller of this.#workflowRuns.values()) controller.abort();
    this.#workflowRuns.clear();
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

  /**
   * Persist a config change and report whether it needs a redeploy to take
   * effect. Flue bakes the model at convert time, so a model specifier that
   * differs from what the agent currently runs only applies after a redeploy.
   */
  #setConfig(req: Extract<ClientRequest, { type: "config.set" }>, emit: Emit): void {
    this.#state.setConfig(req.agentId, req.modelSpecifier, req.parameters ?? null);
    const stored = this.#state.getAgent(req.agentId);
    const current = stored ? this.#deployedSpecifier(req.agentId, stored.model) : "";
    const requiresRedeploy =
      !!req.modelSpecifier && req.modelSpecifier !== current && this.#state.hasDeploy(req.agentId);
    emit({ type: "config.updated", agentId: req.agentId, requiresRedeploy });
  }

  /**
   * Redeploy an agent using the params persisted from its original deploy,
   * overlaying any pending model override from its config (the honest path for
   * applying a model change — Flue fixes the model at convert time).
   */
  async #redeploy(req: Extract<ClientRequest, { type: "agent.redeploy" }>, emit: Emit): Promise<void> {
    const params = this.#state.getDeploy(req.agentId);
    if (!params) {
      emit({ type: "deploy.error", message: `Agent "${req.agentId}" has no stored deploy to repeat.` });
      return;
    }
    // Overlay the config model override (provider/model) when set, so a saved
    // model change is what actually gets rebuilt and re-persisted by #runDeploy.
    const cfg = this.#state.getConfig(req.agentId);
    const override = splitSpecifier(cfg?.modelSpecifier ?? null);
    const effective = override ? { ...params, provider: override.provider, model: override.model } : params;
    // Pass the pre-known agentId so the log can be persisted even on error.
    await this.#runDeploy(effective, emit, req.agentId);
  }

  /**
   * Shared convert+deploy+connect flow for both first deploy and redeploy.
   *
   * @param knownAgentId  The agentId we're redeploying (if known). Enables log
   *   persistence on error. For a first deploy the agentId only becomes known
   *   after the agent registers successfully, so error-path log persistence is
   *   skipped in that case — acceptable in v1.
   */
  async #runDeploy(
    params: { sourceDir: string; provider?: string | null; model?: string | null; target: string },
    emit: Emit,
    knownAgentId?: string,
  ): Promise<void> {
    const logBuffer: string[] = [];
    try {
      const result = await this.#deployer.deploy(
        {
          sourceDir: params.sourceDir,
          provider: params.provider ?? undefined,
          model: params.model ?? undefined,
          target: params.target as DeployTarget,
        },
        (step, detail) => emit({ type: "deploy.progress", step, detail }),
        (lines) => {
          logBuffer.push(...lines);
          emit({ type: "deploy.log", lines });
        },
      );
      // Surface any source features that did not convert (hooks, MCP stdio, …).
      // Informational — never blocks the deploy.
      if (result.unmapped.length > 0) {
        emit({ type: "deploy.unmapped", items: result.unmapped });
      }
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
      // Persist the accumulated log (overwrites any previous log — one per agent in v1).
      this.#state.setDeployLog(stored.id, logBuffer.join("\n"));
      emit({ type: "agent.registered", agent: this.#summary(stored, true) });
    } catch (err) {
      // Persist the partial log when redeploying a known agent (agentId was passed in).
      // For a first deploy that fails before agent registration there is no agentId to key
      // the log by — the log is intentionally dropped in that case.
      if (knownAgentId && logBuffer.length > 0) {
        this.#state.setDeployLog(knownAgentId, logBuffer.join("\n"));
      }
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

  /** Return the last deploy log for an agent, or null if none has been stored yet. */
  #getLastDeployLog(req: Extract<ClientRequest, { type: "deploy.lastLog" }>, emit: Emit): void {
    const log = this.#state.getDeployLog(req.agentId);
    emit({ type: "deploy.lastLog", agentId: req.agentId, log });
  }

  // ── Orchestration (workflows) ───────────────────────────────────────────────

  /**
   * The AgentRunner the Orchestrator uses to run one prompt against one agent.
   * Accumulates the assistant's streamed text (Flue emits message.delta) and
   * resolves with the final text. Never touches the engine's internals — this is
   * the injection seam that keeps the engine adapter-agnostic.
   */
  #agentRunner(): AgentRunner {
    return {
      run: (agentId, prompt, signal) => {
        const reg = this.#agents.get(agentId);
        if (!reg) return Promise.reject(new Error(`agent "${agentId}" is not connected`));
        return new Promise<string>((resolve, reject) => {
          let text = "";
          const sink: RunSink = {
            onEvent: (e) => {
              if (e.type === "message.delta" && e.role === "assistant") text += e.content;
              else if (e.type === "message.completed" && e.role === "assistant") text = e.content;
            },
            onDone: (status) => (status === "aborted" ? reject(new Error("aborted")) : resolve(text)),
            onError: (_code, message) => reject(new Error(message)),
          };
          const handle = reg.adapter.run({ messages: [{ role: "user", content: prompt }] }, {}, sink);
          if (signal.aborted) void handle.abort();
          else signal.addEventListener("abort", () => void handle.abort(), { once: true });
        });
      },
    };
  }

  async #runWorkflow(req: Extract<ClientRequest, { type: "workflow.run" }>, emit: Emit): Promise<void> {
    const wf = this.#state.getWorkflow(req.workflowId);
    if (!wf) {
      emit({ type: "error", message: `workflow "${req.workflowId}" not found`, requestType: req.type });
      return;
    }
    // Every agent node must reference a currently-connected agent (the engine
    // validates structure; agent availability is the Core's call).
    const missing = [
      ...new Set(
        wf.nodes
          .filter((n) => n.kind === "agent" && (!n.agentId || !this.#agents.has(n.agentId)))
          .map((n) => n.agentId ?? n.id),
      ),
    ];
    if (missing.length > 0) {
      emit({ type: "error", message: `workflow needs these agents online: ${missing.join(", ")}`, requestType: req.type });
      return;
    }

    const runId = `wfr_${randomUUID()}`;
    const controller = new AbortController();
    this.#workflowRuns.set(runId, controller);
    this.#state.createWorkflowRun(runId, req.workflowId, req.inputs);
    emit({ type: "workflow.run.started", runId, workflowId: req.workflowId });

    const result = await this.#orchestrator.run(
      wf,
      req.inputs,
      {
        onNodeStatus: (nodeId, status, info) =>
          emit({ type: "workflow.node.status", runId, nodeId, status, output: info?.output, error: info?.error }),
      },
      controller.signal,
    );

    this.#state.finishWorkflowRun(runId, result.status, result.outputs);
    this.#workflowRuns.delete(runId);
    emit({ type: "workflow.run.done", runId, status: result.status, outputs: result.outputs });
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

    // No per-run options in v1: the model is fixed at convert time (see RunOptions).
    const options: RunOptions = {};
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
    return {
      id: a.id,
      name: a.name,
      version: a.version,
      description: a.description,
      kind: a.kind,
      online,
      model: this.#deployedSpecifier(a.id, a.model),
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
              if (this.#agents.has(stored.id)) {
                // Reconnect-on-boot won the race while we were connecting — keep
                // its adapter and discard ours so neither leaks.
                await adapter.close().catch(() => {});
                continue;
              }
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
        if (this.#agents.has(stored.id)) {
          // A health tick connected this agent while we were awaiting — keep
          // its adapter and discard ours so neither leaks.
          await adapter.close().catch(() => {});
          continue;
        }
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
