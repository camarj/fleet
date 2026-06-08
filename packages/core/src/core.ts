/**
 * GatewayCore — the brain. Connects to agents over open standards (A2A for
 * remote, ACP for local), maps their events into the neutral run model, and
 * exposes high-level operations the WebSocket server relays to the frontend.
 */

import { A2AAdapter } from "./adapters/a2a.js";
import { AcpAdapter } from "./adapters/acp.js";
import { FlueAdapter } from "./adapters/flue.js";
import type { AgentAdapter, AgentKind, RunHandle } from "./adapters/agent-adapter.js";
import { FlueDeployer } from "./deploy/flue-deployer.js";
import { SecretsStore } from "./secrets/store.js";
import { computeCostUsd } from "./pricing/pricing.js";
import { GatewayState, type StoredAgent } from "./state/index.js";
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
}

export class GatewayCore {
  readonly #state: GatewayState;
  readonly #agents = new Map<string, RegisteredAgent>();
  readonly #sessions = new Map<string, RunHandle>();
  readonly #secrets = new SecretsStore();
  readonly #deployer = new FlueDeployer(this.#secrets);

  constructor(options: GatewayCoreOptions = {}) {
    this.#state = new GatewayState(options.dbPath ?? ":memory:");
  }

  /** Dispatch a frontend request. Never throws — errors are emitted. */
  async handle(req: ClientRequest, emit: Emit): Promise<void> {
    try {
      switch (req.type) {
        case "agents.list":
          return this.#listAgents(emit);
        case "agent.connectA2A":
          return await this.#connectA2A(req.url, emit);
        case "agent.launchAcp":
          return await this.#launchAcp(req, emit);
        case "agent.connectFlue":
          return await this.#connectFlue(req, emit);
        case "agent.deployFlue":
          return await this.#deployFlue(req, emit);
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
        case "config.set":
          this.#state.setConfig(req.agentId, req.modelSpecifier, req.parameters ?? null);
          emit({ type: "config.updated", agentId: req.agentId });
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

  /** Close every adapter (ACP: kills subprocesses), kill deployed agents, close the store. */
  async shutdown(): Promise<void> {
    for (const reg of this.#agents.values()) {
      await reg.adapter.close().catch(() => {});
    }
    await this.#deployer.shutdown().catch(() => {});
    this.#agents.clear();
    this.#state.close();
  }

  // ── Agents ─────────────────────────────────────────────────────────────────

  #listAgents(emit: Emit): void {
    const agents = this.#state.listAgents().map((a) => this.#summary(a, this.#agents.has(a.id)));
    emit({ type: "agents", agents });
  }

  async #connectA2A(url: string, emit: Emit): Promise<void> {
    const adapter = await A2AAdapter.connect(url);
    const stored = this.#state.upsertAgent(adapter.info(), "a2a", url);
    this.#agents.set(stored.id, { adapter, kind: "a2a", sourceRef: url });
    emit({ type: "agent.registered", agent: this.#summary(stored, true) });
  }

  async #launchAcp(req: Extract<ClientRequest, { type: "agent.launchAcp" }>, emit: Emit): Promise<void> {
    const adapter = await AcpAdapter.launch({
      cwd: req.cwd,
      command: req.command ?? "python",
      args: req.args ?? ["-m", "runtime.acp_server"],
      id: req.id,
      name: req.name,
    });
    const stored = this.#state.upsertAgent(adapter.info(), "acp", req.cwd);
    this.#agents.set(stored.id, { adapter, kind: "acp", sourceRef: req.cwd });
    emit({ type: "agent.registered", agent: this.#summary(stored, true) });
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
    try {
      const result = await this.#deployer.deploy(
        { sourceDir: req.sourceDir, provider: req.provider, model: req.model, target: req.target },
        (step, detail) => emit({ type: "deploy.progress", step, detail }),
      );
      // `github` yields an artifact (a published repo), not a running agent.
      if (result.kind === "artifact") {
        emit({ type: "deploy.artifact", target: result.target, url: result.url, message: result.message });
        return;
      }
      const stored = this.#state.upsertAgent(result.adapter.info(), "flue", result.baseUrl);
      this.#agents.set(stored.id, { adapter: result.adapter, kind: "flue", sourceRef: result.baseUrl });
      emit({ type: "agent.registered", agent: this.#summary(stored, true) });
    } catch (err) {
      emit({ type: "deploy.error", message: (err as Error).message });
    }
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  async #startSession(req: Extract<ClientRequest, { type: "session.start" }>, emit: Emit): Promise<void> {
    const reg = this.#agents.get(req.agentId);
    if (!reg) {
      emit({ type: "error", message: `agent "${req.agentId}" is not connected`, requestType: req.type });
      return;
    }

    const sessionId = this.#state.createSession(req.agentId);
    emit({ type: "session.started", sessionId, agentId: req.agentId });

    const options: RunOptions = { model: this.#resolveModel(req.agentId, req.modelOverride) };
    let seq = 0;

    const sink: RunSink = {
      onEvent: (event) => emit({ type: "session.event", sessionId, seq: seq++, event }),
      onUsage: (usage) => emit({ type: "session.usage", sessionId, usage, costUsd: computeCostUsd(usage) }),
      onDone: (status, usage) => {
        const costUsd = usage ? computeCostUsd(usage) : null;
        if (usage) this.#state.recordUsage(sessionId, null, usage, costUsd);
        this.#state.endSession(sessionId, status === "aborted" ? "aborted" : "completed");
        emit({ type: "session.done", sessionId, status, usage: usage ?? null, costUsd });
        this.#sessions.delete(sessionId);
      },
      onError: (code, message) => {
        this.#state.endSession(sessionId, "error");
        emit({ type: "session.error", sessionId, error: { code, message } });
        this.#sessions.delete(sessionId);
      },
    };

    const handle = reg.adapter.run({ messages: [{ role: "user", content: req.message }] }, options, sink);
    this.#sessions.set(sessionId, handle);
  }

  async #abortSession(sessionId: string, emit: Emit): Promise<void> {
    const handle = this.#sessions.get(sessionId);
    if (!handle) {
      emit({ type: "error", message: `no active session "${sessionId}"`, requestType: "session.abort" });
      return;
    }
    await handle.abort();
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
    };
  }
}
