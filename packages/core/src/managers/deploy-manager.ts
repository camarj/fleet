/**
 * DeployManager — the deploy/redeploy/preflight cluster extracted from
 * `GatewayCore` (god-object decomposition, issue #65). It owns the convert →
 * deploy → connect flow and its side effects on the store (deploy params, logs,
 * last-failed snapshot), delegating back to the Core only the two things that
 * touch shared central state: registering the freshly connected agent's live
 * adapter (`registerLiveAgent`) and building an `AgentSummary` (`summarize`).
 *
 * GatewayCore keeps the `#agents` map and the agent-summary logic for now; a later
 * slice of #65 may move those into a dedicated AgentRegistry. The Gateway API is
 * unchanged — GatewayCore.handle() just routes the deploy.* / agent.deploy*
 * requests here.
 */

import { spawnSync } from "node:child_process";
import type { FlueDeployer, DeployTarget } from "../deploy/flue-deployer.js";
import type { GatewayState, StoredAgent } from "../state/index.js";
import type { AgentAdapter } from "../adapters/agent-adapter.js";
import type { AgentSummary, ClientRequest, ServerEvent } from "../api.js";
import { splitSpecifier } from "../model-specifier.js";

type Emit = (event: ServerEvent) => void;

export interface DeployManagerDeps {
  deployer: FlueDeployer;
  state: GatewayState;
  /**
   * Register a freshly connected agent's live adapter in the Core's agent map and
   * persist its identity. Returns the StoredAgent so the manager can build the
   * registered summary and persist deploy params/logs against it.
   */
  registerLiveAgent(adapter: AgentAdapter, baseUrl: string): StoredAgent;
  /** Build an AgentSummary (the shared agent-summary logic stays in the Core). */
  summarize(stored: StoredAgent, online: boolean): AgentSummary;
}

export class DeployManager {
  readonly #deployer: FlueDeployer;
  readonly #state: GatewayState;
  readonly #registerLiveAgent: (adapter: AgentAdapter, baseUrl: string) => StoredAgent;
  readonly #summarize: (stored: StoredAgent, online: boolean) => AgentSummary;

  constructor(deps: DeployManagerDeps) {
    this.#deployer = deps.deployer;
    this.#state = deps.state;
    this.#registerLiveAgent = deps.registerLiveAgent;
    this.#summarize = deps.summarize;
  }

  async deployFlue(req: Extract<ClientRequest, { type: "agent.deployFlue" }>, emit: Emit): Promise<void> {
    await this.#runDeploy(
      { sourceDir: req.sourceDir, provider: req.provider, model: req.model, target: req.target ?? "docker-local", repoOwner: req.repoOwner },
      emit,
    );
  }

  /**
   * Redeploy an agent using the params persisted from its original deploy,
   * overlaying any pending model override from its config (the honest path for
   * applying a model change — Flue fixes the model at convert time).
   */
  async redeploy(req: Extract<ClientRequest, { type: "agent.redeploy" }>, emit: Emit): Promise<void> {
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
    // model change is what actually gets rebuilt and re-persisted by runDeploy.
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
      const stored = this.#registerLiveAgent(result.adapter, result.baseUrl);
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
      emit({ type: "agent.registered", agent: this.#summarize(stored, true) });
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
  async preflight(req: Extract<ClientRequest, { type: "deploy.preflight" }>, emit: Emit): Promise<void> {
    const checks = await this.#deployer.preflight({
      provider: req.provider,
      model: req.model,
      target: req.target as DeployTarget,
    });
    emit({ type: "deploy.preflight", checks });
  }

  /** Return the last deploy log for an agent, or null if none has been stored yet. */
  getLastDeployLog(req: Extract<ClientRequest, { type: "deploy.lastLog" }>, emit: Emit): void {
    const log = this.#state.getDeployLog(req.agentId);
    emit({ type: "deploy.lastLog", agentId: req.agentId, log });
  }

  /** List the GitHub owners (the authed user + their orgs) a repo can be pushed to. */
  async githubOwners(emit: Emit): Promise<void> {
    const loginRes = spawnSync("gh", ["api", "user", "--jq", ".login"], { stdio: "pipe", encoding: "utf8" });
    if (loginRes.status !== 0) {
      emit({ type: "deploy.githubOwners", owners: [] });
      return;
    }
    const login = loginRes.stdout?.trim();
    if (!login) {
      emit({ type: "deploy.githubOwners", owners: [] });
      return;
    }
    const orgsRes = spawnSync("gh", ["api", "user/orgs", "--jq", ".[].login"], { stdio: "pipe", encoding: "utf8" });
    const orgs = orgsRes.status === 0 ? (orgsRes.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean) : [];
    emit({ type: "deploy.githubOwners", owners: [login, ...orgs] });
  }
}
