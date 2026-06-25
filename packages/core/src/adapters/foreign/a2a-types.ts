/**
 * A2A wire shapes — the subset of the Agent2Agent protocol the `A2aAdapter`
 * consumes, verified against the official spec (https://a2a-protocol.org,
 * "legacy"/`kind`-tagged JSON representation). NOT invented (CLAUDE.md rule #4).
 *
 * A2A is JSON-RPC 2.0 over HTTP. A run uses `message/stream`, whose SSE body
 * yields a sequence of `Task | Message | TaskStatusUpdateEvent |
 * TaskArtifactUpdateEvent`, each discriminated by its `kind`. `tasks/cancel`
 * (by task id) requests cancellation. We model only what the neutral mapping
 * needs; richer fields (auth, push config, extensions) are intentionally omitted.
 */

/** Canonical A2A task lifecycle states (spec `TaskState`). */
export type A2aTaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "auth-required"
  | "unknown";

/** A terminal state ends the stream; `completed` is success, the rest are not. */
export const A2A_TERMINAL_STATES: ReadonlySet<A2aTaskState> = new Set([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

export interface A2aTextPart {
  kind: "text";
  text: string;
}
export interface A2aFilePart {
  kind: "file";
  file: { name?: string; mimeType?: string; uri?: string; bytes?: string };
}
export interface A2aDataPart {
  kind: "data";
  data: Record<string, unknown>;
}
export type A2aPart = A2aTextPart | A2aFilePart | A2aDataPart;

export interface A2aMessage {
  kind: "message";
  /** "user" = caller, "agent" = the remote agent's reply. */
  role: "user" | "agent";
  parts: A2aPart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  /** Optional passthrough — Fleet reads token usage from here (see UsageAccumulator). */
  metadata?: Record<string, unknown>;
}

export interface A2aTaskStatus {
  state: A2aTaskState;
  /** Agent-authored status message (carries streamed text on `working`/`failed`). */
  message?: A2aMessage;
  timestamp?: string;
}

export interface A2aArtifact {
  artifactId: string;
  name?: string;
  parts: A2aPart[];
}

export interface A2aTask {
  kind: "task";
  id: string;
  contextId: string;
  status: A2aTaskStatus;
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
}

export interface A2aStatusUpdateEvent {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: A2aTaskStatus;
  /** True on the last status of the task — the stream ends after it. */
  final: boolean;
}

export interface A2aArtifactUpdateEvent {
  kind: "artifact-update";
  taskId: string;
  contextId: string;
  artifact: A2aArtifact;
  append?: boolean;
  lastChunk?: boolean;
}

/** One event yielded by `message/stream`. */
export type A2aStreamEvent = A2aTask | A2aMessage | A2aStatusUpdateEvent | A2aArtifactUpdateEvent;

/** Minimal Agent Card fields used for neutral identity (spec `AgentCard`). */
export interface AgentCard {
  name: string;
  description?: string;
  version?: string;
  url?: string;
}

/**
 * The transport seam the `A2aAdapter` depends on — the production HTTP/JSON-RPC
 * client implements it, and tests inject a fake (the same seam technique Flue and
 * `gh` use). Keeping it an interface means the adapter's mapping/lifecycle logic
 * is testable with synthetic events, no network.
 */
export interface A2aClient {
  /** Start a task and stream its events (`message/stream`). Honors `signal`. */
  sendMessageStream(params: { message: A2aMessage; signal?: AbortSignal }): AsyncIterable<A2aStreamEvent>;
  /** Request cancellation of a task by id (`tasks/cancel`). Best-effort. */
  cancelTask(taskId: string): Promise<void>;
  /** Fetch the Agent Card for identity, or null when unavailable. */
  getAgentCard(): Promise<AgentCard | null>;
}
