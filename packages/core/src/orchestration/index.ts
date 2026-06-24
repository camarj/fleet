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

import { ExecutionEngine, type EngineTask } from "./execution-engine.js";

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
 *
 * `meta` is opaque run metadata relayed from the orchestrator so the Core can
 * attribute usage back to a workflow run (K2). The engine stays adapter- and
 * storage-agnostic — it only passes the values through; it never reads them.
 */
export interface AgentRunner {
  run(agentId: string, prompt: string, signal: AbortSignal, meta?: { runId?: string; nodeId?: string }): Promise<string>;
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

export interface OrchestratorOptions {
  /** Max wall-clock per agent node. A node exceeding it fails (and fail-fast
   * aborts the run). Input/output nodes are instantaneous and not subject to it. */
  nodeTimeoutMs?: number;
}

const DEFAULT_NODE_TIMEOUT_MS = 600_000; // 10 minutes — generous for real agent work, finite for hangs.

export class Orchestrator {
  readonly #runner: AgentRunner;
  readonly #engine: ExecutionEngine<string>;

  constructor(runner: AgentRunner, options: OrchestratorOptions = {}) {
    this.#runner = runner;
    this.#engine = new ExecutionEngine<string>({
      taskTimeoutMs: options.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS,
      timeoutMessage: (id, ms) => `agent node "${id}" timed out after ${ms}ms`,
    });
  }

  /**
   * Execute a workflow. Nodes run as soon as all their dependencies finish, so
   * independent branches run in parallel. Any node failure fails the whole run
   * and aborts in-flight nodes (no retries). An external `signal` abort yields
   * status "aborted".
   *
   * Validation and `{{...}}` interpolation are the DAG's concern; topological
   * execution, timeout, abort and fail-fast are delegated to `ExecutionEngine`.
   */
  async run(
    wf: Workflow,
    inputs: Record<string, string>,
    hooks: OrchestratorHooks = {},
    signal?: AbortSignal,
    meta?: { runId?: string },
  ): Promise<WorkflowRunResult> {
    const errors = validateWorkflow(wf);
    if (errors.length > 0) return { status: "failed", outputs: {}, error: errors.join("; ") };

    const deps = new Map<string, string[]>(wf.nodes.map((n) => [n.id, []]));
    for (const e of wf.edges) deps.get(e.to)!.push(e.from);

    // Adapt each node to a generic engine task. The DAG owns what each node MEANS
    // (input value / interpolated agent prompt / concatenated upstream outputs);
    // the engine owns HOW they run (deps, timeout, abort, fail-fast).
    const tasks: EngineTask<string>[] = wf.nodes.map((node) => ({
      id: node.id,
      deps: deps.get(node.id)!,
      timed: node.kind === "agent",
      run: ({ results, signal: taskSignal }) => {
        if (node.kind === "input") {
          return Promise.resolve(inputs[node.name ?? node.id] ?? "");
        }
        if (node.kind === "agent") {
          const prompt = interpolate(node.promptTemplate ?? "", inputs, results);
          return this.#runner.run(node.agentId!, prompt, taskSignal, { runId: meta?.runId, nodeId: node.id });
        }
        // output: concatenate upstream outputs (sorted by node id for determinism).
        const out = deps
          .get(node.id)!
          .slice()
          .sort()
          .map((d) => results[d] ?? "")
          .join("\n");
        return Promise.resolve(out);
      },
    }));

    const result = await this.#engine.run(
      tasks,
      { onTaskStatus: (id, status, info) => hooks.onNodeStatus?.(id, status, info && { output: info.result, error: info.error }) },
      signal,
    );
    return { status: result.status, outputs: this.#collectOutputs(wf, result.results), error: result.error };
  }

  #collectOutputs(wf: Workflow, outputs: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of wf.nodes) {
      if (n.kind === "output" && outputs[n.id] !== undefined) out[n.id] = outputs[n.id]!;
    }
    return out;
  }
}
