/**
 * WorkflowManager — the orchestration cluster extracted from `GatewayCore`
 * (god-object decomposition, issue #65). It owns the `Orchestrator`, the
 * AgentRunner injection seam, and the run bookkeeping maps (`#workflowRuns`,
 * `#activeWorkflowRuns`). It exposes the workflow CRUD + run/abort/runs the
 * Gateway API routes here.
 *
 * This is the seam the agentic pivot (ADR-12) plugs into: the agentic
 * orchestrator and capability registry will be wired through THIS manager (it
 * already owns the Orchestrator + AgentRunner), not `core.ts`. It reaches a live
 * adapter through the injected `getAdapter` seam, so it never holds the `#agents`
 * map (that stays in the Core for now).
 */

import { randomUUID } from "node:crypto";
import type { AgentAdapter } from "../adapters/agent-adapter.js";
import type { RunSink } from "../neutral.js";
import { computeCostUsd } from "../pricing/pricing.js";
import type { GatewayState } from "../state/index.js";
import { Orchestrator, type AgentRunner } from "../orchestration/index.js";
import type { ClientRequest, ServerEvent } from "../api.js";

type Emit = (event: ServerEvent) => void;

// K3: bound each workflow node's output. A verbose agent must not be able to
// stall the WS connection or freeze the canvas with a multi-megabyte string.
// The cap applies at the source so every consumer (events, interpolation,
// outputs_json, UI) inherits it.
const WORKFLOW_OUTPUT_CAP = Number(process.env.GATEWAY_WORKFLOW_OUTPUT_CAP_BYTES ?? 262_144); // 256 KiB
const OUTPUT_TRUNCATION_MARKER = "\n…[output truncated by Fleet: exceeded GATEWAY_WORKFLOW_OUTPUT_CAP_BYTES]";

/**
 * Truncate a workflow node's accumulated output to at most `cap` bytes, appending
 * a human-readable marker so operators know why the text ends where it does (K3).
 * Extracted as a pure function so it can be unit-tested independently of the sink.
 */
export function capWorkflowOutput(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + OUTPUT_TRUNCATION_MARKER;
}

export interface WorkflowManagerDeps {
  state: GatewayState;
  /** Resolve an agent's live adapter, or undefined when it isn't connected. */
  getAdapter(agentId: string): AgentAdapter | undefined;
}

export class WorkflowManager {
  readonly #state: GatewayState;
  readonly #getAdapter: (agentId: string) => AgentAdapter | undefined;
  readonly #orchestrator: Orchestrator;
  /** Active workflow runs → their abort controller (for workflow.abort). */
  readonly #workflowRuns = new Map<string, AbortController>();
  /** K6: one active run per workflow — workflowId → runId of the run in flight. */
  readonly #activeWorkflowRuns = new Map<string, string>();

  constructor(deps: WorkflowManagerDeps) {
    this.#state = deps.state;
    this.#getAdapter = deps.getAdapter;
    this.#orchestrator = new Orchestrator(this.#agentRunner(), {
      nodeTimeoutMs: Number(process.env.GATEWAY_WORKFLOW_NODE_TIMEOUT_MS ?? 600_000),
    });
  }

  save(req: Extract<ClientRequest, { type: "workflow.save" }>, emit: Emit): void {
    this.#state.saveWorkflow(req.workflow);
    emit({ type: "workflows", workflows: this.#state.listWorkflows() });
  }

  list(emit: Emit): void {
    emit({ type: "workflows", workflows: this.#state.listWorkflows() });
  }

  delete(req: Extract<ClientRequest, { type: "workflow.delete" }>, emit: Emit): void {
    this.#state.deleteWorkflow(req.workflowId);
    emit({ type: "workflows", workflows: this.#state.listWorkflows() });
  }

  abort(runId: string): void {
    this.#workflowRuns.get(runId)?.abort();
  }

  runs(req: Extract<ClientRequest, { type: "workflow.runs" }>, emit: Emit): void {
    emit({ type: "workflow.runs", workflowId: req.workflowId, runs: this.#state.listWorkflowRuns(req.workflowId, req.limit ?? 20) });
  }

  /** Abort every in-flight run and drop the bookkeeping (shutdown). */
  abortAll(): void {
    for (const controller of this.#workflowRuns.values()) controller.abort();
    this.#workflowRuns.clear();
    this.#activeWorkflowRuns.clear();
  }

  async run(req: Extract<ClientRequest, { type: "workflow.run" }>, emit: Emit): Promise<void> {
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
          .filter((n) => n.kind === "agent" && (!n.agentId || !this.#getAdapter(n.agentId)))
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
      { runId },
    );

    this.#state.finishWorkflowRun(runId, result.status, result.outputs);
    this.#workflowRuns.delete(runId);
    this.#activeWorkflowRuns.delete(req.workflowId);
    emit({ type: "workflow.run.done", runId, status: result.status, outputs: result.outputs });
  }

  /**
   * The AgentRunner the Orchestrator uses to run one prompt against one agent.
   * Accumulates the assistant's streamed text (Flue emits message.delta) and
   * resolves with the final text. Never touches the engine's internals — this is
   * the injection seam that keeps the engine adapter-agnostic.
   *
   * K2: each node run creates a session row and records usage on completion so the
   * Usage tab sees tokens spent by workflows. These sessions are recording
   * artifacts only — no session.* events are emitted, so the frontend's
   * interactive session UI never sees them.
   */
  #agentRunner(): AgentRunner {
    return {
      run: (agentId, prompt, signal, meta) => {
        const adapter = this.#getAdapter(agentId);
        if (!adapter) return Promise.reject(new Error(`agent "${agentId}" is not connected`));
        // Create the session row before starting the adapter run so the session
        // id is available in every sink callback without a closure ordering risk.
        const sessionId = this.#state.createSession(agentId, prompt, meta?.runId ?? null);
        return new Promise<string>((resolve, reject) => {
          let text = "";
          const sink: RunSink = {
            onEvent: (e) => {
              // K3: stop accumulating once the cap is reached; the final cap+marker
              // is applied at resolution time (covers both the delta overshoot and
              // the message.completed overwrite path).
              if (e.type === "message.delta" && e.role === "assistant") {
                if (text.length < WORKFLOW_OUTPUT_CAP) text += e.content;
              } else if (e.type === "message.completed" && e.role === "assistant") {
                text = e.content;
              }
            },
            onDone: (status, usage) => {
              // K3: apply the cap once at resolution (covers message.completed overwrites
              // and the slight delta overshoot when the last chunk pushes text past the cap).
              text = capWorkflowOutput(text, WORKFLOW_OUTPUT_CAP);
              const costUsd = usage ? computeCostUsd(usage) : null;
              if (usage) this.#state.recordUsage(sessionId, meta?.runId ?? null, usage, costUsd);
              this.#state.endSession(sessionId, status === "aborted" ? "aborted" : "completed");
              if (status === "aborted") reject(new Error("aborted"));
              else resolve(text);
            },
            onError: (_code, message) => {
              this.#state.endSession(sessionId, "error");
              reject(new Error(message));
            },
          };
          const handle = adapter.run({ messages: [{ role: "user", content: prompt }] }, {}, sink);
          if (signal.aborted) void handle.abort();
          else signal.addEventListener("abort", () => void handle.abort(), { once: true });
        });
      },
    };
  }
}
