/**
 * ACP client smoke test — drives the real AcpAdapter against a Node fake ACP
 * agent (spawned as a subprocess over stdio). No Python, no API key. Proves:
 * spawn → initialize → newSession → prompt → sessionUpdate→neutral events →
 * stopReason→done → usage from _meta["inteliside_usage"].
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/acp.test.ts
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAdapter } from "../src/adapters/acp.js";
import type { RunEvent, RunStatus, Usage } from "../src/neutral.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeAgent = join(here, "fake-acp-agent.ts");

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

async function main(): Promise<void> {
  const adapter = await AcpAdapter.launch({
    cwd: here,
    command: process.execPath,
    args: ["--import", "tsx", fakeAgent],
    id: "fake-acp",
    name: "Fake ACP Agent",
  });
  assert(adapter.info().id === "fake-acp", "adapter launched + initialized");

  const events: RunEvent[] = [];
  let status: RunStatus | undefined;
  let usage: Usage | null = null;

  await new Promise<void>((resolve, reject) => {
    adapter.run(
      { messages: [{ role: "user", content: "hi" }] },
      {},
      {
        onEvent: (e) => events.push(e),
        onDone: (s, u) => {
          status = s;
          usage = u;
          resolve();
        },
        onError: (code, message) => reject(new Error(`${code}: ${message}`)),
      },
    );
  });

  assert(
    events.some((e) => e.type === "message.delta" && e.content.includes("Hello")),
    "session/update agent_message_chunk → neutral message.delta",
  );
  assert(status === "completed", "stopReason end_turn → done(completed)");
  assert(usage !== null && (usage as Usage).totalTokens === 7, "usage read from _meta[inteliside_usage]");

  await adapter.close();
  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
