/**
 * GatewayCore — the brain. Connects to Flue agents over Flue's HTTP+WebSocket
 * API, maps their events into the neutral run model, and exposes high-level
 * operations the WebSocket server relays to the frontend.
 */

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { FlueAdapter } from "./adapters/flue.js";
import type { AgentAdapter, AgentKind, RunHandle } from "./adapters/agent-adapter.js";
import { FlueDeployer, pingAgent, type DeployTarget } from "./deploy/flue-deployer.js";
import { SecretsStore } from "./secrets/store.js";
import { computeCostUsd } from "./pricing/pricing.js";
import { GatewayState, type StoredAgent, type SessionSummary } from "./state/index.js";
import type { RunOptions, RunSink } from "./neutral.js";
import { Orchestrator, type AgentRunner } from "./orchestration/index.js";
import type { AgentSummary, ClientRequest, ServerEvent } from "./api.js";
import { OrgManager, ROUTABLE_TARGETS } from "./org/org-manager.js";
import { GitHubRegistry } from "./org/github-registry.js";
import { OrgStore } from "./org/org-store.js";
import { OrgError } from "./org/registry.js";
import type { OrgRegistry, SharedAgentEntry } from "./org/registry.js";

export type Emit = (event: ServerEvent) => void;

/**
 * Extract a human-readable error message from an error, preferring OrgError
 * messages (which are pre-formatted for the user) over generic Error.message.
 */
