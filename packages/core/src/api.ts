/**
 * Gateway API — the Core's OWN protocol toward the frontend (over WebSocket).
 *
 * Fleet is Flue-only: agents are Flue agents the Core reaches over Flue's
 * HTTP+WebSocket API. The Core translates their events into the neutral run
 * model and relays them here. The frontend never speaks Flue — only this API.
 */

import type { AgentKind } from "./adapters/agent-adapter.js";
import type { ModelOverride, ModelParameters, RunEvent, RunStatus, RuntimeErrorCode, Usage } from "./neutral.js";

/**
 * Where a converted agent is deployed (wire copy of DeployTarget). The four the
 * UI offers are docker-local, fly, cloudflare, and github (repo for self-hosted
 * Docker — Coolify/Dokploy). `local-process` stays for Docker-free tests only.
 */
export type DeployTargetWire = "docker-local" | "local-process" | "fly" | "cloudflare" | "github";

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
  /** True when Fleet has the original deploy params and can redeploy it in one click. */
  redeployable: boolean;
}

// ── Frontend → Core ──────────────────────────────────────────────────────────

export type ClientRequest =
  | { type: "agents.list" }
  /** Connect a served Flue agent over its HTTP+WebSocket API. */
  | { type: "agent.connectFlue"; baseUrl: string; agentName: string; instanceId?: string; token?: string }
  /** Convert a local Claude Code project to a Flue agent, deploy it, and connect. */
  | { type: "agent.deployFlue"; sourceDir: string; provider?: string; model?: string; target?: DeployTargetWire }
  /** Repeat an agent's original deploy (e.g. after adding its provider API key). */
  | { type: "agent.redeploy"; agentId: string }
  /** Stop the agent's runtime and close the adapter; the registration is kept so it can be redeployed. */
  | { type: "agent.stop"; agentId: string }
  /** Stop the agent's runtime and permanently remove its registration and deploy params. */
  | { type: "agent.delete"; agentId: string }
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
  /** An agent's summary changed (e.g. it went offline after stop). */
  | { type: "agent.updated"; agent: AgentSummary }
  /** The agent was permanently deleted and is no longer in the registry. */
  | { type: "agent.removed"; agentId: string }
  /** Which providers have an API key set (ids only, never the values). */
  | { type: "secrets.status"; providers: string[] }
  /** A step in an in-flight deploy: converting → installing → building → starting/pushing/deploying → connecting → done. */
  | { type: "deploy.progress"; step: string; detail?: string }
  /** Live output lines from the deploy's underlying commands (docker build, npm install, flue build). */
  | { type: "deploy.log"; lines: string[] }
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
