/**
 * Gateway API types — a browser-clean MIRROR of the Core's `api.ts`.
 *
 * The frontend deliberately does NOT import the Node Core package; it speaks the
 * Gateway API over WebSocket. Keep this in sync with
 * packages/core/src/api.ts (and the Contract's RunEvent/Usage catalog).
 */

export interface ModelParameters {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface ModelOverride {
  specifier: string;
  parameters?: ModelParameters;
}

/** Which open standard reaches an agent: A2A (remote) or ACP (local). */
export type AgentKind = "a2a" | "acp";

export interface AgentSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Which open standard reaches this agent. */
  kind: AgentKind;
  online: boolean;
  model: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  durationMs?: number;
}

export type MessageRole = "user" | "assistant" | "system";

export type RunEvent =
  | { type: "message.delta"; role: MessageRole; content: string }
  | { type: "message.completed"; role: MessageRole; content: string }
  | { type: "tool.call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool.result"; id: string; name: string; output: unknown }
  | { type: "subagent.start"; name: string }
  | { type: "subagent.end"; name: string }
  | { type: "interrupt"; id: string; reason: string; payload?: Record<string, unknown> };

export type RunStatus = "completed" | "aborted";

export type RuntimeErrorCode =
  | "invalid_request"
  | "unsupported_protocol_version"
  | "run_not_found"
  | "aborted"
  | "timeout"
  | "model_error"
  | "internal_error";

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
