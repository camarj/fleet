/**
 * WorkflowCanvas — the visual orchestrator (handoff F5, WU-18/19).
 *
 * Edits and visualizes DAG workflows; execution lives in the Core. The user
 * draws input/agent/output nodes, wires edges, saves (positions included), and
 * runs — nodes light up by live status and the final outputs render in a panel.
 * The frontend NEVER executes anything: it only sends workflow.* requests and
 * renders workflow.* events.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { nodeTypes, type WFNodeData } from "./nodes";
import { Modal } from "../Modal/Modal";
import type { GatewayClient } from "../../lib/gatewayClient";
import type { AgentSummary, NodeKind, ServerEvent, Workflow, WorkflowRunSummary } from "../../lib/api";

interface Props {
  client: GatewayClient;
  agents: AgentSummary[];
  connected: boolean;
}

type RunStatus = "completed" | "failed" | "aborted";

function toRF(wf: Workflow, agents: AgentSummary[]): { nodes: Node[]; edges: Edge[] } {
  const nameOf = (id?: string): string | undefined => agents.find((a) => a.id === id)?.name;
  return {
    nodes: wf.nodes.map((n) => ({
      id: n.id,
      type: n.kind,
      position: n.position,
      data: {
        kind: n.kind,
        name: n.name,
        agentId: n.agentId,
        agentName: nameOf(n.agentId),
        promptTemplate: n.promptTemplate,
      } satisfies WFNodeData,
    })),
    edges: wf.edges.map((e) => ({ id: `${e.from}__${e.to}`, source: e.from, target: e.to })),
  };
}

function fromRF(id: string, name: string, nodes: Node[], edges: Edge[]): Workflow {
  return {
    id,
    name,
    nodes: nodes.map((n) => {
      const d = n.data as WFNodeData;
      return { id: n.id, kind: d.kind, name: d.name, agentId: d.agentId, promptTemplate: d.promptTemplate, position: n.position };
    }),
    edges: edges.map((e) => ({ from: e.source, to: e.target })),
  };
}

export function WorkflowCanvas({ client, agents, connected }: Props): React.JSX.Element {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  // K5/D2: stable ref to currentId so the event handler can read it without re-registering on every switch.
  const currentIdRef = useRef<string | null>(null);
  const [name, setName] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Run state.
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [outputs, setOutputs] = useState<Record<string, string> | null>(null);
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [runInputs, setRunInputs] = useState<Record<string, string>>({});
  // K5/D2: run history panel — null means not yet loaded for the open workflow.
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  /** Workflow snapshot taken when the delete confirmation opened, or null when closed.
   * Captured at open time so a programmatic workflow switch can't retarget the delete. */
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  // Keep the ref in sync so the event handler always sees the current workflow id.
  useEffect(() => { currentIdRef.current = currentId; }, [currentId]);

  // Ask for the workflow list whenever we (re)connect.
  useEffect(() => {
    return client.onStatus((c) => {
      if (c) client.send({ type: "workflow.list" });
    });
  }, [client]);

  // Workflow + run events (registered once; uses stable setters only).
  useEffect(() => {
    return client.on((e: ServerEvent) => {
      if (e.type === "workflows") {
        setWorkflows(e.workflows);
      } else if (e.type === "workflow.run.started") {
        setRunId(e.runId);
      } else if (e.type === "workflow.node.status") {
        setNodes((ns) =>
          ns.map((n) => (n.id === e.nodeId ? { ...n, data: { ...n.data, status: e.status, error: e.error } } : n)),
        );
      } else if (e.type === "workflow.run.done") {
        setRunning(false);
        setRunId(null);
        setRunStatus(e.status);
        setOutputs(e.outputs);
        // K5/D2: refresh history immediately after a run finishes so the Runs panel is current.
        if (currentIdRef.current) client.send({ type: "workflow.runs", workflowId: currentIdRef.current });
      } else if (e.type === "workflow.runs") {
        // K5/D2: only update the panel when the event matches the currently open workflow.
        if (e.workflowId === currentIdRef.current) setRuns(e.runs);
      }
    });
  }, [client, setNodes]);

  // Auto-open the first workflow once the list arrives.
  useEffect(() => {
    if (currentId === null && workflows.length > 0) {
      const wf = workflows[0]!;
      setCurrentId(wf.id);
      const rf = toRF(wf, agents);
      setNodes(rf.nodes);
      setEdges(rf.edges);
      setName(wf.name);
    }
  }, [workflows, currentId, agents, setNodes, setEdges]);

  // K5/D2: load run history whenever the open workflow changes (or on first open).
  useEffect(() => {
    if (currentId && connected) {
      setRuns(null);
      setSelectedRun(null);
      client.send({ type: "workflow.runs", workflowId: currentId });
    }
  }, [currentId, connected, client]);

  function resetRun(): void {
    setRunning(false);
    setRunId(null);
    setRunStatus(null);
    setOutputs(null);
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: undefined, error: undefined } })));
  }

  function toggleRunSelection(runId: string): void {
    setSelectedRun((prev) => (prev === runId ? null : runId));
  }

  function selectWorkflow(id: string): void {
    const wf = workflows.find((w) => w.id === id);
    if (!wf) return;
    setCurrentId(id);
    const rf = toRF(wf, agents);
    setNodes(rf.nodes);
    setEdges(rf.edges);
    setName(wf.name);
    setSelectedNodeId(null);
    resetRun();
  }

  function newWorkflow(): void {
    const id = `wf_${crypto.randomUUID()}`;
    client.send({ type: "workflow.save", workflow: { id, name: "New workflow", nodes: [], edges: [] } });
    setCurrentId(id);
    setName("New workflow");
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    resetRun();
  }

  function deleteWorkflow(): void {
    if (!confirmDelete) return;
    client.send({ type: "workflow.delete", workflowId: confirmDelete.id });
    // Only clear the canvas if the deleted workflow is still the one on screen.
    if (currentId === confirmDelete.id) {
      setCurrentId(null);
      setNodes([]);
      setEdges([]);
      setName("");
      setSelectedNodeId(null);
    }
    setConfirmDelete(null);
  }

  function addNode(kind: NodeKind): void {
    const id = `n_${crypto.randomUUID().slice(0, 8)}`;
    const offset = nodes.length * 28;
    setNodes((ns) => [
      ...ns,
      { id, type: kind, position: { x: 80 + offset, y: 80 + offset }, data: { kind } satisfies WFNodeData },
    ]);
    setSelectedNodeId(id);
  }

  function onConnect(conn: Connection): void {
    if (conn.source === conn.target) return; // no self-loops
    setEdges((eds) => addEdge(conn, eds));
  }

  function updateNodeData(id: string, patch: Partial<WFNodeData>): void {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  }

  function deleteSelectedNode(): void {
    if (!selectedNodeId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedNodeId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
  }

  function save(): void {
    if (!currentId) return;
    client.send({ type: "workflow.save", workflow: fromRF(currentId, name, nodes, edges) });
  }

  // ── Run ───────────────────────────────────────────────────────────────────
  function startRun(): void {
    const keys = nodes
      .filter((n) => (n.data as WFNodeData).kind === "input")
      .map((n) => (n.data as WFNodeData).name || n.id);
    if (keys.length > 0) {
      setRunInputs(Object.fromEntries(keys.map((k) => [k, ""])));
      setRunModalOpen(true);
    } else {
      doRun({});
    }
  }

  function doRun(inputs: Record<string, string>): void {
    if (!currentId) return;
    // Save first so the Core runs exactly what's on screen (workflow.run reads the persisted graph).
    client.send({ type: "workflow.save", workflow: fromRF(currentId, name, nodes, edges) });
    resetRun();
    setRunning(true);
    setRunModalOpen(false);
    client.send({ type: "workflow.run", workflowId: currentId, inputs });
  }

  function abortRun(): void {
    if (runId) client.send({ type: "workflow.abort", runId });
  }

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedData = selectedNode ? (selectedNode.data as WFNodeData) : null;

  // Minimal visual validation (handoff WU-18): agent nodes missing an agent or template.
  const warnings = useMemo(
    () =>
      nodes
        .filter((n) => {
          const d = n.data as WFNodeData;
          return d.kind === "agent" && (!d.agentId || !d.promptTemplate?.trim());
        })
        .map((n) => n.id),
    [nodes],
  );

  const nodeErrors = nodes
    .map((n) => ({ id: n.id, error: (n.data as WFNodeData).error }))
    .filter((x): x is { id: string; error: string } => typeof x.error === "string");

  return (
    <div className="wf-canvas">
      {/* Workflow list */}
      <aside className="wf-list">
        <div className="wf-list-head">
          <span>Workflows</span>
          <button className="btn-ghost" disabled={!connected} onClick={newWorkflow} title="New workflow">
            +
          </button>
        </div>
        <ul>
          {workflows.map((w) => (
            <li
              key={w.id}
              className={w.id === currentId ? "selected" : ""}
              onClick={() => selectWorkflow(w.id)}
            >
              {w.name || w.id}
            </li>
          ))}
          {workflows.length === 0 && <li className="empty">No workflows yet</li>}
        </ul>
      </aside>

      {/* Canvas */}
      <div className="wf-graph">
        {currentId ? (
          <>
            <div className="wf-toolbar">
              <input
                className="wf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Workflow name"
              />
              <button className="btn-ghost" onClick={() => addNode("input")}>
                + Input
              </button>
              <button className="btn-ghost" onClick={() => addNode("agent")}>
                + Agent
              </button>
              <button className="btn-ghost" onClick={() => addNode("output")}>
                + Output
              </button>
              <span className="wf-spacer" />
              <button className="btn-ghost" disabled={!connected} onClick={save}>
                Save
              </button>
              {running ? (
                <button className="btn-danger" onClick={abortRun}>
                  ■ Abort
                </button>
              ) : (
                <button className="btn-primary" disabled={!connected} onClick={startRun}>
                  ▶ Run
                </button>
              )}
              <button
                className="btn-ghost wf-del"
                disabled={!connected}
                title="Delete this workflow"
                aria-label="Delete this workflow"
                onClick={() => currentId && setConfirmDelete({ id: currentId, name })}
              >
                ✕
              </button>
            </div>

            <div className="wf-flow">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_, n) => setSelectedNodeId(n.id)}
                onPaneClick={() => setSelectedNodeId(null)}
                nodeTypes={nodeTypes}
                fitView
              >
                <Background />
                <Controls />
              </ReactFlow>
            </div>

            {(warnings.length > 0 || runStatus || nodeErrors.length > 0) && (
              <div className="wf-statusbar">
                {warnings.length > 0 && (
                  <span className="wf-warn-text">⚠ {warnings.length} agent node(s) need an agent or template</span>
                )}
                {runStatus && <span className={`wf-run-${runStatus}`}>Run {runStatus}</span>}
                {nodeErrors.map((e) => (
                  <span key={e.id} className="wf-run-failed">
                    {e.id}: {e.error}
                  </span>
                ))}
              </div>
            )}

            {outputs && Object.keys(outputs).length > 0 && (
              <div className="wf-outputs">
                <div className="wf-outputs-head">Outputs</div>
                {Object.entries(outputs).map(([id, value]) => (
                  <div key={id} className="wf-output-row">
                    <code>{id}</code>
                    <pre>{value}</pre>
                  </div>
                ))}
              </div>
            )}

            {/* K5/D2: run history panel — shows past runs for the open workflow. */}
            {runs && runs.length > 0 && (
              <div className="wf-runs">
                <div className="wf-runs-head">Runs</div>
                {runs.map((run) => {
                  const duration =
                    run.endedAt
                      ? `${Math.round((new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s`
                      : null;
                  const isSelected = selectedRun === run.id;
                  return (
                    <div key={run.id} className="wf-run-row" onClick={() => toggleRunSelection(run.id)}>
                      <div className="wf-run-row-header">
                        <span className={`wf-run-${run.status}`}>{run.status}</span>
                        <span className="wf-run-time">{new Date(run.startedAt).toLocaleTimeString()}</span>
                        {duration && <span className="wf-run-duration">{duration}</span>}
                      </div>
                      {isSelected && (
                        <div className="wf-run-detail">
                          <div className="wf-run-detail-section">
                            <span className="wf-run-detail-label">Inputs</span>
                            {Object.entries(run.inputs).map(([k, v]) => (
                              <div key={k} className="wf-output-row">
                                <code>{k}</code>
                                <pre>{v}</pre>
                              </div>
                            ))}
                          </div>
                          {run.outputs && Object.keys(run.outputs).length > 0 && (
                            <div className="wf-run-detail-section">
                              <span className="wf-run-detail-label">Outputs</span>
                              {Object.entries(run.outputs).map(([k, v]) => (
                                <div key={k} className="wf-output-row">
                                  <code>{k}</code>
                                  <pre>{v}</pre>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <div className="canvas-stub">
            <h3>Workflow Canvas</h3>
            <p>Create a workflow to start wiring agents into a DAG.</p>
            <button className="btn-primary" disabled={!connected} onClick={newWorkflow}>
              + New workflow
            </button>
          </div>
        )}
      </div>

      {/* Inspector */}
      {selectedData && (
        <aside className="wf-inspector">
          <div className="wf-inspector-head">
            <span>{selectedData.kind} node</span>
            <button className="btn-ghost" onClick={deleteSelectedNode} title="Delete node">
              ✕
            </button>
          </div>

          {selectedData.kind === "input" && (
            <label className="wf-field">
              Parameter name
              <input
                value={selectedData.name ?? ""}
                onChange={(e) => updateNodeData(selectedNode!.id, { name: e.target.value })}
                placeholder="e.g. topic"
              />
              <span className="wf-field-hint">Referenced in templates as {`{{input.${selectedData.name || "name"}}}`}</span>
            </label>
          )}

          {selectedData.kind === "agent" && (
            <>
              <label className="wf-field">
                Agent
                <select
                  value={selectedData.agentId ?? ""}
                  onChange={(e) => {
                    const a = agents.find((x) => x.id === e.target.value);
                    updateNodeData(selectedNode!.id, { agentId: a?.id, agentName: a?.name });
                  }}
                >
                  <option value="">— pick an agent —</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} {a.online ? "" : "(offline)"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wf-field">
                Prompt template
                <textarea
                  rows={6}
                  value={selectedData.promptTemplate ?? ""}
                  onChange={(e) => updateNodeData(selectedNode!.id, { promptTemplate: e.target.value })}
                  placeholder="Summarize {{input.topic}} using {{<nodeId>.output}}"
                />
                <span className="wf-field-hint">Use {`{{input.NAME}}`} and {`{{<nodeId>.output}}`}.</span>
              </label>
            </>
          )}

          {selectedData.kind === "output" && (
            <label className="wf-field">
              Label (optional)
              <input
                value={selectedData.name ?? ""}
                onChange={(e) => updateNodeData(selectedNode!.id, { name: e.target.value })}
                placeholder="result"
              />
              <span className="wf-field-hint">Returns the joined output of its incoming node(s).</span>
            </label>
          )}
        </aside>
      )}

      {/* Run inputs modal */}
      {runModalOpen && (
        <Modal
          title="Run workflow"
          onClose={() => setRunModalOpen(false)}
          dismissable
          footer={
            <>
              <button className="btn-ghost" onClick={() => setRunModalOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={() => doRun(runInputs)}>
                ▶ Run
              </button>
            </>
          }
        >
          <div className="wf-run-form">
            {Object.keys(runInputs).map((k) => (
              <label key={k} className="wf-field">
                {k}
                <input
                  value={runInputs[k] ?? ""}
                  onChange={(e) => setRunInputs((prev) => ({ ...prev, [k]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        </Modal>
      )}

      {/* Delete confirmation modal — a workflow has no soft-delete or undo. */}
      {confirmDelete && (
        <Modal
          title="Delete workflow"
          onClose={() => setConfirmDelete(null)}
          dismissable
          footer={
            <>
              <button className="btn-ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={deleteWorkflow}>
                Delete
              </button>
            </>
          }
        >
          <p>
            Delete <strong>{confirmDelete.name || "this workflow"}</strong>? The graph and its
            layout are removed permanently — there is no undo.
          </p>
        </Modal>
      )}
    </div>
  );
}
