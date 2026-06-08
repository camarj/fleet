/**
 * Flue mapping smoke test — drives the pure `mapFlueEvent` mapper against
 * synthetic FlueEvents (the `@flue/sdk` 0.10.x shape). Proves: text_delta →
 * message.delta, thinking_* → thinking.*, MCP-named tools → mcp.* vs plain
 * tools → tool.*, operation(skill) → skill.*, compaction → memory.*, task →
 * subagent.*, and usage aggregation from operation/turn events.
 *
 * The live WebSocket transport against a served Flue agent is the WS0 probe.
 * This test needs neither network nor an API key.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/flue.test.ts
 */

import { mapFlueEvent, parseMcpTool, UsageAccumulator } from "../src/adapters/flue.js";
import type { FlueEvent } from "@flue/sdk";
import type { RunEvent } from "../src/neutral.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

const USAGE = { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Map a list of synthetic FlueEvents and collect the neutral events + usage. */
function run(...events: unknown[]) {
  const out: RunEvent[] = [];
  const accum = new UsageAccumulator();
  for (const ev of events) mapFlueEvent(ev as FlueEvent, { onEvent: (e) => out.push(e) }, accum);
  return { out, usage: accum.total() };
}

function main(): void {
  // text_delta → message.delta (assistant)
  const text = run({ type: "text_delta", text: "Hola" });
  assert(
    text.out.some((e) => e.type === "message.delta" && e.role === "assistant" && e.content === "Hola"),
    "text_delta → message.delta (assistant)",
  );

  // thinking_* → thinking.*
  const think = run(
    { type: "thinking_start" },
    { type: "thinking_delta", delta: "let me" },
    { type: "thinking_end", content: "let me think" },
  );
  assert(think.out[0]?.type === "thinking.start", "thinking_start → thinking.start");
  assert(think.out[1]?.type === "thinking.delta" && think.out[1].content === "let me", "thinking_delta → thinking.delta");
  assert(think.out[2]?.type === "thinking.end" && think.out[2].content === "let me think", "thinking_end → thinking.end");

  // plain tool → tool.call / tool.result
  const tool = run(
    { type: "tool_start", toolName: "lookup_order", toolCallId: "c1", args: { id: 7 } },
    { type: "tool_call", toolName: "lookup_order", toolCallId: "c1", isError: false, result: "shipped", durationMs: 10 },
  );
  assert(
    tool.out[0]?.type === "tool.call" && tool.out[0].id === "c1" && tool.out[0].name === "lookup_order",
    "tool_start (plain) → tool.call",
  );
  assert(tool.out[1]?.type === "tool.result" && tool.out[1].output === "shipped", "tool_call (plain) → tool.result");

  // MCP-named tool → mcp.call / mcp.result with server/name split
  const mcp = run(
    { type: "tool_start", toolName: "mcp__inventory__lookup_item", toolCallId: "m1", args: { sku: "x" } },
    { type: "tool_call", toolName: "mcp__inventory__lookup_item", toolCallId: "m1", isError: true, result: "boom", durationMs: 3 },
  );
  assert(
    mcp.out[0]?.type === "mcp.call" && mcp.out[0].server === "inventory" && mcp.out[0].name === "lookup_item",
    "tool_start (mcp__server__tool) → mcp.call with server/name",
  );
  assert(mcp.out[1]?.type === "mcp.result" && mcp.out[1].isError === true, "tool_call (mcp) → mcp.result (isError preserved)");

  // task_* → subagent.* (prefers agent name, falls back to taskId)
  const sub = run(
    { type: "task_start", taskId: "t1", prompt: "go", agent: "reviewer" },
    { type: "task", taskId: "t1", agent: "reviewer", isError: false, result: "ok", durationMs: 20 },
    { type: "task_start", taskId: "t2", prompt: "go" },
  );
  assert(sub.out[0]?.type === "subagent.start" && sub.out[0].name === "reviewer", "task_start → subagent.start (agent name)");
  assert(sub.out[1]?.type === "subagent.end" && sub.out[1].name === "reviewer", "task → subagent.end");
  assert(sub.out[2]?.type === "subagent.start" && sub.out[2].name === "t2", "task_start without agent → subagent.start (taskId)");

  // operation(skill) → skill.* ; operation usage aggregates
  const skill = run(
    { type: "operation_start", operationId: "op1", operationKind: "skill" },
    { type: "operation", operationId: "op1", operationKind: "skill", durationMs: 12, isError: false, usage: USAGE },
  );
  assert(skill.out[0]?.type === "skill.start" && skill.out[0].id === "op1", "operation_start(skill) → skill.start");
  assert(
    skill.out[1]?.type === "skill.end" && skill.out[1].durationMs === 12 && skill.out[1].isError === false,
    "operation(skill) → skill.end",
  );
  assert(skill.usage.totalTokens === 7, "operation.usage aggregated into total");

  // operation(prompt) is not a skill event but still feeds usage
  const promptOp = run({ type: "operation", operationId: "op2", operationKind: "prompt", durationMs: 5, isError: false, usage: USAGE });
  assert(promptOp.out.length === 0, "operation(prompt) emits no neutral block");
  assert(promptOp.usage.totalTokens === 7 && promptOp.usage.inputTokens === 5, "operation(prompt).usage aggregated");

  // compaction_* → memory.*
  const mem = run(
    { type: "compaction_start", reason: "threshold", estimatedTokens: 1000 },
    { type: "compaction", messagesBefore: 40, messagesAfter: 12, durationMs: 30 },
  );
  assert(mem.out[0]?.type === "memory.start" && mem.out[0].reason === "threshold", "compaction_start → memory.start");
  assert(
    mem.out[1]?.type === "memory.end" && mem.out[1].messagesBefore === 40 && mem.out[1].messagesAfter === 12,
    "compaction → memory.end",
  );

  // turn records the model specifier (provider/model) without double-counting tokens
  const turn = run(
    { type: "turn", turnId: "x", purpose: "agent", durationMs: 9, model: "claude-sonnet-4-6", provider: "anthropic", isError: false },
    { type: "operation", operationId: "op3", operationKind: "prompt", durationMs: 9, isError: false, usage: USAGE },
  );
  assert(turn.usage.model === "anthropic/claude-sonnet-4-6", "turn → model specifier provider/model");
  assert(turn.usage.totalTokens === 7, "turn does not add tokens (usage only from operation)");

  // lifecycle/no-op events produce nothing
  const noop = run({ type: "agent_start" }, { type: "turn_start", turnId: "x", purpose: "agent" }, { type: "idle" });
  assert(noop.out.length === 0, "agent_start/turn_start/idle → no neutral events");

  // parseMcpTool unit
  assert(parseMcpTool("mcp__db__query")?.server === "db", "parseMcpTool splits server");
  assert(parseMcpTool("plain_tool") === null, "parseMcpTool returns null for non-MCP names");

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
}

main();
