/**
 * Orchestration engine — Phase 2. SKELETON ONLY.
 *
 * In Phase 2 the Gateway coordinates a workflow: it takes the output of one
 * agent and feeds it to the next (a graph the user draws on the React Flow
 * canvas). Nothing here runs in Phase 1; these shapes only stake out the seam
 * so the rest of the Core can reference it without it existing yet.
 */

export interface WorkflowNode {
  id: string;
  agentId: string;
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

export class Orchestrator {
  /** Phase 2: execute a workflow graph across agents. Not implemented in Phase 1. */
  run(_workflow: Workflow): Promise<never> {
    return Promise.reject(new Error("Orchestration is Phase 2 — not implemented in the MVP."));
  }
}
