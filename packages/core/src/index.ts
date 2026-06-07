/**
 * @inteliside/gateway-core — public surface.
 *
 * The Core connects to agents over open standards (A2A remote, ACP local) and
 * exposes a neutral Gateway API to the frontend.
 */

export { GatewayCore, type Emit, type GatewayCoreOptions } from "./core.js";
export { startServer } from "./server.js";

export * from "./neutral.js";
export * from "./api.js";

export {
  type AgentAdapter,
  type AgentInfo,
  type AgentKind,
  type RunHandle,
  A2AAdapter,
  AcpAdapter,
  type AcpLaunchSpec,
} from "./adapters/index.js";
export {
  GatewayState,
  type StoredAgent,
  type AgentConfig,
  type SessionStatus,
} from "./state/index.js";
export { computeCostUsd, PRICE_TABLE, type ModelPrice } from "./pricing/pricing.js";
export { Orchestrator, type Workflow, type WorkflowNode, type WorkflowEdge } from "./orchestration/index.js";
