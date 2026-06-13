/**
 * K3 — workflow output cap: unit tests for the capWorkflowOutput helper.
 *
 * workflow.test.ts has no fake-adapter precedent (it only exercises agent-free
 * workflows), so driving #agentRunner through GatewayCore would require injecting
 * a fake adapter via production-code changes beyond core.ts. The plan's fallback
 * route is taken instead: extract the truncation into capWorkflowOutput (pure
 * function, no class state) and unit-test it directly.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/workflow-output-cap.test.ts
 */

import { capWorkflowOutput } from "../src/core.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

const MARKER = "\n…[output truncated by Fleet: exceeded GATEWAY_WORKFLOW_OUTPUT_CAP_BYTES]";
const CAP = 100;

console.log("\n[K3] capWorkflowOutput — output cap helper …");

// 1. Under-cap: text shorter than cap is returned unchanged, no marker.
{
  const short = "hello world";
  const result = capWorkflowOutput(short, CAP);
  assert(result === short, "K3: under-cap text is returned unchanged");
  assert(!result.includes(MARKER), "K3: marker is absent when text is under cap");
}

// 2. Exact-cap: text whose length equals the cap is NOT truncated.
{
  const exact = "x".repeat(CAP);
  const result = capWorkflowOutput(exact, CAP);
  assert(result === exact, "K3: text at exactly the cap boundary is not truncated");
  assert(!result.includes(MARKER), "K3: marker is absent when text length equals cap exactly");
}

// 3. Over-cap: text longer than cap is truncated to cap chars + marker.
{
  const big = "a".repeat(CAP + 50);
  const result = capWorkflowOutput(big, CAP);
  assert(result.length === CAP + MARKER.length, "K3: over-cap result is cap + marker length");
  assert(result.startsWith("a".repeat(CAP)), "K3: over-cap result starts with the first cap chars");
  assert(result.endsWith(MARKER), "K3: truncation marker is appended when text exceeds cap");
}

// 4. Marker is present only when text is truncated (not for under-cap or exact-cap).
{
  const under = capWorkflowOutput("short", CAP);
  const exact = capWorkflowOutput("e".repeat(CAP), CAP);
  const over = capWorkflowOutput("o".repeat(CAP + 1), CAP);
  assert(!under.includes(MARKER), "K3: marker absent for under-cap input");
  assert(!exact.includes(MARKER), "K3: marker absent for exact-cap input");
  assert(over.includes(MARKER), "K3: marker present for over-cap input");
}

// 5. The production constant (256 KiB default) gates correctly — text just under
//    and just over the real default cap.
{
  const DEFAULT_CAP = 262_144;
  const justUnder = "z".repeat(DEFAULT_CAP);
  const justOver = "z".repeat(DEFAULT_CAP + 1);
  assert(capWorkflowOutput(justUnder, DEFAULT_CAP) === justUnder, "K3: 256 KiB text is not truncated");
  assert(capWorkflowOutput(justOver, DEFAULT_CAP).includes(MARKER), "K3: 256 KiB + 1 text is truncated with marker");
}

console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
process.exit(process.exitCode ? 1 : 0);
