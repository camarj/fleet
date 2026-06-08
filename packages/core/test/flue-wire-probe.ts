/**
 * WS0 live wire probe — proves the FlueAdapter talks to a REAL served Flue agent
 * over Flue's HTTP streaming API (agents.invoke mode:"stream") and that the
 * FlueEvent stream maps to neutral RunEvents end-to-end. No API key: the fixture
 * agent points at a local mock that speaks the OpenAI Chat Completions streaming API.
 *
 * Steps: start mock model server → `flue dev` the fixture → FlueAdapter.connect →
 * run a prompt and print mapped events + usage → test abort → tear down.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/flue-wire-probe.ts
 */

import { createServer, type Server } from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { FlueAdapter } from "../src/adapters/flue.js";
import type { RunEvent } from "../src/neutral.js";

const FLUE_PORT = 3583;
const MOCK_PORT = 5599;
const BASE_URL = `http://127.0.0.1:${FLUE_PORT}`;
const ROOT = "test/fixtures/flue-agent";

// ── Mock OpenAI Chat Completions (streaming) ────────────────────────────────────
function startMock(): Server {
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) =>
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: 0,
            model: "echo-model",
            choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }],
            ...(usage ? { usage } : {}),
          })}\n\n`,
        );
      chunk({ role: "assistant", content: "Echo: " });
      chunk({ content: "transport works" });
      chunk({}, "stop");
      chunk({}, null, { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.listen(MOCK_PORT, "127.0.0.1");
  return server;
}

// ── Build the fixture, then run the production-style server (node dist/server.mjs).
// `flue dev` runs in "local mode" which does not expose the same HTTP/WS agent
// routes; a deployed Flue agent — what FlueAdapter connects to — is the built
// server. (A Flue agent is only routable if its module exports route/websocket.)
function buildFixture(): void {
  const r = spawnSync("pnpm", ["exec", "flue", "build", "--root", ROOT], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("flue build failed");
}

function startFlueServer(): ChildProcess {
  const child = spawn("node", ["dist/server.mjs"], {
    cwd: `${process.cwd()}/${ROOT}`,
    detached: true,
    env: { ...process.env, PORT: String(FLUE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[flue] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[flue:err] ${d}`));
  return child;
}

async function waitForReady(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any HTTP response (even 404) means the dev server is listening. The
      // admin route may be disabled in dev, so we don't depend on it here.
      await fetch(`${BASE_URL}/`);
      return;
    } catch {
      /* connection refused — not up yet */
    }
    await sleep(500);
  }
  throw new Error("flue dev did not become ready in time");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(label: string, ...rest: unknown[]): void {
  console.log(`\x1b[36m${label}\x1b[0m`, ...rest);
}

async function main(): Promise<void> {
  const mock = startMock();
  log("building fixture …");
  buildFixture();
  const flue = startFlueServer();
  let failed = false;

  try {
    log("waiting for flue server …");
    await waitForReady();
    log("flue server ready ✓");

    const adapter = await FlueAdapter.connect({ baseUrl: BASE_URL, agentName: "echo" });
    log("connected", JSON.stringify(adapter.info()));

    // ── 1) Normal run ──
    const events: RunEvent[] = [];
    let doneStatus = "";
    const handle = adapter.run(
      { messages: [{ role: "user", content: "ping" }] },
      {},
      {
        onEvent: (e) => {
          events.push(e);
          log("EVENT", JSON.stringify(e));
        },
        onUsage: (u) => log("USAGE", JSON.stringify(u)),
        onDone: (status, usage) => {
          doneStatus = status;
          log("DONE", status, JSON.stringify(usage));
        },
        onError: (code, msg) => log("ERROR", code, msg),
      },
    );
    await handle.done;

    const sawText = events.some((e) => e.type === "message.delta" && e.content.includes("transport works"));
    assert(sawText, "text_delta → message.delta reached the sink over the real HTTP stream");
    assert(doneStatus === "completed", "prompt() resolution → onDone(completed)");

    // ── 2) Abort ──
    log("testing abort …");
    let abortStatus = "";
    const h2 = adapter.run(
      { messages: [{ role: "user", content: "ping again" }] },
      {},
      { onDone: (s) => (abortStatus = s), onError: (c, m) => log("abort-run error", c, m) },
    );
    await h2.abort();
    await h2.done;
    assert(abortStatus === "aborted" || abortStatus === "", `abort → done status was "${abortStatus}"`);
    log("abort path exercised (status:", abortStatus || "n/a", ")");

    await adapter.close();
    log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  } catch (err) {
    failed = true;
    console.error("PROBE ERROR:", err);
  } finally {
    mock.close();
    if (flue.pid) {
      try {
        process.kill(-flue.pid, "SIGTERM");
      } catch {
        flue.kill("SIGTERM");
      }
    }
    await sleep(500);
    process.exit(failed || process.exitCode ? 1 : 0);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

main();
