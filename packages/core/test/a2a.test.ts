/**
 * A2A mapping smoke test — drives the real `consumeStream` mapper against
 * synthetic StreamResponse payloads (the `@a2a-js/sdk` 1.x proto shape). Proves:
 * artifact/message text → neutral message.delta, usage read from
 * metadata["inteliside/usage"], and terminal TaskState → status.
 *
 * The real HTTP/SSE transport against a live agent is covered by
 * test/e2e-a2a-live.ts (needs a running agent). This test needs neither network
 * nor an API key.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/a2a.test.ts
 */

import { TaskState, type StreamResponse } from "@a2a-js/sdk";
import { consumeStream } from "../src/adapters/a2a.js";
import type { RunEvent } from "../src/neutral.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

const USAGE = { inputTokens: 5, outputTokens: 2, totalTokens: 7, model: "anthropic/claude-sonnet-4-6" };

function textPart(text: string) {
  return { content: { $case: "text" as const, value: text }, metadata: undefined, filename: "", mediaType: "text/plain" };
}

async function* stream(...responses: StreamResponse[]): AsyncGenerator<StreamResponse> {
  for (const r of responses) yield r;
}

/** Collect the neutral events a stream produces. */
async function run(...responses: StreamResponse[]) {
  const events: RunEvent[] = [];
  const outcome = await consumeStream(stream(...responses), { onEvent: (e) => events.push(e) });
  return { events, outcome };
}

async function main(): Promise<void> {
  // A typical successful run: task → artifact(text) → status completed + usage.
  const ok = await run(
    { payload: { $case: "task", value: { id: "t1" } } } as unknown as StreamResponse,
    {
      payload: {
        $case: "artifactUpdate",
        value: { taskId: "t1", artifact: { parts: [textPart("Hello from A2A")] } },
      },
    } as unknown as StreamResponse,
    {
      payload: {
        $case: "statusUpdate",
        value: { taskId: "t1", status: { state: TaskState.TASK_STATE_COMPLETED }, metadata: { "inteliside/usage": USAGE } },
      },
    } as unknown as StreamResponse,
  );

  assert(ok.outcome.taskId === "t1", "task payload → taskId captured");
  assert(
    ok.events.some((e) => e.type === "message.delta" && e.content.includes("Hello from A2A")),
    "artifact text part → neutral message.delta",
  );
  assert(ok.outcome.status === "completed" && !ok.outcome.failed, "TaskState COMPLETED → status completed");
  assert(ok.outcome.usage?.totalTokens === 7, "usage read from metadata[inteliside/usage]");

  // A message payload also yields a delta and can carry usage.
  const msg = await run({
    payload: {
      $case: "message",
      value: { parts: [textPart("hi there")], metadata: { "inteliside/usage": USAGE } },
    },
  } as unknown as StreamResponse);
  assert(
    msg.events.some((e) => e.type === "message.delta" && e.content === "hi there"),
    "message payload text → neutral message.delta",
  );

  // Canceled → aborted.
  const canceled = await run({
    payload: { $case: "statusUpdate", value: { taskId: "t1", status: { state: TaskState.TASK_STATE_CANCELED } } },
  } as unknown as StreamResponse);
  assert(canceled.outcome.status === "aborted", "TaskState CANCELED → status aborted");

  // Failed → failed flag.
  const failed = await run({
    payload: { $case: "statusUpdate", value: { taskId: "t1", status: { state: TaskState.TASK_STATE_FAILED } } },
  } as unknown as StreamResponse);
  assert(failed.outcome.failed, "TaskState FAILED → failed");

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
