# @xyflow/react 12 — Core API Reference

Package: `@xyflow/react@12.11.0`

> NOT `reactflow` — that is the old package. Use `@xyflow/react` exclusively.

Official docs: https://reactflow.dev/api-reference

---

## Install

```bash
pnpm add @xyflow/react
```

Required CSS import (without it, nodes render unstyled/overlapping):
```ts
import "@xyflow/react/dist/style.css";
```

## Core types

```ts
import type { Node, Edge, Connection } from "@xyflow/react";

// Node
interface Node<TData = Record<string, unknown>> {
  id: string;
  position: { x: number; y: number };
  data: TData;
  type?: string;      // matches a key in nodeTypes prop
  width?: number;
  height?: number;
  // ... more optional fields
}

// Edge
interface Edge<TData = Record<string, unknown>> {
  id: string;
  source: string;     // source node id
  target: string;     // target node id
  sourceHandle?: string;
  targetHandle?: string;
  type?: string;
  data?: TData;
}
```

## Key hooks

```ts
import { useNodesState, useEdgesState } from "@xyflow/react";

const [nodes, setNodes, onNodesChange] = useNodesState<Node[]>(initialNodes);
const [edges, setEdges, onEdgesChange] = useEdgesState<Edge[]>(initialEdges);
```

## Key utilities

```ts
import { addEdge } from "@xyflow/react";

// In onConnect handler:
setEdges((eds) => addEdge(connection, eds));
```

## ReactFlow component props (commonly used)

| Prop | Type | Description |
|---|---|---|
| `nodes` | Node[] | Controlled nodes array |
| `edges` | Edge[] | Controlled edges array |
| `onNodesChange` | function | From useNodesState |
| `onEdgesChange` | function | From useEdgesState |
| `onConnect` | function | Called on new connection |
| `nodeTypes` | Record<string, ComponentType> | Custom node components |
| `edgeTypes` | Record<string, ComponentType> | Custom edge components |
| `fitView` | boolean | Fit all nodes on load |
| `defaultViewport` | {x, y, zoom} | Initial viewport |

## Handle (for custom nodes)

```ts
import { Handle, Position } from "@xyflow/react";

// Inside a custom node component:
<Handle type="source" position={Position.Right} />
<Handle type="target" position={Position.Left} />
```

`Position`: `Left` | `Right` | `Top` | `Bottom`

## useReactFlow (programmatic control)

```ts
import { useReactFlow } from "@xyflow/react";

const { fitView, setViewport, getNodes, getEdges } = useReactFlow();
```

Must be used inside a `<ReactFlowProvider>` or within the `<ReactFlow>` subtree.

## Background / Controls / MiniMap (optional panels)

```ts
import { Background, Controls, MiniMap } from "@xyflow/react";

// Inside ReactFlow:
<Background />
<Controls />
<MiniMap />
```

## Full API reference

https://reactflow.dev/api-reference — verify all props and hooks here; the API evolves between minor versions of @xyflow/react 12.
