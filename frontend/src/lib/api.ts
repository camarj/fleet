/**
 * Gateway API types — a browser-clean MIRROR of the Core's `api.ts`.
 *
 * The frontend deliberately does NOT import the Node Core package; it speaks the
 * Gateway API over WebSocket. Keep this in sync with
 * packages/core/src/api.ts (and the Contract's RunEvent/Usage catalog).
 */

/**
 * A single check in a deploy preflight report. `ok: false` means the deploy
 * will likely fail for this reason; `detail` carries the actionable fix hint.
 */
export interface PreflightCheck {
  /** Stable id — e.g. "docker", "apiKey", "flyctl", "wrangler", "git", "gh". */
  id: string;
  /** Human-readable label shown in the wizard checklist. */
  label: string;
  ok: boolean;
  /** Actionable hint when ok=false (or an informational note when ok=true). */
  detail?: string;
}

export interface ModelParameters {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

/** The agent kind. Fleet is Flue-only. */
export type AgentKind = "flue";

export interface AgentSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Which open standard reaches this agent. */
  kind: AgentKind;
  online: boolean;
  model: string;
  /** True when Fleet can redeploy it in one click (it has the original deploy params). */
  redeployable: boolean;
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
  | { type: "interrupt"; id: string; reason: string; payload?: Record<string, unknown> }
  // ── Flue-only: reasoning, MCP tool calls, skills, context compaction ──
  | { type: "thinking.start" }
  | { type: "thinking.delta"; content: string }
  | { type: "thinking.end"; content: string }
  | { type: "mcp.call"; id: string; server: string; name: string; input: Record<string, unknown> }
  | { type: "mcp.result"; id: string; server: string; name: string; output: unknown; isError: boolean }
  | { type: "skill.start"; id: string; name: string }
  | { type: "skill.end"; id: string; name: string; isError: boolean; durationMs: number }
  | { type: "memory.start"; reason: string; estimatedTokens?: number }
  | { type: "memory.end"; messagesBefore: number; messagesAfter: number; durationMs: number };

export type RunStatus = "completed" | "aborted";

export type SessionStatus = "running" | "completed" | "aborted" | "error";

/** Compact summary of a past session returned by `sessions.list`. */
export interface SessionSummary {
  id: string;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  /** First ~80 chars of the user's opening message. */
  preview: string;
}

export type RuntimeErrorCode =
  | "invalid_request"
  | "unsupported_protocol_version"
  | "run_not_found"
  | "aborted"
  | "timeout"
  | "model_error"
  | "internal_error";

// ── Frontend → Core ──────────────────────────────────────────────────────────

/** Where a converted agent is deployed (the four offered in the UI). */
export type DeployTarget = "docker-local" | "fly" | "github" | "cloudflare";

export type ClientRequest =
  | { type: "agents.list" }
  /** Connect a served Flue agent over its HTTP+WebSocket API. */
  | { type: "agent.connectFlue"; baseUrl: string; agentName: string; instanceId?: string; token?: string }
  /** Convert a local Claude Code project to a Flue agent, deploy it, and connect. */
  | { type: "agent.deployFlue"; sourceDir: string; provider?: string; model?: string; target?: DeployTarget }
  | { type: "agent.redeploy"; agentId: string }
  /** Stop the agent's runtime and close the adapter; the registration is kept so it can be redeployed. */
  | { type: "agent.stop"; agentId: string }
  /** Stop the agent's runtime and permanently remove its registration and deploy params. */
  | { type: "agent.delete"; agentId: string }
  /** Store a provider API key server-side (the value never persists in the frontend). */
  | { type: "secrets.set"; provider: string; apiKey: string }
  | { type: "secrets.list" }
  | { type: "session.start"; agentId: string; message: string }
  | { type: "session.abort"; sessionId: string }
  | { type: "sessions.list"; agentId: string }
  | { type: "session.history"; sessionId: string }
  | { type: "config.set"; agentId: string; modelSpecifier: string | null; parameters?: ModelParameters | null }
  /** Run preflight checks for a deploy target before deploying (no side-effects). */
  | { type: "deploy.preflight"; provider?: string; model?: string; target: DeployTarget }
  /** Retrieve the last deploy log for an agent (persisted at the end of the most recent deploy). */
  | { type: "deploy.lastLog"; agentId: string };

// ── Core → Frontend ──────────────────────────────────────────────────────────

export type ServerEvent =
  | { type: "agents"; agents: AgentSummary[] }
  | { type: "agent.registered"; agent: AgentSummary }
  /** An agent's summary changed (e.g. it went offline after stop). */
  | { type: "agent.updated"; agent: AgentSummary }
  /** The agent was permanently deleted and is no longer in the registry. */
  | { type: "agent.removed"; agentId: string }
  | { type: "secrets.status"; providers: string[] }
  | { type: "deploy.progress"; step: string; detail?: string }
  /** Live output lines from the deploy's underlying commands (docker build, etc.). */
  | { type: "deploy.log"; lines: string[] }
  /** A deploy that produced an artifact (e.g. a published GitHub repo) instead of a running agent. */
  | { type: "deploy.artifact"; target: string; url: string; message: string }
  | { type: "deploy.error"; message: string }
  /**
   * A config change was saved. `requiresRedeploy` is true when the saved model
   * specifier differs from what the agent currently runs — Flue bakes the model
   * at convert time, so applying it means a redeploy (the honest path).
   */
  | { type: "config.updated"; agentId: string; requiresRedeploy: boolean }
  | { type: "session.started"; sessionId: string; agentId: string }
  | { type: "session.event"; sessionId: string; seq: number; event: RunEvent }
  | { type: "session.usage"; sessionId: string; usage: Usage; costUsd: number | null }
  | { type: "session.done"; sessionId: string; status: RunStatus; usage: Usage | null; costUsd: number | null }
  | { type: "session.error"; sessionId: string; error: { code: RuntimeErrorCode; message: string } }
  /** List of past sessions for an agent (most recent first). */
  | { type: "sessions"; agentId: string; sessions: SessionSummary[] }
  /** Full event log and final usage for a past session. */
  | { type: "session.history"; sessionId: string; events: RunEvent[]; usage: Usage | null; costUsd: number | null }
  | { type: "error"; message: string; requestType?: string }
  /** Results of a deploy.preflight request — one entry per check performed. */
  | { type: "deploy.preflight"; checks: PreflightCheck[] }
  /** The last deploy log for an agent. `log` is null if no deploy has been completed yet. */
  | { type: "deploy.lastLog"; agentId: string; log: string | null };
