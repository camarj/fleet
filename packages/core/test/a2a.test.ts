/**
 * A2aAdapter test (pivote A1, issue #70) — mirrors flue.test.ts.
 *
 * Two levels, no network, no LLM:
 *   1. Pure `mapA2aEvent` against synthetic A2A events (text mapping + usage).
 *   2. `A2aAdapter.run()` against an injected FAKE A2aClient: a completed task,
 *      a failed task → neutral error, and abort → `tasks/cancel` + aborted done.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/a2a.test.ts
 */

import { A2aAdapter, mapA2aEvent } from "../src/adapters/foreign/a2a.js";
import { UsageAccumulator } from "../src/adapters/neutral-mapping.js";
import type { A2aClient, A2aMessage, A2aStreamEvent } from "../src/adapters/foreign/a2a-types.js";
import type { RunEvent, RunSink, Usage, RunStatus, RuntimeErrorCode } from "../src/neutral.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

/** Map a list of synthetic A2A events and collect the neutral events + usage. */
function mapAll(...events: A2aStreamEvent[]): { out: RunEvent[]; usage: Usage } {
  const out: RunEvent[] = [];
  const accum = new UsageAccumulator();
  for (const ev of events) mapA2aEvent(ev, { onEvent: (e) => out.push(e) }, accum);
  return { out, usage: accum.total() };
}

/** A fake A2aClient that yields a scripted event sequence and records cancels. */
class FakeA2aClient implements A2aClient {
  cancelled: string[] = [];
  constructor(
    private readonly script: A2aStreamEvent[],
    private readonly opts: { hang?: boolean } = {},
  ) {}

  async *sendMessageStream(params: { message: A2aMessage; signal?: AbortSignal }): AsyncIterable<A2aStreamEvent> {
    for (const ev of this.script) {
      if (params.signal?.aborted) return;
      yield ev;
    }
    if (this.opts.hang) {
      // Simulate an agent that keeps the stream open until aborted.
      await new Promise<void>((resolve) => {
        params.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
  async cancelTask(taskId: string): Promise<void> {
    this.cancelled.push(taskId);
  }
  async getAgentCard(): Promise<null> {
    return null;
  }
}

/** Collect a run's sink outcome. */
function collect(): { sink: RunSink; events: RunEvent[]; done: Promise<{ status?: RunStatus; error?: { code: RuntimeErrorCode; message: string } }> } {
  const events: RunEvent[] = [];
  let resolve!: (v: { status?: RunStatus; error?: { code: RuntimeErrorCode; message: string } }) => void;
  const done = new Promise<{ status?: RunStatus; error?: { code: RuntimeErrorCode; message: string } }>((r) => (resolve = r));
  const sink: RunSink = {
    onEvent: (e) => events.push(e),
    onDone: (status) => resolve({ status }),
    onError: (code, message) => resolve({ error: { code, message } }),
  };
  return { sink, events, done };
}

const USAGE_META = { "inteliside/usage": { input: 5, output: 2, totalTokens: 7 } };

async function main(): Promise<void> {
  // ── Level 1: pure mapper ────────────────────────────────────────────────────
  console.log("\n[1] mapA2aEvent — agent message text → message.delta …");
  const m = mapAll({ kind: "message", role: "agent", messageId: "m1", parts: [{ kind: "text", text: "Hola" }], metadata: USAGE_META });
  assert(
    m.out.some((e) => e.type === "message.delta" && e.role === "assistant" && e.content === "Hola"),
    "agent message → message.delta (assistant)",
  );
  assert(m.usage.totalTokens === 7 && m.usage.inputTokens === 5, "usage read from inteliside/usage metadata");

  console.log("\n[2] mapA2aEvent — a user message is not surfaced …");
  const u = mapAll({ kind: "message", role: "user", messageId: "u1", parts: [{ kind: "text", text: "ping" }] });
  assert(u.out.length === 0, "user-role message emits no neutral event");

  console.log("\n[3] mapA2aEvent — status-update + artifact-update text → message.delta …");
  const s = mapAll(
    { kind: "status-update", taskId: "t1", contextId: "c1", final: false, status: { state: "working", message: { kind: "message", role: "agent", messageId: "s1", parts: [{ kind: "text", text: "thinking…" }] } } },
    { kind: "artifact-update", taskId: "t1", contextId: "c1", artifact: { artifactId: "a1", parts: [{ kind: "text", text: "answer" }] }, lastChunk: true },
  );
  assert(s.out[0]?.type === "message.delta" && s.out[0].content === "thinking…", "status-update message text → message.delta");
  assert(s.out[1]?.type === "message.delta" && s.out[1].content === "answer", "artifact-update text → message.delta");

  // ── Level 2: A2aAdapter.run against a fake server ───────────────────────────
  console.log("\n[4] run() — a completed task streams text then done:completed …");
  {
    const client = new FakeA2aClient([
      { kind: "status-update", taskId: "t1", contextId: "c1", final: false, status: { state: "working", message: { kind: "message", role: "agent", messageId: "w1", parts: [{ kind: "text", text: "working " }] } } },
      { kind: "artifact-update", taskId: "t1", contextId: "c1", artifact: { artifactId: "a1", parts: [{ kind: "text", text: "done!" }] }, lastChunk: true },
      { kind: "status-update", taskId: "t1", contextId: "c1", final: true, status: { state: "completed", message: { kind: "message", role: "agent", messageId: "f1", parts: [], metadata: USAGE_META } } },
    ]);
    const adapter = new A2aAdapter(client, { id: "x", name: "x", version: "", description: "" });
    const { sink, events, done } = collect();
    adapter.run({ messages: [{ role: "user", content: "hi" }] }, {}, sink);
    const res = await done;
    assert(res.status === "completed", "completed task → onDone('completed')");
    const text = events.filter((e): e is Extract<RunEvent, { type: "message.delta" }> => e.type === "message.delta").map((e) => e.content).join("");
    assert(text === "working done!", `streamed text accumulates ("${text}")`);
  }

  console.log("\n[5] run() — a failed task → neutral onError …");
  {
    const client = new FakeA2aClient([
      { kind: "status-update", taskId: "t2", contextId: "c2", final: true, status: { state: "failed", message: { kind: "message", role: "agent", messageId: "e1", parts: [{ kind: "text", text: "boom" }] } } },
    ]);
    const adapter = new A2aAdapter(client, { id: "x", name: "x", version: "", description: "" });
    const { sink, done } = collect();
    adapter.run({ messages: [{ role: "user", content: "hi" }] }, {}, sink);
    const res = await done;
    assert(res.error?.code === "model_error", "failed task → onError('model_error')");
    assert(res.error?.message === "boom", "failure message carries the agent's status text");
  }

  console.log("\n[6] run() — abort stops the stream and requests tasks/cancel …");
  {
    const client = new FakeA2aClient(
      [{ kind: "status-update", taskId: "t3", contextId: "c3", final: false, status: { state: "working", message: { kind: "message", role: "agent", messageId: "w3", parts: [{ kind: "text", text: "…" }] } } }],
      { hang: true },
    );
    const adapter = new A2aAdapter(client, { id: "x", name: "x", version: "", description: "" });
    const { sink, done } = collect();
    const handle = adapter.run({ messages: [{ role: "user", content: "hi" }] }, {}, sink);
    await new Promise((r) => setTimeout(r, 20)); // let the first event flow + reach the hang
    await handle.abort();
    const res = await done;
    assert(res.status === "aborted", "abort → onDone('aborted')");
    assert(client.cancelled.includes("t3"), "abort requested tasks/cancel for the tracked task id");
  }

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main();
