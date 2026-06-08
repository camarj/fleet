/**
 * Gateway API — the Core's OWN protocol toward the frontend (over WebSocket).
 *
 * NOT a standard. Agents speak A2A (remote), ACP (local), or Flue (TS harness);
 * the Core translates their events into the neutral run model and relays them
 * here. The frontend never speaks A2A, ACP, or Flue.
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
  /** Connect a served Flue agent over its HTTP+WebSocket API. */
  | { type: "agent.connectFlue"; baseUrl: string; agentName: string; instanceId?: string; token?: string }
  /** Convert a local Claude Code project to a Flue agent, deploy it, and connect. */
  | { type: "agent.deployFlue"; sourceDir: string; provider?: string; model?: string; target?: "docker-local" | "local-process" | "github" | "cloudflare" }
  /** Store a provider API key server-side (secure store). The value never persists in the frontend. */
  | { type: "secrets.set"; provider: string; apiKey: string }
  /** Ask which providers currently have a key set (values are never returned). */
  | { type: "secrets.list" }
  | { type: "session.start"; agentId: string; message: string; modelOverride?: ModelOverride }
  | { type: "session.abort"; sessionId: string }
  | { type: "config.set"; agentId: string; modelSpecifier: string | null; parameters?: ModelParameters | null };

// ── Core → Frontend ──────────────────────────────────────────────────────────

export type ServerEvent =
  | { type: "agents"; agents: AgentSummary[] }
  | { type: "agent.registered"; agent: AgentSummary }
  /** Which providers have an API key set (ids only, never the values). */
  | { type: "secrets.status"; providers: string[] }
  /** A step in an in-flight deploy: converting → installing → building → starting/pushing/deploying → connecting → done. */
  | { type: "deploy.progress"; step: string; detail?: string }
  /** A deploy that produced an artifact instead of a running agent (e.g. a published GitHub repo). */
  | { type: "deploy.artifact"; target: string; url: string; message: string }
  | { type: "deploy.error"; message: string }
  | { type: "config.updated"; agentId: string }
  | { type: "session.started"; sessionId: string; agentId: string }
  | { type: "session.event"; sessionId: string; seq: number; event: RunEvent }
  | { type: "session.usage"; sessionId: string; usage: Usage; costUsd: number | null }
  | { type: "session.done"; sessionId: string; status: RunStatus; usage: Usage | null; costUsd: number | null }
  | { type: "session.error"; sessionId: string; error: { code: RuntimeErrorCode; message: string } }
  | { type: "error"; message: string; requestType?: string };
