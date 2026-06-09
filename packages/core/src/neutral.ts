/**
 * The Gateway's NEUTRAL run model — its internal lingua franca, and Fleet's own
 * protocol.
 *
 * Fleet is Flue-only: `FlueAdapter` maps the Flue agent's event stream INTO
 * these neutral shapes, so the rest of the Core (state, pricing, the Gateway
 * API, the frontend) stays protocol-agnostic. This vocabulary is owned by the
 * Gateway and mirrored by the frontend (in its own api.ts) — it is what carries
 * the full conversation lifecycle (thinking, tool, MCP, skill, memory, subagent)
 * to the client.
 */

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface ModelParameters {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

/** Neutral input for a run (what an adapter receives). */
export interface RunInput {
  messages: ChatMessage[];
  /** Opaque escape hatch; ignored by the neutral model. */
  context?: Record<string, unknown>;
}

/**
 * Per-run options. Empty in v1: a per-session model override was removed because
 * Flue bakes the model at convert time — changing an agent's model is a redeploy
 * (see `config.set` → `config.updated.requiresRedeploy` → `agent.redeploy`), not
 * a per-run flag. Reserved for genuinely per-run options later.
 */
export type RunOptions = Record<string, never>;

/**
 * Neutral streaming event catalog — Flue's FlueEvent stream maps onto these.
 *
 * The first block is the message/tool/subagent core; the second surfaces Flue's
 * richer stream — reasoning, MCP tool calls, skill invocations, and context
 * compaction — as first-class events the client renders.
 */
export type RunEvent =
  | { type: "message.delta"; role: MessageRole; content: string }
  | { type: "message.completed"; role: MessageRole; content: string }
  | { type: "tool.call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool.result"; id: string; name: string; output: unknown }
  | { type: "subagent.start"; name: string }
  | { type: "subagent.end"; name: string }
  | { type: "interrupt"; id: string; reason: string; payload?: Record<string, unknown> }
  // ── reasoning (Flue thinking_* — activates the frontend ThinkingBlock) ──
  | { type: "thinking.start" }
  | { type: "thinking.delta"; content: string }
  | { type: "thinking.end"; content: string }
  // ── MCP tool calls (derived from Flue tool_* named `mcp__<server>__<tool>`) ──
  | { type: "mcp.call"; id: string; server: string; name: string; input: Record<string, unknown> }
  | { type: "mcp.result"; id: string; server: string; name: string; output: unknown; isError: boolean }
  // ── skills (Flue operation_* with operationKind "skill") ──
  | { type: "skill.start"; id: string; name: string }
  | { type: "skill.end"; id: string; name: string; isError: boolean; durationMs: number }
  // ── memory / context compaction (Flue compaction_*) ──
  | { type: "memory.start"; reason: string; estimatedTokens?: number }
  | { type: "memory.end"; messagesBefore: number; messagesAfter: number; durationMs: number };

/** Token usage — carried by both standards via agreed metadata keys. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Neutral specifier actually used (after overrides). */
  model: string;
  durationMs?: number;
}

export type RunStatus = "completed" | "aborted";

export type RuntimeErrorCode =
  | "invalid_request"
  | "unsupported_protocol_version"
  | "run_not_found"
  | "aborted"
  | "timeout"
  | "model_error"
  | "internal_error";

/** Callback sink an adapter drives as a run streams. */
export interface RunSink {
  onEvent?(event: RunEvent): void;
  onUsage?(usage: Usage): void;
  onDone?(status: RunStatus, usage: Usage | null): void;
  onError?(code: RuntimeErrorCode, message: string): void;
}
