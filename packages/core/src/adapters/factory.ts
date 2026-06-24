/**
 * Adapter factory — the single place the Core decides which `AgentAdapter`
 * implementation to construct for a given agent `kind`.
 *
 * Today there is only `"flue"` → `FlueAdapter`. When the pivot reintroduces A2A
 * (ADR-13), the `A2aAdapter` is wired in by adding ONE `case "a2a"` to the switch
 * below — no call site in `core.ts` or the deployer changes. If more than one
 * place in the codebase ever decides which adapter to build, this seam has
 * regressed.
 */

import type { StoredAgent } from "../state/index.js";
import type { AgentAdapter, AgentKind } from "./agent-adapter.js";
import { FlueAdapter } from "./flue.js";

/** Everything needed to connect an adapter, independent of where it came from. */
export interface AdapterConnectParams {
  kind: AgentKind;
  /** Where the agent is reachable, e.g. http://localhost:8787. */
  baseUrl: string;
  /** Agent name as served by the standard. */
  agentName: string;
  /** Persistent session-instance id to resume; omitted → the adapter generates one. */
  instanceId?: string;
  /** Optional bearer token for the agent's HTTP/WS routes. */
  token?: string;
}

/**
 * Build (and connect) the adapter for `params.kind`. The exhaustive switch is the
 * one and only construction decision point.
 */
export async function createAdapter(params: AdapterConnectParams): Promise<AgentAdapter> {
  switch (params.kind) {
    case "flue":
      return FlueAdapter.connect({
        baseUrl: params.baseUrl,
        agentName: params.agentName,
        instanceId: params.instanceId,
        token: params.token,
      });
    default: {
      // When `AgentKind` gains a new member, TypeScript flags this line until a
      // matching `case` is added above — the compiler enforces the single seam.
      const exhaustive: never = params.kind;
      throw new Error(`Unknown agent kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Reconnect to a persisted agent, reading its `kind` and source from the stored
 * row. Used by every reconnect path (boot, health loop, org sync) so none of
 * them hard-code an adapter type.
 */
export function createAdapterForStored(stored: StoredAgent, token?: string): Promise<AgentAdapter> {
  return createAdapter({
    kind: stored.kind,
    baseUrl: stored.sourceRef,
    agentName: stored.name,
    instanceId: stored.flueInstanceId ?? undefined,
    token,
  });
}

/**
 * The session-instance id an adapter persists for reconnect continuity (Flue J1),
 * or `undefined` for adapters with no such concept. Encapsulating the kind check
 * here keeps `core.ts` free of `instanceof` narrowing and of the neutral
 * `AgentAdapter` interface having to expose a Flue-specific field.
 */
export function sessionInstanceId(adapter: AgentAdapter): string | undefined {
  return adapter instanceof FlueAdapter ? adapter.instanceId : undefined;
}
