/**
 * WU-06 acceptance test — session history persistence and replay.
 *
 * Proves via two levels:
 *
 * Level 1 — DB helpers: create a session, append events, record usage, then
 * verify that listSessions / getSessionEvents / getSessionUsage return the
 * right data (no running agent required).
 *
 * Level 2 — Persistence across instances: close GatewayState and open a
 * second instance against the same file to confirm real on-disk persistence
 * (not in-memory).
 *
 * Level 3 — Core API handlers: open a SECOND GatewayCore against the same DB
 * file and exercise sessions.list / session.history through the public
 * handle() interface.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/session-history.test.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".session-history-test");
const DB_PATH = join(DATA_DIR, "fleet.db");
process.env.GATEWAY_DATA_DIR = DATA_DIR;

const { GatewayState } = await import("../src/state/db.js");
const { GatewayCore } = await import("../src/core.js");
import type { ServerEvent } from "../src/api.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  // ── Level 1: DB helpers ────────────────────────────────────────────────────

  console.log("\n[1] DB helpers …");

  const state1 = new GatewayState(DB_PATH);

  // Register a dummy agent so foreign-key constraints pass.
  const stored = state1.upsertAgent(
    { id: "test-agent-hist", name: "hist-test", version: "1.0.0", description: "", model: "anthropic/claude-sonnet-4-6" },
    "flue",
    "http://localhost:19999",
  );

  const previewInput = "Hello, can you help me write a unit test for this function?";
  const sessionId = state1.createSession(stored.id, previewInput);

  // Append a small sequence of synthetic events (same shapes as the real wire).
  const eventsToStore = [
    { type: "thinking.start" },
    { type: "thinking.end", content: "Let me help you." },
    { type: "message.delta", role: "assistant", content: "Sure!" },
    { type: "message.completed", role: "assistant", content: "Sure!" },
  ];
  for (let seq = 0; seq < eventsToStore.length; seq++) {
    state1.appendSessionEvent(sessionId, seq, JSON.stringify(eventsToStore[seq]));
  }

  state1.recordUsage(
    sessionId,
    null,
    { inputTokens: 10, outputTokens: 5, totalTokens: 15, model: "anthropic/claude-sonnet-4-6" },
    0.00025,
  );
  state1.endSession(sessionId, "completed");

  const sessions = state1.listSessions(stored.id);
  assert(sessions.length === 1, "listSessions returns one session");
  assert(sessions[0].id === sessionId, "listSessions returns the correct session id");
  assert(sessions[0].status === "completed", "listSessions returns correct status");
  assert(
    sessions[0].preview === previewInput.slice(0, 80),
    `preview stored correctly (got: "${sessions[0].preview}")`,
  );
  assert(sessions[0].endedAt !== null, "endedAt set after endSession");

  const storedEvents = state1.getSessionEvents(sessionId);
  assert(storedEvents.length === eventsToStore.length, `getSessionEvents returns ${eventsToStore.length} events`);
  assert(storedEvents[0].type === "thinking.start", "first event is thinking.start");
  assert(storedEvents[3].type === "message.completed", "last event is message.completed");

  const usageRow = state1.getSessionUsage(sessionId);
  assert(usageRow !== null, "getSessionUsage returns a row");
  assert(usageRow!.usage.totalTokens === 15, "usage.totalTokens = 15");
  assert(usageRow!.usage.model === "anthropic/claude-sonnet-4-6", "usage.model correct");
  assert(Math.abs((usageRow!.costUsd ?? -1) - 0.00025) < 1e-9, "costUsd correct");

  state1.close();

  // ── Level 2: Persistence across GatewayState instances ────────────────────

  console.log("\n[2] Persistence across GatewayState instances …");

  const state2 = new GatewayState(DB_PATH);
  const sessions2 = state2.listSessions(stored.id);
  assert(sessions2.length === 1, "sessions persist after reopening the DB");
  const events2 = state2.getSessionEvents(sessionId);
  assert(events2.length === eventsToStore.length, "events persist after reopening the DB");
  assert(events2[0].type === "thinking.start", "first persisted event type correct");
  state2.close();

  // ── Level 3: Core API handlers via second GatewayCore instance ─────────────

  console.log("\n[3] Core API handlers (sessions.list, session.history) …");

  const core = new GatewayCore({ dbPath: DB_PATH });
  const apiEvents: ServerEvent[] = [];
  const emit = (e: ServerEvent) => apiEvents.push(e);

  await core.handle({ type: "sessions.list", agentId: stored.id }, emit);
  const sessionsResp = apiEvents.find(
    (e): e is Extract<ServerEvent, { type: "sessions" }> => e.type === "sessions",
  );
  assert(!!sessionsResp, "sessions.list responds with a 'sessions' event");
  assert(sessionsResp!.agentId === stored.id, "sessions event carries correct agentId");
  assert(sessionsResp!.sessions.length === 1, "sessions.list returns one session");
  assert(
    sessionsResp!.sessions[0].preview === previewInput.slice(0, 80),
    "sessions.list preview is correct",
  );

  apiEvents.length = 0;
  await core.handle({ type: "session.history", sessionId }, emit);
  const histResp = apiEvents.find(
    (e): e is Extract<ServerEvent, { type: "session.history" }> => e.type === "session.history",
  );
  assert(!!histResp, "session.history responds with a 'session.history' event");
  assert(histResp!.sessionId === sessionId, "session.history carries correct sessionId");
  assert(histResp!.events.length === eventsToStore.length, "session.history returns all events");
  assert(histResp!.events[0].type === "thinking.start", "first returned event is thinking.start");
  assert(histResp!.usage !== null, "session.history returns usage");
  assert(histResp!.usage!.totalTokens === 15, "session.history usage.totalTokens = 15");
  assert(histResp!.costUsd !== null, "session.history costUsd present");

  await core.shutdown();

  // ── Done ───────────────────────────────────────────────────────────────────

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
