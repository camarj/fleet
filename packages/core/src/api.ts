/**
 * Gateway API — the Core's OWN protocol toward the frontend (over WebSocket).
 *
 * NOT a standard. Agents now speak A2A (remote) or ACP (local); the Core
 * translates their events into the neutral run model and relays them here. The
 * frontend never speaks A2A or ACP.
 */

import type { AgentKind } from "./adapters/agent-adapter.js";
import type { ModelOverride, ModelParameters, RunEvent, RunStatus, RuntimeErrorCode, Usage } from "./neutral.js";

/** Compact view of an agent for the Sidebar. */
export interface AgentSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Which open standard reaches this agent. */
  kind: AgentKind;
  /** True while the Core holds a live adapter for it. */
  online: boolean;
  model: string;
}

// ── Frontend → Core ──────────────────────────────────────────────────────────

export type ClientRequest =
  | { type: "agents.list" }
  /** Connect a REMOTE agent over A2A by its base URL (Agent Card auto-discovered). */
  | { type: "agent.connectA2A"; url: string }
  /** Launch a LOCAL agent over ACP — the Core spawns it as a subprocess. */
  | { type: "agent.launchAcp"; cwd: string; command?: string; args?: string[]; id?: string; name?: string }
  | { type: "session.start"; agentId: string; message: string; modelOverride?: ModelOverride }
  | { type: "session.abort"; sessionId: string }
  | { type: "config.set"; agentId: string; modelSpecifier: string | null; parameters?: ModelParameters | null };

// ── Core → Frontend ──────────────────────────────────────────────────────────

export type ServerEvent =
  | { type: "agents"; agents: AgentSummary[] }
  | { type: "agent.registered"; agent: AgentSummary }
  | { type: "config.updated"; agentId: string }
  | { type: "session.started"; sessionId: string; agentId: string }
  | { type: "session.event"; sessionId: string; seq: number; event: RunEvent }
  | { type: "session.usage"; sessionId: string; usage: Usage; costUsd: number | null }
  | { type: "session.done"; sessionId: string; status: RunStatus; usage: Usage | null; costUsd: number | null }
  | { type: "session.error"; sessionId: string; error: { code: RuntimeErrorCode; message: string } }
  | { type: "error"; message: string; requestType?: string };
