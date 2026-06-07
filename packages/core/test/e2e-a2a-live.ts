/**
 * LIVE E2E — drives the real A2AAdapter against a REAL DeepAgents agent
 * (soporte-facturacion) running over A2A at http://127.0.0.1:8080.
 *
 * This is NOT a smoke test (no mock). It proves the migrated Gateway path
 * end-to-end against a live agent: Agent Card discovery → sendMessageStream
 * (real SSE) → neutral RunEvents (message.delta / tool.call / tool.result /
 * subagent.*) → done(completed) → real usage from metadata["inteliside/usage"].
 *
 * Requires the agent server to be up. Run:
 *   pnpm --filter @inteliside/gateway-core exec tsx test/e2e-a2a-live.ts
 */

import { A2AAdapter } from "../src/adapters/a2a.js";
import type { RunEvent, RunStatus, Usage } from "../src/neutral.js";

const AGENT_URL = process.env.E2E_AGENT_URL ?? "http://127.0.0.1:8080";
const MESSAGE =
  process.env.E2E_MESSAGE ??
  "Hola, tengo la factura INV-1001. ¿Puedo pedir un reembolso? Decime el estado y si califica.";

function line(s: string): void {
  process.stdout.write(s + "\n");
}

async function main(): Promise<void> {
  line(`→ connecting to live A2A agent at ${AGENT_URL}`);
  const adapter = await A2AAdapter.connect(AGENT_URL);
  const info = adapter.info();
  line(`✓ Agent Card discovered: "${info.name}" v${info.version}`);
  line(`→ sending: ${MESSAGE}\n`);

  const events: RunEvent[] = [];
  let status: RunStatus | undefined;
  let usage: Usage | null = null;
  const started = Date.now();

  await new Promise<void>((resolve, reject) => {
    adapter.run(
      { messages: [{ role: "user", content: MESSAGE }] },
      {},
      {
        onEvent: (e) => {
          events.push(e);
          switch (e.type) {
            case "message.delta":
              process.stdout.write(e.content);
              break;
            case "message.completed":
              break;
            case "tool.call":
              line(`\n  ⚙ tool.call ${e.name}(${JSON.stringify(e.input)})`);
              break;
            case "tool.result":
              line(`  ✓ tool.result ${e.name} → ${typeof e.output === "string" ? e.output : JSON.stringify(e.output)}`);
              break;
            case "subagent.start":
              line(`\n  ↳ subagent.start ${e.name}`);
              break;
            case "subagent.end":
              line(`  ↳ subagent.end ${e.name}`);
              break;
            case "interrupt":
              line(`\n  ⏸ interrupt: ${e.reason}`);
              break;
            default:
              break;
          }
        },
        onDone: (s, u) => {
          status = s;
          usage = u;
          resolve();
        },
        onError: (code, message) => reject(new Error(`${code}: ${message}`)),
      },
    );
  });

  const ms = Date.now() - started;
  line(`\n\n──────── RESULT ────────`);
  line(`status     : ${status}`);
  line(`wall time  : ${ms} ms`);
  line(`event count: ${events.length}`);
  const kinds = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});
  line(`event kinds: ${JSON.stringify(kinds)}`);
  if (usage) {
    const u = usage as Usage;
    line(`usage      : ${u.totalTokens} tok (in ${u.inputTokens} / out ${u.outputTokens}) · model ${u.model}`);
  } else {
    line(`usage      : (none)`);
  }

  // Assertions that prove the live path actually worked.
  const ok =
    status === "completed" &&
    events.some((e) => e.type === "message.delta") &&
    usage !== null &&
    (usage as Usage).totalTokens > 0;

  await adapter.close();
  line(ok ? "\n✅ LIVE E2E PASSED" : "\n❌ LIVE E2E FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\n❌ LIVE E2E ERROR:", err);
  process.exit(1);
});
