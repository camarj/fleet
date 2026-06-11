/**
 * Gateway state — its own SQLite store (agents, configs, sessions, usage).
 *
 * Uses Node's built-in `node:sqlite` (Node 22.5+/24): zero native build, zero
 * dependencies. Stores a NEUTRAL agent descriptor — Fleet discovers each Flue
 * agent on connect and keeps only what it needs.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AgentInfo, AgentKind } from "../adapters/agent-adapter.js";
import type { ModelParameters, RunEvent, Usage } from "../neutral.js";
import type { Workflow } from "../orchestration/index.js";
import type { SharedAgentEntry } from "../org/registry.js";

export type SessionStatus = "running" | "completed" | "aborted" | "error";

/** Compact session descriptor returned by `sessions.list`. */
export interface SessionSummary {
  id: string;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  /** First ~80 chars of the user's opening message. */
  preview: string;
}

export interface StoredAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  model: string;
  kind: AgentKind;
  /** The Flue agent's base URL. */
  sourceRef: string;
  updatedAt: string;
}

export interface AgentConfig {
  agentId: string;
  modelSpecifier: string | null;
  parameters: ModelParameters | null;
  updatedAt: string;
}

/**
 * Snapshot of the most recent FIRST deploy that failed before an agent was
 * registered (so there is no agent row to key its log by). Stored globally in
 * the meta table; each new first-deploy failure overwrites the previous one.
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

/** The original deploy inputs, kept so an agent can be redeployed in one click. */
export interface DeployParams {
  sourceDir: string;
  provider: string | null;
  model: string | null;
  target: string;
  /** GitHub account or organization that received the pushed repo; null means the
   * authenticated user's personal account (the gh CLI default). */
  repoOwner: string | null;
}

/**
 * One row from the `org_agents` provenance satellite.
 *
 * origin is DERIVED from this row's existence: an agent is "org" iff it has
 * an org_agents row, otherwise "local". Symmetric with the `deploys` satellite
 * (ADR-1).
 */
export interface StoredOrgAgent {
  agentId: string;
  orgId: string;
  sharedBy: string;
  target: string;
  sharedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  version     TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL,
  source_ref  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS configs (
  agent_id        TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  model_specifier TEXT,
  parameters_json TEXT,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deploys (
  agent_id   TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  source_dir TEXT NOT NULL,
  provider   TEXT,
  model      TEXT,
  target     TEXT NOT NULL,
  log        TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id     TEXT,
  status     TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  preview    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  event_json TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id        TEXT,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens  INTEGER NOT NULL,
  model         TEXT NOT NULL,
  cost_usd      REAL,
  duration_ms   INTEGER,
  recorded_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  inputs_json  TEXT NOT NULL,
  outputs_json TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT
);

CREATE TABLE IF NOT EXISTS org_agents (
  agent_id  TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  org_id    TEXT NOT NULL,
  shared_by TEXT NOT NULL,
  target    TEXT NOT NULL,
  shared_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_org_agents_org ON org_agents(org_id);
`;

export class GatewayState {
  readonly #db: DatabaseSync;

  /** @param path File path, or ":memory:" for an ephemeral store. */
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
    this.#applyMigrations();
  }

  /**
   * Idempotent schema migrations for columns added after initial table creation.
   * Each ALTER TABLE is wrapped in a try-catch so it's safe to run on an already-
   * migrated DB (SQLite has no ADD COLUMN IF NOT EXISTS syntax).
   */
  #applyMigrations(): void {
    // WU-06: add `preview` column to sessions (present in SCHEMA for new DBs;
    // older file DBs need the ALTER TABLE path).
    this.#addColumnIfMissing(`ALTER TABLE sessions ADD COLUMN preview TEXT NOT NULL DEFAULT ''`);
    // WU-09: add `log` column to deploys — stores the last deploy log per agent.
    this.#addColumnIfMissing(`ALTER TABLE deploys ADD COLUMN log TEXT`);
    // feat(deploy): add `repo_owner` column — GitHub account or org that received the pushed repo.
    this.#addColumnIfMissing(`ALTER TABLE deploys ADD COLUMN repo_owner TEXT`);
    // B3: usage.summary filters by recorded_at — keep it off the full-scan path.
    this.#db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_recorded_at ON usage(recorded_at)`);
  }

