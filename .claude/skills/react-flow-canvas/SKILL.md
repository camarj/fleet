---
name: react-flow-canvas
description: Build the node canvas for workflow visualization (Phase 2) using @xyflow/react.
triggers:
  - react flow
  - node canvas
  - workflow graph
  - xyflow
  - flow editor
  - nodes edges
---

## Purpose

Implement the visual workflow canvas for Phase 2 of the Gateway. Nodes represent agents/steps; edges represent connections. Uses `@xyflow/react` (the React 18+ successor to `reactflow`).

## When to use

- Building or modifying the workflow canvas component (Phase 2)
- Adding custom node/edge types
- Implementing graph serialization for saving/loading workflows
- Debugging layout, connection, or state issues

## Package version (verified)

```
@xyflow/react@12.11.0    ← current package (NOT the old `reactflow`)
```

> **NOT `reactflow`** — that package is the old API. Use `@xyflow/react` exclusively.

Official docs: https://reactflow.dev/

## Phase status

A placeholder stub EXISTS at `frontend/src/components/WorkflowCanvas/WorkflowCanvas.tsx`
(static text, no React Flow yet). `@xyflow/react` is NOT installed — install it
when the canvas work starts (handoff WU-18).

**The orchestrator contract is already decided** — do NOT design your own:
`docs/handoff-implementacion-gaps.md` §7 fixes the workflow model (DAG,
node kinds `input | agent | output`, `promptTemplate`, persisted `position`),
the Gateway API messages (`workflow.save/list/delete/run/abort`,
`workflow.node.status`, `workflow.run.done`) and the rule that the frontend
only edits/visualizes — execution lives in the Core (`orchestration/`).

## Core concepts

```
ReactFlow
  ├── nodes[]    — agent boxes, step nodes, etc.
  ├── edges[]    — connections between nodes
  └── handlers   — onNodesChange, onEdgesChange, onConnect
```

State is managed with the `useNodesState` / `useEdgesState` hooks (or external state).

## Basic setup

```tsx
import { ReactFlow, useNodesState, useEdgesState, addEdge } from "@xyflow/react";
import "@xyflow/react/dist/style.css"; // required

const initialNodes = [
  { id: "1", position: { x: 0, y: 0 }, data: { label: "Agent A" } },
];
const initialEdges = [];

export function WorkflowCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const onConnect = (params) => setEdges((eds) => addEdge(params, eds));

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
      />
    </div>
  );
}
```

## Custom node types

```tsx
const AgentNode = ({ data }) => (
  <div className="agent-node">
    <Handle type="target" position={Position.Left} />
    <span>{data.label}</span>
    <Handle type="source" position={Position.Right} />
  </div>
);

const nodeTypes = { agentNode: AgentNode };
// Pass to <ReactFlow nodeTypes={nodeTypes} />
```

## Graph serialization

```ts
// Save
const graph = { nodes, edges }; // plain JSON — send to Core or store locally

// Load
setNodes(graph.nodes);
setEdges(graph.edges);
```

The `ClientRequest`/`ServerEvent` shapes for workflows are specified in
`docs/handoff-implementacion-gaps.md` §7.5 — implement those, mirrored in
`packages/core/src/api.ts` and `frontend/src/lib/api.ts`.

## Steps for the canvas implementation (handoff WU-18/WU-19)

1. Install: `pnpm --filter @inteliside/gateway-frontend add @xyflow/react`
2. Import CSS: `import "@xyflow/react/dist/style.css"`
3. Replace the stub in `frontend/src/components/WorkflowCanvas/WorkflowCanvas.tsx`
4. Custom node types for the three node kinds: `input`, `agent`, `output`
5. Wire save/load/run to the Gateway API messages from the handoff §7.5
6. Agent picker fed from the registered agents list (`AgentSummary` in `api.ts`)
7. Persist node `position` inside the workflow graph JSON (round-trips through `workflow.save`)

## References

- `references/api.md` — @xyflow/react 12 core API
- Official docs: https://reactflow.dev/
- API reference: https://reactflow.dev/api-reference
- Examples: https://reactflow.dev/examples
