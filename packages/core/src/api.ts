/**
 * Gateway API — the Core's OWN protocol toward the frontend (over WebSocket).
 *
 * Fleet is Flue-only: agents are Flue agents the Core reaches over Flue's
 * HTTP+WebSocket API. The Core translates their events into the neutral run
 * model and relays them here. The frontend never speaks Flue — only this API.
 */

import type { AgentKind } from "./adapters/agent-adapter.js";
import type { ModelParameters, RunEvent, RunStatus, RuntimeErrorCode, Usage } from "./neutral.js";
import type { FailedDeploy, SessionStatus } from "./state/index.js";
import type { OrgMember, OrgRole } from "./org/registry.js";

// The wire shape of a first-deploy failure is the stored shape — re-exported so
// the frontend mirror (frontend/src/lib/api.ts) has a single source to copy.
export type { FailedDeploy } from "./state/index.js";
// Re-export org types so consumers of api.ts don't need to reach into org/*.
export type { OrgMember, OrgRole } from "./org/registry.js";
import type { Workflow } from "./orchestration/index.js";

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

/**
 * Where a converted agent is deployed (wire copy of DeployTarget). The five the
 * UI offers are docker-local, fly, cloudflare, github, and dokploy.
 * `local-process` stays for Docker-free tests only.
 */
export type DeployTargetWire = "docker-local" | "local-process" | "fly" | "cloudflare" | "github" | "dokploy";

/** Compact view of an agent for the Sidebar. */
export interface AgentSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  /** The agent kind (Flue). */
  kind: AgentKind;
  /** True while the Core holds a live adapter for it. */
  online: boolean;
  model: string;
  /** The base URL the Core connects to (the Flue agent endpoint). */
  url: string;
  /** Deploy target this agent currently lives on (e.g. "cloudflare", "fly",
   * "docker-local"), or null for agents attached by URL (no deploy on record). */
  target: string | null;
  /** True when Fleet has the original deploy params and can redeploy it in one click. */
  redeployable: boolean;
  /**
   * Whether this agent is locally owned ("local") or received from an org registry
   * ("org"). Derived from the presence of an org_agents provenance row (ADR-1/ADR-2).
   * "org" agents are connect-only — stop/delete/redeploy/config are blocked.
   */
  origin: "local" | "org";
  /**
   * The registry login of the user who shared this agent (G1: a GitHub login).
   * null for locally owned agents (origin === "local").
   */
  sharedBy: string | null;
}

/** Compact summary of a past session returned by `sessions.list`. */
export interface SessionSummary {
  id: string;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  /** First ~80 chars of the user's opening message. */
  preview: string;
}

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

// ── Frontend → Core ──────────────────────────────────────────────────────────

export type ClientRequest =
  | { type: "agents.list" }
  /** Connect a served Flue agent over its HTTP+WebSocket API. */
  | { type: "agent.connectFlue"; baseUrl: string; agentName: string; instanceId?: string; token?: string }
  /** Convert a local Claude Code project to a Flue agent, deploy it, and connect. */
  | { type: "agent.deployFlue"; sourceDir: string; provider?: string; model?: string; target?: DeployTargetWire; repoOwner?: string }
  /** Repeat an agent's original deploy (e.g. after adding its provider API key). */
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
  /** Ask which providers AND infrastructure credentials currently have a value set (ids only, never the values). */
  | { type: "secrets.list" }
  | { type: "session.start"; agentId: string; message: string }
  | { type: "session.abort"; sessionId: string }
  | { type: "sessions.list"; agentId: string }
  | { type: "session.history"; sessionId: string }
  | { type: "config.set"; agentId: string; modelSpecifier: string | null; parameters?: ModelParameters | null }
  /** Run preflight checks for a target before deploying (no side-effects). */
  | { type: "deploy.preflight"; provider?: string; model?: string; target: DeployTargetWire }
  /** List the GitHub accounts and organizations available to push repos to (personal account first). */
  | { type: "deploy.githubOwners" }
  /** Retrieve the last deploy log for an agent (persisted at the end of the most recent deploy). */
  | { type: "deploy.lastLog"; agentId: string }
  /** Retrieve the most recent first-deploy failure (no agent was registered), or null if none. */
  | { type: "deploy.lastFailedLog" }
  /** Aggregate token/cost usage per agent+model. `since` is an inclusive ISO timestamp; omit for all time. */
  | { type: "usage.summary"; since?: string | null }
  // ── Orchestration (workflows) ──
  /** Upsert a workflow (by id). The canvas sends the full graph, positions included. */
  | { type: "workflow.save"; workflow: Workflow }
  | { type: "workflow.list" }
  | { type: "workflow.delete"; workflowId: string }
  /** Run a saved workflow with the given run inputs. */
  | { type: "workflow.run"; workflowId: string; inputs: Record<string, string> }
  | { type: "workflow.abort"; runId: string }
  // ── Org registry (G1) ──
  /** Create a new org and bind this instance as owner. */
  | { type: "org.create"; repo: string; name: string }
  /** Join an existing org as a member (requires collaborator access on the registry repo). */
  | { type: "org.join"; repo: string }
  /** Leave the current org: clears the local binding and purges all org agent rows. */
  | { type: "org.leave" }
  /** Manually trigger a pull+reconcile from the remote registry. */
  | { type: "org.sync" }
  /** Share a locally deployed remote agent to the org registry. */
  | { type: "org.share"; agentId: string }
  /** Remove a previously shared agent from the org registry. */
  | { type: "org.unshare"; agentId: string }
  /** List live org members (GitHub collaborators). */
  | { type: "org.members" }
  /** Request the current org binding state (responds with org.status). */
  | { type: "org.status" };

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
  /** A step in an in-flight deploy: converting → installing → building → starting/pushing/deploying → connecting → done. */
  | { type: "deploy.progress"; step: string; detail?: string }
  /** Live output lines from the deploy's underlying commands (docker build, npm install, flue build). */
  | { type: "deploy.log"; lines: string[] }
  /** A deploy that produced an artifact instead of a running agent (e.g. a published GitHub repo). */
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
  // ── Org registry (G1) ──
  /**
   * Current org binding state. When `bound: false`, all other fields are absent.
   * `sharedAgentIds` lists agent ids AS RECEIVED from the directory (other members'
   * shares). The owner's OWN shared agents are skipped by the local-collision guard
   * in reconcile and will NOT appear here — the frontend must track share-toggle state
   * for the owner's own agents locally/optimistically (G1 limitation).
   */
  | {
      type: "org.status";
      bound: boolean;
      orgName?: string;
      repo?: string;
      myLogin?: string;
      role?: OrgRole;
      /**
       * Agent ids received from the remote registry as of the last sync (from local DB).
       * Does NOT include the owner's own shared agents (skipped by the C1 collision guard).
       */
      sharedAgentIds?: string[];
    }
  /** Live org member list (GitHub collaborators). */
  | { type: "org.members"; members: OrgMember[] }
  /** Emitted after a successful pull+reconcile. */
  | { type: "org.synced"; count: number; at: string }
  /**
   * Any org operation failure (gh auth failure, network error, guard violation).
   * `requestType` identifies the org.* request that produced this error — useful
   * for correlating error events on the frontend.
   */
  | { type: "org.error"; message: string; requestType?: string }
  // ── Orchestration (workflows) ──
  | { type: "workflows"; workflows: Workflow[] }
  | { type: "workflow.run.started"; runId: string; workflowId: string }
  /** Per-node progress during a workflow run (v1 emits node-level status, not the agents' internal events). */
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