function orgErrorMessage(err: unknown): string {
  if (err instanceof OrgError) return err.message;
  return (err as Error)?.message ?? "Unknown org error";
}

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
   * Inject a custom OrgRegistry for tests. When provided, GitHubRegistry is
   * not used — the injected registry handles all org operations. The injected
   * registry is used for every OrgManager instantiation within this Core.
   */
  orgRegistry?: OrgRegistry;
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
  /** K6: one active run per workflow — workflowId → runId of the run in flight. */
  readonly #activeWorkflowRuns = new Map<string, string>();
  readonly #orchestrator: Orchestrator;
  // ── Org registry (G1) ─────────────────────────────────────────────────────
  readonly #orgStore: OrgStore;
  #orgManager: OrgManager | null = null;
  /** Injected OrgRegistry for tests (overrides GitHubRegistry). */
  readonly #orgRegistryOverride: OrgRegistry | undefined;

  constructor(options: GatewayCoreOptions = {}) {
    this.#state = new GatewayState(options.dbPath ?? ":memory:");
    // K4: runs left 'running' by a previous process are unfinishable — fail them now.
    this.#state.reconcileOrphanedWorkflowRuns();
    this.#orgStore = new OrgStore();
    this.#orgRegistryOverride = options.orgRegistry;
    this.#orchestrator = new Orchestrator(this.#agentRunner(), {
      nodeTimeoutMs: Number(process.env.GATEWAY_WORKFLOW_NODE_TIMEOUT_MS ?? 600_000),
    });
    this.#startHealthMonitor(options.healthIntervalMs ?? 15_000);
    // Attempt to reconnect any agents that were persisted from a previous run.
    // Fire-and-forget — construction is synchronous; failures are swallowed and
    // the health loop will bring the agent online when it becomes reachable.
    void this.#reconnectPersisted();
    // Non-blocking org sync on boot (ORG-08). Failures must not prevent startup.
    void this.#orgSyncOnBoot();
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
        case "deploy.githubOwners":
          return await this.#githubOwners(emit);
        case "deploy.lastLog":
          return this.#getLastDeployLog(req, emit);
        case "deploy.lastFailedLog":
          return emit({ type: "deploy.lastFailedLog", failed: this.#state.getLastFailedDeploy() });
        case "usage.summary":
          return this.#usageSummary(req, emit);
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
        // ── Org registry (G1) ────────────────────────────────────────────────
        case "org.create":
          return await this.#orgCreate(req, emit);
        case "org.join":
          return await this.#orgJoin(req, emit);
        case "org.leave":
          return await this.#orgLeave(emit);
        case "org.sync":
          return await this.#orgSync(emit);
        case "org.share":
          return await this.#orgShare(req, emit);
        case "org.unshare":
          return await this.#orgUnshare(req, emit);
        case "org.members":
          return await this.#orgMembers(emit);
        case "org.status":
          return this.#orgStatusReq(emit);
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
    this.#activeWorkflowRuns.clear();
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

  /**
   * Connect to a Flue agent, upsert its agent row, and register the live adapter.
   * Shared internal path used by both manual `agent.connectFlue` and org sync.
   * Returns the stored agent row so callers can build summaries or emit events.
   */
  async #registerConnectedAgent(baseUrl: string, agentName: string, token?: string, instanceId?: string): Promise<StoredAgent> {
    // Reuse the persisted instanceId (J1) unless the caller explicitly provided one.
    const prior = this.#state.getAgent(agentName);
    const adapter = await FlueAdapter.connect({
      baseUrl, agentName, token,
      instanceId: instanceId ?? prior?.flueInstanceId ?? undefined,
    });
    const stored = this.#state.upsertAgent(adapter.info(), "flue", baseUrl);
    if (stored.flueInstanceId !== adapter.instanceId) this.#state.setAgentFlueInstanceId(stored.id, adapter.instanceId);
    this.#agents.set(stored.id, { adapter, kind: "flue", sourceRef: baseUrl, hasToken: !!token });
    return stored;
  }

  async #connectFlue(req: Extract<ClientRequest, { type: "agent.connectFlue" }>, emit: Emit): Promise<void> {
    const stored = await this.#registerConnectedAgent(req.baseUrl, req.agentName, req.token, req.instanceId);
    emit({ type: "agent.registered", agent: this.#summary(stored, true) });
  }

  async #deployFlue(req: Extract<ClientRequest, { type: "agent.deployFlue" }>, emit: Emit): Promise<void> {
    await this.#runDeploy(
      { sourceDir: req.sourceDir, provider: req.provider, model: req.model, target: req.target ?? "docker-local", repoOwner: req.repoOwner },
      emit,
    );
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

  /**
   * Redeploy an agent using the params persisted from its original deploy,
   * overlaying any pending model override from its config (the honest path for
   * applying a model change — Flue fixes the model at convert time).
   */
  async #redeploy(req: Extract<ClientRequest, { type: "agent.redeploy" }>, emit: Emit): Promise<void> {
    // ORG-12 guard: org agents are connect-only — redeploy is the owner's responsibility.
    if (this.#state.isOrgAgent(req.agentId)) {
      const orgRow = this.#state.getOrgAgent(req.agentId);
      emit({ type: "deploy.error", message: `Agent is managed by the org (shared by ${orgRow?.sharedBy ?? "org"}) — connect-only; redeploy is not allowed` });
      return;
    }
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
   * @param knownAgentId  The agentId we're redeploying (if known). On error the
   *   partial log is persisted on that agent's deploy row. For a first deploy
   *   the agentId only becomes known after the agent registers, so a failure is
   *   persisted as the global last-failed-deploy snapshot instead.
   */
  async #runDeploy(
    params: { sourceDir: string; provider?: string | null; model?: string | null; target: string; repoOwner?: string | null },
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
          repoOwner: params.repoOwner ?? undefined,
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
        // The last deploy outcome is no longer a failure — drop the snapshot.
        this.#state.clearLastFailedDeploy();
        emit({ type: "deploy.artifact", target: result.target, url: result.url, message: result.message });
        return;
      }
      const stored = this.#state.upsertAgent(result.adapter.info(), "flue", result.baseUrl);
      this.#agents.set(stored.id, { adapter: result.adapter, kind: "flue", sourceRef: result.baseUrl, hasToken: false });
      // J1: a (re)deploy is a fresh lifecycle epoch — adopt the adapter's instanceId.
      this.#state.setAgentFlueInstanceId(stored.id, result.adapter.instanceId);
      // Persist the inputs so this agent can be redeployed in one click later.
      this.#state.setDeploy(stored.id, {
        sourceDir: params.sourceDir,
        provider: params.provider ?? null,
        model: params.model ?? null,
        target: params.target,
        repoOwner: params.repoOwner ?? null,
      });
      // Persist the accumulated log (overwrites any previous log — one per agent in v1).
      this.#state.setDeployLog(stored.id, logBuffer.join("\n"));
      // The last deploy outcome is no longer a failure — drop the snapshot.
      this.#state.clearLastFailedDeploy();
      emit({ type: "agent.registered", agent: this.#summary(stored, true) });
    } catch (err) {
      const message = (err as Error).message;
      if (knownAgentId) {
        // Redeploy of a known agent — persist the partial log on its deploy row.
        if (logBuffer.length > 0) this.#state.setDeployLog(knownAgentId, logBuffer.join("\n"));
      } else {
        // First deploy — no agent row exists yet to key the log by, so keep it
        // as the global last-failed-deploy snapshot (deploy.lastFailedLog).
        this.#state.setLastFailedDeploy({
          sourceDir: params.sourceDir,
          provider: params.provider ?? null,
          model: params.model ?? null,
          target: params.target,
          message,
          log: logBuffer.join("\n"),
          failedAt: new Date().toISOString(),
        });
      }
      emit({ type: "deploy.error", message });
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

  /**
   * Enumerate the GitHub owners the authenticated gh user can push repos to:
   * the user's own login first, then org logins (one per line from `gh api user/orgs`).
   * Returns an empty list when gh is unavailable or not authenticated — never throws.
   */
  async #githubOwners(emit: Emit): Promise<void> {
    const loginRes = spawnSync("gh", ["api", "user", "--jq", ".login"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (loginRes.status !== 0) {
      emit({ type: "deploy.githubOwners", owners: [] });
      return;
    }
    const login = loginRes.stdout?.trim();
    if (!login) {
      emit({ type: "deploy.githubOwners", owners: [] });
      return;
    }
    const orgsRes = spawnSync("gh", ["api", "user/orgs", "--jq", ".[].login"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    const orgs = orgsRes.status === 0
      ? (orgsRes.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean)
      : [];
    emit({ type: "deploy.githubOwners", owners: [login, ...orgs] });
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

    // K6: reject a second concurrent run of the same workflow — concurrent runs
    // interleave against the same agents and double cost with no benefit in v1.
    const activeRun = this.#activeWorkflowRuns.get(req.workflowId);
    if (activeRun) {
      emit({ type: "error", message: `workflow is already running (run ${activeRun}) — abort it or wait`, requestType: req.type });
      return;
    }

    const runId = `wfr_${randomUUID()}`;
    const controller = new AbortController();
    this.#workflowRuns.set(runId, controller);
    this.#activeWorkflowRuns.set(req.workflowId, runId);
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
    this.#activeWorkflowRuns.delete(req.workflowId);
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
    const sessionIds = [...(this.#agentSessions.get(agentId) ?? [])];
    for (const sessionId of sessionIds) {
      const handle = this.#sessions.get(sessionId);
      if (handle) await handle.abort().catch(() => {});
    }
    this.#agentSessions.delete(agentId);
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
              const adapter = await FlueAdapter.connect({ baseUrl: stored.sourceRef, agentName: stored.name, instanceId: stored.flueInstanceId ?? undefined });
              if (this.#agents.has(stored.id)) {
                // Reconnect-on-boot won the race while we were connecting — keep
                // its adapter and discard ours so neither leaks.
                await adapter.close().catch(() => {});
                continue;
              }
              this.#agents.set(stored.id, { adapter, kind: "flue", sourceRef: stored.sourceRef, hasToken: false });
              if (!stored.flueInstanceId) this.#state.setAgentFlueInstanceId(stored.id, adapter.instanceId);
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

  // ── Org registry (G1) ─────────────────────────────────────────────────────

  /**
   * Build the active OrgManager for the given repo. Creates a new
   * GitHubRegistry for the repo (or uses the injected override for tests).
   */
  #makeOrgManager(repo: string): OrgManager {
    const registry = this.#orgRegistryOverride ?? new GitHubRegistry(repo);
    return new OrgManager(registry, this.#orgStore, this.#state);
  }

  /**
   * Build the payload for an org.status event from the current local binding,
   * org_agents DB state, and the OrgManager's in-memory own-shares set.
   * Returns { bound: false } when not bound.
   *
   * sharedAgentIds = org agent ids in the local DB as of the last sync (other
   * members' shares). For an owner, agents they shared themselves are skipped by
   * the C1 guard during reconcile and do NOT appear here.
   *
   * ownSharedAgentIds = agent ids this instance has shared into the directory.
   * Rebuilt from C1-collision ids on every reconcile; updated immediately on
   * shareAgent/unshareAgent. Drives the owner's Share/Unshare toggle truthfully.
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
      if (this.#agents.has(orgRow.agentId)) continue;
      const stored = this.#state.getAgent(orgRow.agentId);
      if (!stored?.sourceRef) continue;
      try {
        const adapter = await FlueAdapter.connect({ baseUrl: stored.sourceRef, agentName: stored.name, instanceId: stored.flueInstanceId ?? undefined });
        if (!this.#agents.has(orgRow.agentId)) {
          // No token for org agents (G1 — shared entries never carry tokens, ADR-4/rule #8).
          this.#agents.set(orgRow.agentId, { adapter, kind: "flue", sourceRef: stored.sourceRef, hasToken: false });
          if (!stored.flueInstanceId) this.#state.setAgentFlueInstanceId(stored.id, adapter.instanceId);
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
  async #orgSyncOnBoot(): Promise<void> {
    const binding = this.#orgStore.load();
    if (!binding) return;
    try {
      this.#orgManager = this.#makeOrgManager(binding.repo);
      const result = await this.#orgManager.reconcile();
      await this.#connectOrgAgents(result.orgId);
      // Broadcast the populated org.status to any clients that connected while
      // boot sync was in flight (ORG-08: non-blocking but still observable).
      this.#broadcast({ type: "org.status", ...this.#buildOrgStatus() });
    } catch (err) {
      // Boot sync failure must not prevent Fleet from starting (ORG-11).
      console.error("[gateway-core] org boot sync failed:", (err as Error).message ?? err);
    }
  }

  // ── Org request handlers ───────────────────────────────────────────────────

  /** Emit the current org binding state. */
  #orgStatusReq(emit: Emit): void {
    emit({ type: "org.status", ...this.#buildOrgStatus() });
  }

  /** Create a new org and bind this Core instance as owner (ORG-01). */
  async #orgCreate(req: Extract<ClientRequest, { type: "org.create" }>, emit: Emit): Promise<void> {
    try {
      this.#orgManager = this.#makeOrgManager(req.repo);
      await this.#orgManager.createOrg(req.repo, req.name);
      emit({ type: "org.status", ...this.#buildOrgStatus() });
    } catch (err) {
      emit({ type: "org.error", message: orgErrorMessage(err), requestType: "org.create" });
    }
  }

  /** Join an existing org as a member (ORG-02). */
  async #orgJoin(req: Extract<ClientRequest, { type: "org.join" }>, emit: Emit): Promise<void> {
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
  async #orgLeave(emit: Emit): Promise<void> {
    const binding = this.#orgStore.load();
    if (!binding) {
      emit({ type: "org.status", bound: false });
      return;
    }
    try {
      // Close adapters and drain in-flight sessions for org agents so no ghost
      // connections or ghost sessions linger after the org binding is cleared.
      for (const id of this.#state.listOrgAgentIds(binding.orgId)) {
        const reg = this.#agents.get(id);
        if (reg) {
          await reg.adapter.close().catch(() => {});
          this.#agents.delete(id);
          this.#onlineCache.delete(id);
        }
        // Drain sessions (mirrors #teardownAgent — abort each active session and
        // eagerly remove it from the session map so no ghost sessions remain).
        for (const sessionId of (this.#agentSessions.get(id) ?? [])) {
          await this.#sessions.get(sessionId)?.abort().catch(() => {});
          this.#sessions.delete(sessionId);
        }
        this.#agentSessions.delete(id);
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
      emit({ type: "agents", agents: this.#state.listAgents().map((a) => this.#summary(a, this.#agents.has(a.id))) });
    } catch (err) {
      emit({ type: "org.error", message: orgErrorMessage(err), requestType: "org.leave" });
    }
  }

  /** Manual pull+reconcile (ORG-09). Emits org.synced + updated agents + org.status. */
  async #orgSync(emit: Emit): Promise<void> {
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
      emit({ type: "agents", agents: this.#state.listAgents().map((a) => this.#summary(a, this.#agents.has(a.id))) });
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
  async #orgShare(req: Extract<ClientRequest, { type: "org.share" }>, emit: Emit): Promise<void> {
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
    if (this.#agents.get(req.agentId)?.hasToken) {
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
    const binding = manager.getBinding()!;
    const entry: SharedAgentEntry = {
      schemaVersion: 1,
      id: stored.id,
      name: stored.name,
      version: stored.version,
      description: stored.description,
      model: stored.model,
      target: deploy.target as "fly" | "cloudflare" | "dokploy" | "github",
      url: stored.sourceRef,
      sharedBy: binding.myLogin,
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
  async #orgUnshare(req: Extract<ClientRequest, { type: "org.unshare" }>, emit: Emit): Promise<void> {
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
  async #orgMembers(emit: Emit): Promise<void> {
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
        const adapter = await FlueAdapter.connect({ baseUrl: stored.sourceRef, agentName: stored.name, instanceId: stored.flueInstanceId ?? undefined });
        if (this.#agents.has(stored.id)) {
          // A health tick connected this agent while we were awaiting — keep
          // its adapter and discard ours so neither leaks.
          await adapter.close().catch(() => {});
          continue;
        }
        this.#agents.set(stored.id, { adapter, kind: "flue", sourceRef: stored.sourceRef, hasToken: false });
        if (!stored.flueInstanceId) this.#state.setAgentFlueInstanceId(stored.id, adapter.instanceId);
        this.#onlineCache.set(stored.id, true);
        // No broadcast here — there are typically no connected clients at boot time.
        // The first agents.list response will reflect the correct online state.
      } catch {
        // Agent is unreachable — the health loop will reconnect it when it returns.
      }
    }
  }
}
