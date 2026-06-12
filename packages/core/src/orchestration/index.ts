/**
 * Orchestration engine (Phase 2 / handoff F5) — the DAG runner that lives in the
 * Core. A workflow is a directed ACYCLIC graph of nodes:
 *
 *   input  — a named run parameter ({{input.<name>}} in templates)
 *   agent  — run a prompt template against an agent; its output is the assistant text
 *   output — collect upstream node output(s) as a returned value
 *
 * v1 is deliberately small: no cycles, no conditionals, no loops, no retries.
 * The engine NEVER imports adapters — it runs prompts through an injected
 * `AgentRunner` (wired from core.ts). It reports progress node-by-node via hooks;
 * the per-agent RunEvents stay internal (that is a later concern).
 */

export type NodeKind = "input" | "agent" | "output";

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  /** `input` node: the run-parameter name, referenced in templates as {{input.<name>}}. */
  name?: string;
  /** `agent` node: which agent runs this node. */
  agentId?: string;
  /** `agent` node: prompt template; supports {{input.<name>}} and {{<nodeId>.output}}. */
  promptTemplate?: string;
  /** Canvas layout, persisted so the graph reopens exactly as drawn. */
  position: { x: number; y: number };
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type NodeRunStatus = "running" | "completed" | "failed";
export type WorkflowRunStatus = "completed" | "failed" | "aborted";

/**
 * Runs one prompt against one agent and resolves with the assistant's final text.
 * Injected from core.ts so the engine never touches adapters. Rejects on agent
 * error or abort.
 */
export interface AgentRunner {
  run(agentId: string, prompt: string, signal: AbortSignal): Promise<string>;
}

export interface OrchestratorHooks {
  onNodeStatus?(nodeId: string, status: NodeRunStatus, info?: { output?: string; error?: string }): void;
}

export interface WorkflowRunResult {
  status: WorkflowRunStatus;
  /** Output-node values, keyed by output node id. Populated for the nodes that completed. */
  outputs: Record<string, string>;
  /** Failure/abort reason, when status !== "completed". */
  error?: string;
}

/**
 * Validate a workflow's STRUCTURE: edges reference real nodes, agent nodes carry
 * an agentId, and the graph is acyclic. Returns a list of human-readable errors
 * ([] means valid). Agent existence/online is the runner's concern, not the
 * engine's.
 */
export function validateWorkflow(wf: Workflow): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const n of wf.nodes) {
    if (ids.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
    ids.add(n.id);
    if (n.kind === "agent" && !n.agentId) errors.push(`agent node "${n.id}" has no agentId`);
  }
  for (const e of wf.edges) {
    if (!ids.has(e.from)) errors.push(`edge from unknown node "${e.from}"`);
    if (!ids.has(e.to)) errors.push(`edge to unknown node "${e.to}"`);
  }
  // Don't go further on a structurally broken graph (edges below assume valid ids).
  if (errors.length > 0) return errors;

  // A template's {{<nodeId>.output}} reference must be a declared dependency
  // (an edge from that node), otherwise the value would silently resolve empty
  // or stale at runtime depending on execution order.
  const incoming = new Map<string, Set<string>>(wf.nodes.map((n) => [n.id, new Set()]));
  for (const e of wf.edges) incoming.get(e.to)!.add(e.from);
  for (const n of wf.nodes) {
    if (n.kind !== "agent" || !n.promptTemplate) continue;
    for (const ref of outputRefs(n.promptTemplate)) {
      if (!incoming.get(n.id)!.has(ref)) {
        errors.push(`agent node "${n.id}" references {{${ref}.output}} but has no edge from "${ref}"`);
      }
    }
  }
  if (errors.length > 0) return errors;

  // Kahn's algorithm — if not every node is consumed, there is a cycle.
  const indeg = new Map<string, number>(wf.nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(wf.nodes.map((n) => [n.id, []]));
  for (const e of wf.edges) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    adj.get(e.from)!.push(e.to);
  }
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    seen++;
    for (const next of adj.get(id)!) {
      const d = indeg.get(next)! - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (seen !== wf.nodes.length) errors.push("workflow has a cycle");
  return errors;
}

/** Template placeholder scanner — shared by interpolate and validation. */
const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** The node ids referenced as {{<nodeId>.output}} in a template. */
function outputRefs(template: string): string[] {
  const refs: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const ref = m[1]!;
    if (!ref.startsWith("input.") && ref.endsWith(".output")) refs.push(ref.slice(0, -".output".length));
  }
  return refs;
}

/**
 * Replace {{input.<name>}} with the run input and {{<nodeId>.output}} with a
 * completed node's output. Unknown references resolve to an empty string (v1:
 * lenient, not an error).
 */
