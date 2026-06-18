/**
 * Issue #69 — SandboxAdapter contract tests (no Docker, no network).
 *
 * Exercises the ephemeral-per-task lifecycle through the in-memory
 * FakeSandboxAdapter: provision → run → artifact → destroy, teardown,
 * idempotent double-destroy, and best-effort mid-task abort.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/sandbox-adapter.test.ts
 */

import { FakeSandboxAdapter } from "../src/adapters/fake-sandbox.js";
import type { SandboxAdapter } from "../src/adapters/sandbox-adapter.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

async function main(): Promise<void> {
  // ── happy path: provision → run → artifact → destroy ────────────────────────
  console.log("\n[1] happy path provision → run → artifact → destroy …");
  {
    const adapter: SandboxAdapter = new FakeSandboxAdapter({
      artifact: { diff: "diff --git a/x b/x", prUrl: "https://example/pr/1" },
    });

    const handle = await adapter.provision({ repo: "git@host:org/repo.git", ref: "main" });
    assert(typeof handle.id === "string" && handle.id.length > 0, "provision returns a handle with an id");

    const artifact = await handle.run({ command: "npm test" });
    assert(artifact.status === "completed", "task resolves with status completed");
    assert(artifact.exitCode === 0, "completed task carries an exit code");
    assert(artifact.logs.includes("npm test"), "artifact captures the task command in its logs");
    assert(artifact.diff === "diff --git a/x b/x", "artifact carries the produced diff");
    assert(artifact.prUrl === "https://example/pr/1", "artifact carries the opened PR url");

    await handle.destroy();
    assert(true, "destroy resolves after a completed task");
  }

  // ── kind + spec are surfaced ────────────────────────────────────────────────
  console.log("\n[2] adapter kind and provision spec …");
  {
    const adapter = new FakeSandboxAdapter();
    assert(adapter.kind === "fake", "fake adapter reports kind 'fake'");
    const handle = await adapter.provision({ repo: "r", envNames: ["GITHUB_TOKEN"] });
    assert(adapter.provisioned[0] === handle, "adapter records each provisioned handle");
    assert(handle.spec?.envNames?.[0] === "GITHUB_TOKEN", "spec carries env var NAMES (not values)");
  }

  // ── teardown destroys the workspace ─────────────────────────────────────────
  console.log("\n[3] teardown — destroy releases the sandbox …");
  {
    const adapter = new FakeSandboxAdapter();
    const handle = await adapter.provision();
    assert(handle.alive === true, "sandbox is alive after provision");
    await handle.destroy();
    assert(handle.alive === false, "sandbox is no longer alive after destroy");

    let threw = false;
    try {
      await handle.run({ command: "echo late" });
    } catch {
      threw = true;
    }
    assert(threw, "running a task on a destroyed sandbox is rejected");
  }

  // ── idempotent destroy: double-destroy does not break ───────────────────────
  console.log("\n[4] idempotency — double destroy is a no-op …");
  {
    const adapter = new FakeSandboxAdapter();
    const handle = await adapter.provision();
    await handle.run({ command: "true" });
    await handle.destroy();
    await handle.destroy(); // must not throw
    await handle.destroy(); // still must not throw
    assert(handle.destroyCount === 3, "destroy was invoked three times without throwing");
    assert(handle.alive === false, "sandbox stays destroyed across repeated destroy calls");
  }

  // ── best-effort abort mid-task ──────────────────────────────────────────────
  console.log("\n[5] best-effort abort mid-task → status aborted …");
  {
    const adapter = new FakeSandboxAdapter({ hang: true });
    const handle = await adapter.provision();
    const ac = new AbortController();
    const p = handle.run({ command: "sleep 999" }, ac.signal);
    setTimeout(() => ac.abort(), 10);
    const artifact = await p;
    assert(artifact.status === "aborted", "aborted task resolves with status aborted (not a throw)");
    assert(artifact.logs.includes("aborted"), "aborted artifact carries partial logs");

    // The sandbox is still alive — abort cancels the task, teardown is separate.
    assert(handle.alive === true, "abort does not destroy the sandbox (teardown is explicit)");
    await handle.destroy();
    assert(handle.alive === false, "explicit destroy after abort tears the sandbox down");
  }

  // ── destroying mid-task aborts the in-flight task ───────────────────────────
  console.log("\n[6] destroy mid-task aborts the running task best-effort …");
  {
    const adapter = new FakeSandboxAdapter({ hang: true });
    const handle = await adapter.provision();
    const p = handle.run({ command: "sleep 999" }); // no signal — only destroy can stop it
    setTimeout(() => void handle.destroy(), 10);
    const artifact = await p;
    assert(artifact.status === "aborted", "destroy-mid-task settles the hanging task as aborted");
    assert(handle.alive === false, "sandbox is destroyed after destroy-mid-task");
  }

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
