/**
 * SessionManager — the interactive-session cluster extracted from `GatewayCore`
 * (god-object decomposition, issue #65). It owns the runtime session maps
 * (`#sessions`, `#agentSessions`) and the conversation lifecycle: start a run on
 * an agent's adapter, stream neutral events to the client, persist them, abort,
 * and list/replay history.
 *
 * It reaches an agent's live adapter through the injected `getAdapter` seam, so it
 * never holds the `#agents` map itself (that stays in the Core for now). Bulk
 * teardown paths (agent stop/delete, org leave, shutdown) call
 * `abortAgentSessions` / `clear`. The Gateway API is unchanged.
 */

import type { AgentAdapter } from "../adapters/agent-adapter.js";
import type { RunHandle } from "../adapters/agent-adapter.js";
import type { RunOptions, RunSink } from "../neutral.js";
import { computeCostUsd } from "../pricing/pricing.js";
import type { GatewayState, SessionSummary } from "../state/index.js";
import type { ClientRequest, ServerEvent } from "../api.js";

type Emit = (event: ServerEvent) => void;

export interface SessionManagerDeps {
  state: GatewayState;
  /** Resolve an agent's live adapter, or undefined when it isn't connected. */
  getAdapter(agentId: string): AgentAdapter | undefined;
}

export class SessionManager {
  readonly #state: GatewayState;
  readonly #getAdapter: (agentId: string) => AgentAdapter | undefined;
  /** Active interactive runs by sessionId (for abort). */
  readonly #sessions = new Map<string, RunHandle>();
  /** Reverse index: agentId → Set of active sessionIds (for bulk-abort on stop/delete). */
  readonly #agentSessions = new Map<string, Set<string>>();

  constructor(deps: SessionManagerDeps) {
    this.#state = deps.state;
    this.#getAdapter = deps.getAdapter;
  }

  async start(req: Extract<ClientRequest, { type: "session.start" }>, emit: Emit): Promise<void> {
    const adapter = this.#getAdapter(req.agentId);
    if (!adapter) {
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

    const handle = adapter.run({ messages: [{ role: "user", content: req.message }] }, options, sink);
    this.#sessions.set(sessionId, handle);
    // Register under the reverse agent→sessions index for bulk-abort on stop/delete.
    if (!this.#agentSessions.has(req.agentId)) this.#agentSessions.set(req.agentId, new Set());
    this.#agentSessions.get(req.agentId)!.add(sessionId);
  }

  async abort(sessionId: string, emit: Emit): Promise<void> {
    const handle = this.#sessions.get(sessionId);
    if (!handle) {
      emit({ type: "error", message: `no active session "${sessionId}"`, requestType: "session.abort" });
      return;
    }
    await handle.abort();
  }

  list(req: Extract<ClientRequest, { type: "sessions.list" }>, emit: Emit): void {
    const sessions: SessionSummary[] = this.#state.listSessions(req.agentId);
    emit({ type: "sessions", agentId: req.agentId, sessions });
  }

  history(req: Extract<ClientRequest, { type: "session.history" }>, emit: Emit): void {
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
   * Abort every in-flight session for an agent and drop it from the maps. Called
   * by agent stop/delete (#teardownAgent) and org leave so no ghost sessions
   * linger. Eagerly removes each session from the map (the async onDone would also
   * remove it, but draining synchronously avoids a window with ghost entries).
   */
  async abortAgentSessions(agentId: string): Promise<void> {
    for (const sessionId of this.#agentSessions.get(agentId) ?? []) {
      await this.#sessions.get(sessionId)?.abort().catch(() => {});
      this.#sessions.delete(sessionId);
    }
    this.#agentSessions.delete(agentId);
  }

  /** Drop all session bookkeeping (shutdown). Adapters are closed by the Core. */
  clear(): void {
    this.#sessions.clear();
    this.#agentSessions.clear();
  }
}
