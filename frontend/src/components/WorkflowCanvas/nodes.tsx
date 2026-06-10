/**
 * Custom React Flow nodes for the workflow canvas — one per workflow node kind
 * (input / agent / output). They render the node's data and expose the right
 * connection handles; the live run status (set during a run) drives their color.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";

export interface WFNodeData extends Record<string, unknown> {
  kind: "input" | "agent" | "output";
  /** input node: the run-parameter name. */
  name?: string;
  /** agent node. */
  agentId?: string;
  /** agent node: display label for the chosen agent. */
  agentName?: string;
  /** agent node: prompt template. */
  promptTemplate?: string;
  /** Live status during a workflow run. */
  status?: "running" | "completed" | "failed";
}

function statusClass(data: WFNodeData): string {
  return data.status ? ` wf-node-${data.status}` : "";
}

export function InputNode(props: NodeProps): React.JSX.Element {
  const data = props.data as WFNodeData;
  return (
    <div className={`wf-node wf-node-input${statusClass(data)}${props.selected ? " selected" : ""}`}>
      <div className="wf-node-kind">input</div>
      <div className="wf-node-title">{data.name || <span className="wf-node-warn">name?</span>}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function AgentNode(props: NodeProps): React.JSX.Element {
  const data = props.data as WFNodeData;
  const missing = !data.agentId || !data.promptTemplate?.trim();
  return (
    <div className={`wf-node wf-node-agent${statusClass(data)}${props.selected ? " selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="wf-node-kind">agent {missing && <span className="wf-node-warn">⚠</span>}</div>
      <div className="wf-node-title">{data.agentName || data.agentId || <span className="wf-node-warn">pick agent</span>}</div>
      {data.promptTemplate ? (
        <div className="wf-node-template">{data.promptTemplate}</div>
      ) : (
        <div className="wf-node-template wf-node-warn">no template</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function OutputNode(props: NodeProps): React.JSX.Element {
  const data = props.data as WFNodeData;
  return (
    <div className={`wf-node wf-node-output${statusClass(data)}${props.selected ? " selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="wf-node-kind">output</div>
      <div className="wf-node-title">{data.name || "result"}</div>
    </div>
  );
}

export const nodeTypes = { input: InputNode, agent: AgentNode, output: OutputNode };
