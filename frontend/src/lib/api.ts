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

// ── Orchestration (workflows) — mirror of orchestration/index.ts ──
export type NodeKind = "input" | "agent" | "output";

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  /** `input` node: the run-parameter name, referenced in templates as {{input.<name>}}. */
  name?: string;
  /** `agent` node: which agent runs this node. */
  agentId?: string;
  /** `agent` node: prompt template; supports {{input.<name>}} and {{<nodeId>.output}}. */
  promptTemplate?: string;
  /** Canvas layout, persisted so the graph reopens exactly as drawn. */
  position: { x: number; y: number };
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
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
  /** The base URL the Core connects to (the Flue agent endpoint). */
  url: string;
  /** Deploy target this agent currently lives on (e.g. "cloudflare", "fly",
   * "docker-local"), or null for agents attached by URL (no deploy on record). */
  target: string | null;
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

/** One aggregated usage row (per agent+model). */
export interface UsageAgentSummary {
  agentId: string;
  agentName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Sum over priced rows only; null when no row in the group has a price. */
  costUsd: number | null;
  runs: number;
  /** Rows whose model has no price (excluded from costUsd). */
  unpricedRuns: number;
}

/** Grand totals across all UsageAgentSummary rows of a usage.summary response. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Sum over priced rows only; null when nothing in the window is priced. */
  costUsd: number | null;
  runs: number;
  unpricedRuns: number;
}

/**
 * Snapshot of the most recent FIRST deploy that failed before an agent was
 * registered. Such a deploy has no agent row to key its log by, so the Core
 * keeps the last one globally (overwritten by each new first-deploy failure).
 */
export interface FailedDeploy {
  sourceDir: string;
  provider: string | null;
  model: string | null;
  target: string;
  /** The error that aborted the deploy. */
  message: string;
  /** Accumulated command output up to the failure (may be empty). */
  log: string;
  /** ISO timestamp of the failure. */
  failedAt: string;
}

// ── Frontend → Core ──────────────────────────────────────────────────────────

/** Where a converted agent is deployed (the five offered in the UI). */
export type DeployTarget = "docker-local" | "fly" | "github" | "cloudflare" | "dokploy";

export type ClientRequest =
  | { type: "agents.list" }
  /** Connect a served Flue agent over its HTTP+WebSocket API. */
  | { type: "agent.connectFlue"; baseUrl: string; agentName: string; instanceId?: string; token?: string }
  /** Convert a local Claude Code project to a Flue agent, deploy it, and connect. */
  | { type: "agent.deployFlue"; sourceDir: string; provider?: string; model?: string; target?: DeployTarget; repoOwner?: string }
  | { type: "agent.redeploy"; agentId: string }
  /** Stop the agent's runtime and close the adapter; the registration is kept so it can be redeployed. */
  | { type: "agent.stop"; agentId: string }
  /** Stop the agent's runtime and permanently remove its registration and deploy params. */
  | { type: "agent.delete"; agentId: string }
  /**
   * Store a provider API key or infrastructure credential server-side (secure store).
   * The `provider` field is either a provider name (e.g. "anthropic") OR an infrastructure
   * env-var name (e.g. "FLY_API_TOKEN"). A stored value wins over the env var of the same
   * name. Pass an empty `apiKey` to clear the stored value. The value never persists in
   * the frontend.
   */
  | { type: "secrets.set"; provider: string; apiKey: string }
  | { type: "secrets.list" }
  | { type: "session.start"; agentId: string; message: string }
  | { type: "session.abort"; sessionId: string }
  | { type: "sessions.list"; agentId: string }
  | { type: "session.history"; sessionId: string }
  | { type: "config.set"; agentId: string; modelSpecifier: string | null; parameters?: ModelParameters | null }
  /** Run preflight checks for a deploy target before deploying (no side-effects). */
  | { type: "deploy.preflight"; provider?: string; model?: string; target: DeployTarget }
  /** List the GitHub accounts and organizations available to push repos to (personal account first). */
  | { type: "deploy.githubOwners" }
  /** Retrieve the last deploy log for an agent (persisted at the end of the most recent deploy). */
  | { type: "deploy.lastLog"; agentId: string }
  /** Retrieve the most recent first-deploy failure (no agent was registered), or null if none. */
  | { type: "deploy.lastFailedLog" }
  /** Aggregate token/cost usage per agent+model. `since` is an inclusive ISO timestamp; omit for all time. */
  | { type: "usage.summary"; since?: string | null }
  // ── Orchestration (workflows) ──
  | { type: "workflow.save"; workflow: Workflow }
  | { type: "workflow.list" }
  | { type: "workflow.delete"; workflowId: string }
  | { type: "workflow.run"; workflowId: string; inputs: Record<string, string> }
  | { type: "workflow.abort"; runId: string };

// ── Core → Frontend ──────────────────────────────────────────────────────────

export type ServerEvent =
  | { type: "agents"; agents: AgentSummary[] }
  | { type: "agent.registered"; agent: AgentSummary }
  /** An agent's summary changed (e.g. it went offline after stop). */
  | { type: "agent.updated"; agent: AgentSummary }
  /** The agent was permanently deleted and is no longer in the registry. */
  | { type: "agent.removed"; agentId: string }
  /** Which providers AND infrastructure credentials have a value set (ids only, never the values). */
  | { type: "secrets.status"; providers: string[] }
  | { type: "deploy.progress"; step: string; detail?: string }
  /** Live output lines from the deploy's underlying commands (docker build, etc.). */
  | { type: "deploy.log"; lines: string[] }
  /** A deploy that produced an artifact (e.g. a published GitHub repo) instead of a running agent. */
  | { type: "deploy.artifact"; target: string; url: string; message: string }
  /** Source-project features that did NOT convert to Flue (hooks, MCP stdio, …). Informational; does not block the deploy. */
  | { type: "deploy.unmapped"; items: { kind: string; name: string; reason: string }[] }
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
  /** Available GitHub owners: the authenticated user's login first, followed by org logins.
   * Empty array when gh is unavailable or not authenticated. */
  | { type: "deploy.githubOwners"; owners: string[] }
  /** The last deploy log for an agent. `log` is null if no deploy has been completed yet. */
  | { type: "deploy.lastLog"; agentId: string; log: string | null }
  /** The most recent first-deploy failure. `failed` is null when none has been recorded. */
  | { type: "deploy.lastFailedLog"; failed: FailedDeploy | null }
  /** Aggregated usage per agent+model plus grand totals for the requested window. */
  | { type: "usage.summary"; since: string | null; rows: UsageAgentSummary[]; totals: UsageTotals }
  // ── Orchestration (workflows) ──
  | { type: "workflows"; workflows: Workflow[] }
  | { type: "workflow.run.started"; runId: string; workflowId: string }
  | {
      type: "workflow.node.status";
      runId: string;
      nodeId: string;
      status: "running" | "completed" | "failed";
      output?: string;
      error?: string;
    }
  | {
      type: "workflow.run.done";
      runId: string;
      status: "completed" | "failed" | "aborted";
      outputs: Record<string, string>;
    };
