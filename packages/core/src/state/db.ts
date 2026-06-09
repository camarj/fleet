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

/** The original deploy inputs, kept so an agent can be redeployed in one click. */
export interface DeployParams {
  sourceDir: string;
  provider: string | null;
  model: string | null;
  target: string;
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
        `INSERT INTO deploys (agent_id, source_dir, provider, model, target, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           source_dir = excluded.source_dir,
           provider = excluded.provider,
           model = excluded.model,
           target = excluded.target,
           updated_at = excluded.updated_at`,
      )
      .run(agentId, params.sourceDir, params.provider, params.model, params.target, now);
  }

  getDeploy(agentId: string): DeployParams | null {
    const row = this.#db.prepare(`SELECT * FROM deploys WHERE agent_id = ?`).get(agentId) as unknown as
      | DeployDbRow
      | undefined;
    if (!row) return null;
    return { sourceDir: row.source_dir, provider: row.provider, model: row.model, target: row.target };
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
   * Hard-delete an agent row. The schema's ON DELETE CASCADE removes all child
   * rows (configs, deploys, sessions, usage) automatically.
   */
  deleteAgent(id: string): void {
    this.#db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
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