  /**
   * Run an ALTER TABLE ... ADD COLUMN, treating only "duplicate column name" as
   * already-applied. Any other failure (corruption, disk full, permissions) must
   * surface instead of leaving the DB open with an inconsistent schema.
   */
  #addColumnIfMissing(alterSql: string): void {
    try {
      this.#db.exec(alterSql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("duplicate column name")) throw err;
    }
  }

  close(): void {
    this.#db.close();
  }

  // ── Agents ───────────────────────────────────────────────────────────────

  upsertAgent(info: AgentInfo, kind: AgentKind, sourceRef: string): StoredAgent {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO agents (id, name, version, description, model, kind, source_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           description = excluded.description,
           model = excluded.model,
           kind = excluded.kind,
           source_ref = excluded.source_ref,
           updated_at = excluded.updated_at`,
      )
      .run(info.id, info.name, info.version, info.description, info.model ?? "", kind, sourceRef, now, now);
    const stored = this.getAgent(info.id);
    if (!stored) throw new Error(`failed to persist agent ${info.id}`);
    return stored;
  }

  getAgent(id: string): StoredAgent | null {
    const row = this.#db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as unknown as
      | AgentDbRow
      | undefined;
    return row ? rowToAgent(row) : null;
  }

  listAgents(): StoredAgent[] {
    const rows = this.#db.prepare(`SELECT * FROM agents ORDER BY name`).all() as unknown as AgentDbRow[];
    return rows.map(rowToAgent);
  }

  // ── Per-agent config (model override; MVP = model only) ────────────────────

  getConfig(agentId: string): AgentConfig | null {
    const row = this.#db.prepare(`SELECT * FROM configs WHERE agent_id = ?`).get(agentId) as unknown as
      | ConfigDbRow
      | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id,
      modelSpecifier: row.model_specifier,
      parameters: row.parameters_json ? (JSON.parse(row.parameters_json) as ModelParameters) : null,
      updatedAt: row.updated_at,
    };
  }

  setConfig(agentId: string, modelSpecifier: string | null, parameters: ModelParameters | null): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO configs (agent_id, model_specifier, parameters_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           model_specifier = excluded.model_specifier,
           parameters_json = excluded.parameters_json,
           updated_at = excluded.updated_at`,
      )
      .run(agentId, modelSpecifier, parameters ? JSON.stringify(parameters) : null, now);
  }

  // ── Per-agent deploy params (for one-click redeploy) ───────────────────────

  setDeploy(agentId: string, params: DeployParams): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO deploys (agent_id, source_dir, provider, model, target, repo_owner, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           source_dir = excluded.source_dir,
           provider = excluded.provider,
           model = excluded.model,
           target = excluded.target,
           repo_owner = excluded.repo_owner,
           updated_at = excluded.updated_at`,
      )
      .run(agentId, params.sourceDir, params.provider, params.model, params.target, params.repoOwner ?? null, now);
  }

  getDeploy(agentId: string): DeployParams | null {
    const row = this.#db.prepare(`SELECT * FROM deploys WHERE agent_id = ?`).get(agentId) as unknown as
      | DeployDbRow
      | undefined;
    if (!row) return null;
    return { sourceDir: row.source_dir, provider: row.provider, model: row.model, target: row.target, repoOwner: row.repo_owner ?? null };
  }

  hasDeploy(agentId: string): boolean {
    const row = this.#db.prepare(`SELECT 1 FROM deploys WHERE agent_id = ?`).get(agentId);
    return !!row;
  }

  /** Overwrite the stored deploy log for an agent (one log per agent, intentional in v1). */
  setDeployLog(agentId: string, log: string): void {
    this.#db.prepare(`UPDATE deploys SET log = ? WHERE agent_id = ?`).run(log, agentId);
  }

  /** Return the stored deploy log for an agent, or null if none exists yet. */
  getDeployLog(agentId: string): string | null {
    const row = this.#db.prepare(`SELECT log FROM deploys WHERE agent_id = ?`).get(agentId) as unknown as
      | { log: string | null }
      | undefined;
    return row?.log ?? null;
  }

  /**
   * Overwrite the snapshot of the most recent first-deploy failure. A failed
   * FIRST deploy has no agent row to key its log by (the agent only exists
   * after it registers), so the last one is kept globally in the meta table.
   */
  setLastFailedDeploy(failed: FailedDeploy): void {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('last_failed_deploy', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(failed));
  }

  /** Return the most recent first-deploy failure, or null if none was recorded. */
  getLastFailedDeploy(): FailedDeploy | null {
    const row = this.#db.prepare(`SELECT value FROM meta WHERE key = 'last_failed_deploy'`).get() as unknown as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as FailedDeploy;
    } catch {
      // A corrupt row must not take the whole request down — treat it as absent.
      return null;
    }
  }

  /** Forget the recorded first-deploy failure (called when a later deploy succeeds). */
  clearLastFailedDeploy(): void {
    this.#db.prepare(`DELETE FROM meta WHERE key = 'last_failed_deploy'`).run();
  }

  /**
   * Hard-delete an agent row. The schema's ON DELETE CASCADE removes all child
   * rows (configs, deploys, sessions, usage) automatically.
   */
  deleteAgent(id: string): void {
    this.#db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  }

  // ── Org agents (org_agents provenance satellite) ───────────────────────────

  /**
   * Upsert a shared agent: creates/updates the `agents` row (via the existing
   * upsertAgent path, sourceRef = entry.url, kind = "flue", no deploys row)
   * and the `org_agents` provenance satellite row scoped to orgId.
   *
   * origin is DERIVED: an agent is "org" iff its org_agents row exists.
   * Symmetric with hasDeploy / getDeploy for local agents (ADR-1).
   */
  upsertOrgAgent(entry: SharedAgentEntry, orgId: string): void {
    this.upsertAgent(
      {
        id: entry.id,
        name: entry.name,
        version: entry.version,
        description: entry.description,
        model: entry.model,
      },
      "flue",
      entry.url,
    );
    this.#db
      .prepare(
        `INSERT INTO org_agents (agent_id, org_id, shared_by, target, shared_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           org_id    = excluded.org_id,
           shared_by = excluded.shared_by,
           target    = excluded.target,
           shared_at = excluded.shared_at`,
      )
      .run(entry.id, orgId, entry.sharedBy, entry.target, entry.sharedAt);
  }

  /** Return the org_agents provenance row for this agent id, or null. */
  getOrgAgent(id: string): StoredOrgAgent | null {
    const row = this.#db
      .prepare(`SELECT * FROM org_agents WHERE agent_id = ?`)
      .get(id) as unknown as OrgAgentDbRow | undefined;
    return row ? rowToOrgAgent(row) : null;
  }

  /** All org_agents rows for the given orgId. */
  listOrgAgents(orgId: string): StoredOrgAgent[] {
    const rows = this.#db
      .prepare(`SELECT * FROM org_agents WHERE org_id = ?`)
      .all(orgId) as unknown as OrgAgentDbRow[];
    return rows.map(rowToOrgAgent);
  }

  /** Agent ids that have an org_agents row for the given orgId (used for prune diff). */
  listOrgAgentIds(orgId: string): string[] {
    const rows = this.#db
      .prepare(`SELECT agent_id FROM org_agents WHERE org_id = ?`)
      .all(orgId) as unknown as { agent_id: string }[];
    return rows.map((r) => r.agent_id);
  }

  /**
   * Hard-delete the agents row for this org agent. The ON DELETE CASCADE
   * removes the org_agents satellite row and all sessions/usage automatically.
   * Safety guaranteed by callers sourcing ids exclusively from listOrgAgentIds(orgId).
   */
  deleteOrgAgent(id: string): void {
    this.#db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  }

  /**
   * True when the given id has an org_agents provenance row (i.e. origin is
   * "org"). Used by Core.ts guards (ORG-12): stop/delete/redeploy/config.set
   * on org agents MUST be rejected.
   */
  isOrgAgent(id: string): boolean {
    return !!this.#db.prepare(`SELECT 1 FROM org_agents WHERE agent_id = ?`).get(id);
  }

  // ── Workflows ──────────────────────────────────────────────────────────────

  /** Upsert a workflow by id. The graph (nodes + edges) is stored as JSON. */
  saveWorkflow(wf: Workflow): void {
    const graph = JSON.stringify({ nodes: wf.nodes, edges: wf.edges });
    this.#db
      .prepare(
        `INSERT INTO workflows (id, name, graph_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, graph_json = excluded.graph_json, updated_at = excluded.updated_at`,
      )
      .run(wf.id, wf.name, graph, new Date().toISOString());
  }

  /** All workflows, most recently updated first. Rows with corrupt graph JSON are skipped. */
  listWorkflows(): Workflow[] {
    const rows = this.#db
      .prepare(`SELECT id, name, graph_json FROM workflows ORDER BY updated_at DESC`)
      .all() as unknown as { id: string; name: string; graph_json: string }[];
    const out: Workflow[] = [];
    for (const r of rows) {
      const wf = this.#rowToWorkflow(r);
      if (wf) out.push(wf);
    }
    return out;
  }

  getWorkflow(id: string): Workflow | null {
    const row = this.#db.prepare(`SELECT id, name, graph_json FROM workflows WHERE id = ?`).get(id) as unknown as
      | { id: string; name: string; graph_json: string }
      | undefined;
    return row ? this.#rowToWorkflow(row) : null;
  }

  deleteWorkflow(id: string): void {
    this.#db.prepare(`DELETE FROM workflows WHERE id = ?`).run(id);
  }

  /** Parse a stored row into a Workflow. Returns null (and logs) on corrupt JSON so one bad row can't break the list. */
  #rowToWorkflow(row: { id: string; name: string; graph_json: string }): Workflow | null {
    try {
      const graph = JSON.parse(row.graph_json) as { nodes: Workflow["nodes"]; edges: Workflow["edges"] };
      return { id: row.id, name: row.name, nodes: graph.nodes ?? [], edges: graph.edges ?? [] };
    } catch {
      console.error(`[gateway-state] skipping workflow "${row.id}": corrupt graph_json`);
      return null;
    }
  }

  createWorkflowRun(id: string, workflowId: string, inputs: Record<string, string>): void {
    this.#db
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, status, inputs_json, started_at)
         VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(id, workflowId, JSON.stringify(inputs), new Date().toISOString());
  }

  finishWorkflowRun(id: string, status: string, outputs: Record<string, string>): void {
    this.#db
      .prepare(`UPDATE workflow_runs SET status = ?, outputs_json = ?, ended_at = ? WHERE id = ?`)
      .run(status, JSON.stringify(outputs), new Date().toISOString(), id);
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  createSession(agentId: string, preview = ""): string {
    const id = `sess_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO sessions (id, agent_id, run_id, status, started_at, preview)
         VALUES (?, ?, NULL, 'running', ?, ?)`,
      )
      .run(id, agentId, new Date().toISOString(), preview.slice(0, 80));
    return id;
  }

  endSession(sessionId: string, status: SessionStatus): void {
    this.#db
      .prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), sessionId);
  }

  /** Append a single serialised RunEvent to the session event log. */
  appendSessionEvent(sessionId: string, seq: number, eventJson: string): void {
    this.#db
      .prepare(`INSERT OR IGNORE INTO session_events (session_id, seq, event_json) VALUES (?, ?, ?)`)
      .run(sessionId, seq, eventJson);
  }

  /** Return session summaries for an agent, most recent first. */
  listSessions(agentId: string): SessionSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT id, status, started_at, ended_at, preview
         FROM sessions WHERE agent_id = ? ORDER BY started_at DESC`,
      )
      .all(agentId) as unknown as SessionDbRow[];
    return rows.map((r) => ({
      id: r.id,
      status: r.status as SessionStatus,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      preview: r.preview ?? "",
    }));
  }

  /** Return the stored RunEvents for a session, in emission order. */
  getSessionEvents(sessionId: string): RunEvent[] {
    const rows = this.#db
      .prepare(`SELECT event_json FROM session_events WHERE session_id = ? ORDER BY seq ASC`)
      .all(sessionId) as unknown as { event_json: string }[];
    return rows.map((r) => JSON.parse(r.event_json) as RunEvent);
  }

  /** Return the stored usage + cost for a session (at most one row per session). */
  getSessionUsage(sessionId: string): { usage: Usage; costUsd: number | null } | null {
    const row = this.#db
      .prepare(
        `SELECT input_tokens, output_tokens, total_tokens, model, cost_usd, duration_ms
         FROM usage WHERE session_id = ? LIMIT 1`,
      )
      .get(sessionId) as unknown as UsageDbRow | undefined;
    if (!row) return null;
    return {
      usage: {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
        model: row.model,
        durationMs: row.duration_ms ?? undefined,
      },
      costUsd: row.cost_usd ?? null,
    };
  }

  // ── Usage / metrics ──────────────────────────────────────────────────────

  recordUsage(sessionId: string, runId: string | null, usage: Usage, costUsd: number | null): void {
    this.#db
      .prepare(
        `INSERT INTO usage (session_id, run_id, input_tokens, output_tokens, total_tokens, model, cost_usd, duration_ms, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        runId,
        usage.inputTokens,
        usage.outputTokens,
        usage.totalTokens,
        usage.model,
        costUsd,
        usage.durationMs ?? null,
        new Date().toISOString(),
      );
  }

  /**
   * Aggregate token/cost usage per agent+model, optionally since an ISO
   * timestamp (inclusive; recorded_at is UTC ISO so string compare is sound).
   * cost_usd is NULL for unpriced models: SUM skips NULLs, so costUsd covers
   * only priced rows and unpricedRuns counts the rest. Ordered by cost
   * (priced first, highest spend on top), then by tokens.
   */
  aggregateUsage(since?: string | null): UsageAggregateRow[] {
    const rows = this.#db
      .prepare(
        `SELECT s.agent_id                          AS agent_id,
                a.name                              AS agent_name,
                u.model                             AS model,
                SUM(u.input_tokens)                 AS input_tokens,
                SUM(u.output_tokens)                AS output_tokens,
                SUM(u.total_tokens)                 AS total_tokens,
                SUM(u.cost_usd)                     AS cost_usd,
                COUNT(*)                            AS runs,
                COUNT(*) - COUNT(u.cost_usd)        AS unpriced_runs
         FROM usage u
         JOIN sessions s ON s.id = u.session_id
         JOIN agents   a ON a.id = s.agent_id
         WHERE (? IS NULL OR u.recorded_at >= ?)
         GROUP BY s.agent_id, u.model
         ORDER BY (cost_usd IS NULL) ASC, cost_usd DESC, total_tokens DESC`,
      )
      .all(since ?? null, since ?? null) as unknown as UsageAggregateDbRow[];
    return rows.map((r) => ({
      agentId: r.agent_id,
      agentName: r.agent_name,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.total_tokens,
      costUsd: r.cost_usd ?? null,
      runs: r.runs,
      unpricedRuns: r.unpriced_runs,
    }));
  }
}

/** One aggregated usage row (per agent+model). */
export interface UsageAggregateRow {
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

interface UsageAggregateDbRow {
  agent_id: string;
  agent_name: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  runs: number;
  unpriced_runs: number;
}

interface AgentDbRow {
  id: string;
  name: string;
  version: string;
  description: string;
  model: string;
  kind: string;
  source_ref: string;
  created_at: string;
  updated_at: string;
}

interface ConfigDbRow {
  agent_id: string;
  model_specifier: string | null;
  parameters_json: string | null;
  updated_at: string;
}

interface DeployDbRow {
  agent_id: string;
  source_dir: string;
  provider: string | null;
  model: string | null;
  target: string;
  repo_owner: string | null;
  log: string | null;
  updated_at: string;
}

interface SessionDbRow {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  preview: string | null;
}

interface UsageDbRow {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  model: string;
  cost_usd: number | null;
  duration_ms: number | null;
}

function rowToAgent(row: AgentDbRow): StoredAgent {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    model: row.model,
    kind: row.kind as AgentKind,
    sourceRef: row.source_ref,
    updatedAt: row.updated_at,
  };
}

interface OrgAgentDbRow {
  agent_id: string;
  org_id: string;
  shared_by: string;
  target: string;
  shared_at: string;
}

function rowToOrgAgent(row: OrgAgentDbRow): StoredOrgAgent {
  return {
    agentId: row.agent_id,
    orgId: row.org_id,
    sharedBy: row.shared_by,
    target: row.target,
    sharedAt: row.shared_at,
  };
}