export function interpolate(
  template: string,
  inputs: Record<string, string>,
  outputs: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, ref: string) => {
    if (ref.startsWith("input.")) return inputs[ref.slice("input.".length)] ?? "";
    if (ref.endsWith(".output")) return outputs[ref.slice(0, -".output".length)] ?? "";
    return "";
  });
}

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export interface OrchestratorOptions {
  /** Max wall-clock per agent node. A node exceeding it fails (and fail-fast
   * aborts the run). Input/output nodes are instantaneous and not subject to it. */
  nodeTimeoutMs?: number;
}

const DEFAULT_NODE_TIMEOUT_MS = 600_000; // 10 minutes — generous for real agent work, finite for hangs.

export class Orchestrator {
  readonly #runner: AgentRunner;
  readonly #nodeTimeoutMs: number;

  constructor(runner: AgentRunner, options: OrchestratorOptions = {}) {
    this.#runner = runner;
    this.#nodeTimeoutMs = options.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;
  }

  /**
   * Execute a workflow. Nodes run as soon as all their dependencies finish, so
   * independent branches run in parallel. Any node failure fails the whole run
   * and aborts in-flight nodes (no retries). An external `signal` abort yields
   * status "aborted".
   */
  async run(
    wf: Workflow,
    inputs: Record<string, string>,
    hooks: OrchestratorHooks = {},
    signal?: AbortSignal,
  ): Promise<WorkflowRunResult> {
    const errors = validateWorkflow(wf);
    if (errors.length > 0) return { status: "failed", outputs: {}, error: errors.join("; ") };

    const nodeById = new Map(wf.nodes.map((n) => [n.id, n]));
    const deps = new Map<string, string[]>(wf.nodes.map((n) => [n.id, []]));
    for (const e of wf.edges) deps.get(e.to)!.push(e.from);

    const outputs: Record<string, string> = {};
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const memo = new Map<string, Promise<string>>();
    const runNode = (id: string): Promise<string> => {
      const existing = memo.get(id);
      if (existing) return existing;
      const node = nodeById.get(id)!;
      const promise = (async () => {
        // Wait for every dependency to finish; their outputs are now in `outputs`.
        await Promise.all(deps.get(id)!.map(runNode));
        if (controller.signal.aborted) throw new AbortError();

        hooks.onNodeStatus?.(id, "running");
        try {
          let out: string;
          if (node.kind === "input") {
            out = inputs[node.name ?? id] ?? "";
          } else if (node.kind === "agent") {
            const prompt = interpolate(node.promptTemplate ?? "", inputs, outputs);
            // K1: bound each agent node with a wall-clock deadline. The node gets its own
            // controller chained to the run controller, so fail-fast/external abort still
            // cancel it, while a timeout cancels ONLY this node's run (fail-fast then
            // propagates through the normal failure path).
            const nodeCtl = new AbortController();
            const onRunAbort = (): void => nodeCtl.abort();
            controller.signal.addEventListener("abort", onRunAbort, { once: true });
            const timer = setTimeout(() => nodeCtl.abort(), this.#nodeTimeoutMs);
            try {
              out = await this.#runner.run(node.agentId!, prompt, nodeCtl.signal);
            } catch (err) {
              // Distinguish "this node timed out" from "the run was aborted/failed elsewhere".
              if (nodeCtl.signal.aborted && !controller.signal.aborted) {
                throw new Error(`agent node "${id}" timed out after ${this.#nodeTimeoutMs}ms`);
              }
              throw err;
            } finally {
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", onRunAbort);
            }
          } else {
            // output: concatenate upstream outputs (sorted by node id for determinism).
            out = deps
              .get(id)!
              .slice()
              .sort()
              .map((d) => outputs[d] ?? "")
              .join("\n");
          }
          outputs[id] = out;
          hooks.onNodeStatus?.(id, "completed", { output: out });
          return out;
        } catch (err) {
          hooks.onNodeStatus?.(id, "failed", { error: (err as Error).message });
          throw err;
        }
      })();
      memo.set(id, promise);
      return promise;
    };

    try {
      await Promise.all(wf.nodes.map((n) => runNode(n.id)));
      return { status: "completed", outputs: this.#collectOutputs(wf, outputs) };
    } catch (err) {
      // Fail fast: cancel any in-flight agent runs.
      controller.abort();
      const status: WorkflowRunStatus = signal?.aborted ? "aborted" : "failed";
      return { status, outputs: this.#collectOutputs(wf, outputs), error: (err as Error).message };
    } finally {
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
  }

  #collectOutputs(wf: Workflow, outputs: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of wf.nodes) {
      if (n.kind === "output" && outputs[n.id] !== undefined) out[n.id] = outputs[n.id]!;
    }
    return out;
  }
}
