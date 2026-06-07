/**
 * The Gateway's NEUTRAL run model — its internal lingua franca.
 *
 * Agents now speak open standards (A2A for remote, ACP for local), not our old
 * custom Runtime Protocol. The protocol-specific clients map each standard's
 * events INTO these neutral shapes, so the rest of the Core (state, pricing,
 * the Gateway API, the frontend) stays protocol-agnostic and unchanged.
 *
 * These types used to live in `@inteliside/agent-contract` (protocol.ts). That
 * was retired in the migration, so the vocabulary now lives here — owned by the
 * Gateway, shared with the frontend (which mirrors it in its own api.ts).
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

/** Per-session model override (the only override the MVP carries). */
export interface ModelOverride {
  specifier: string;
  parameters?: ModelParameters;
}

/** Neutral input for a run (what an adapter receives). */
export interface RunInput {
  messages: ChatMessage[];
  /** Opaque escape hatch; ignored by the neutral model. */
  context?: Record<string, unknown>;
}

export interface RunOptions {
  model?: ModelOverride;
}

/**
 * Neutral streaming event catalog. A2A artifact/status updates and ACP
 * session/update notifications both map onto these.
 */
export type RunEvent =
  | { type: "message.delta"; role: MessageRole; content: string }
  | { type: "message.completed"; role: MessageRole; content: string }
  | { type: "tool.call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool.result"; id: string; name: string; output: unknown }
  | { type: "subagent.start"; name: string }
  | { type: "subagent.end"; name: string }
  | { type: "interrupt"; id: string; reason: string; payload?: Record<string, unknown> };

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

/**
 * Where the agent's usage rides on each standard's wire (agreed with the
 * Scaffolding — these keys are the binding compatibility contract).
 */
export const A2A_USAGE_METADATA_KEY = "inteliside/usage";
export const ACP_USAGE_META_KEY = "inteliside_usage";

/** Callback sink an adapter drives as a run streams. */
export interface RunSink {
  onEvent?(event: RunEvent): void;
  onUsage?(usage: Usage): void;
  onDone?(status: RunStatus, usage: Usage | null): void;
  onError?(code: RuntimeErrorCode, message: string): void;
}
