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

Phase 2 — not yet implemented. The canvas component does not exist in the current repo. This skill documents how to build it correctly when Phase 2 begins.

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

The Gateway API will need a new `ClientRequest` type (e.g. `workflow.save`) to persist graphs. That is out of scope for Phase 1 — verify the API extension in `packages/core/src/api.ts` before implementing.

## Steps for Phase 2 implementation

1. Install: `pnpm add @xyflow/react` in the frontend package
2. Import CSS: `import "@xyflow/react/dist/style.css"`
3. Create `frontend/src/components/WorkflowCanvas/WorkflowCanvas.tsx`
4. Define custom node types for each agent card type
5. Wire save/load to the Gateway API (requires new `ClientRequest` / `ServerEvent` entries in `api.ts`)
6. Integrate with the agent list from the sidebar (use `AgentSummary` from `api.ts`)

## References

- `references/api.md` — @xyflow/react 12 core API
- Official docs: https://reactflow.dev/
- API reference: https://reactflow.dev/api-reference
- Examples: https://reactflow.dev/examples
