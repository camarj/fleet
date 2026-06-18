/**
 * FakeSandboxAdapter — an in-memory `SandboxAdapter` for contract tests.
 *
 * No Docker, no network, no filesystem: it models the ephemeral-per-task
 * lifecycle purely in memory so the seam can be exercised in CI. The same
 * role `FakeRunner` plays for the orchestrator, this plays for the sandbox.
 *
 * Behavior is configurable so a single fake covers every contract case:
 *   - the happy path (a task that produces an artifact),
 *   - a hanging task (to exercise best-effort abort and destroy-mid-task),
 *   - lifecycle bookkeeping (provision/run/destroy counts) for assertions.
 */

import type {
  SandboxAdapter,
  SandboxArtifact,
  SandboxHandle,
  SandboxKind,
  SandboxSpec,
  SandboxTask,
} from "./sandbox-adapter.js";

export interface FakeSandboxOptions {
  /**
   * When true, a task does not finish on its own — it resolves only when the
   * `run` signal aborts or the sandbox is destroyed. Exercises mid-task abort.
   */
  hang?: boolean;
  /**
   * Artifact a (non-hanging) task produces. Merged over a trivial completed
   * default, so a test can assert on a diff / prUrl / exitCode it injected.
   */
  artifact?: Partial<SandboxArtifact>;
}

/** In-memory sandbox handle. Tracks its own lifecycle for test assertions. */
export class FakeSandboxHandle implements SandboxHandle {
  readonly id: string;
  readonly spec: SandboxSpec | undefined;

  /** Tasks this handle was asked to run, in order. */
  readonly tasks: SandboxTask[] = [];
  /** How many times destroy() was called (idempotency check). */
  destroyCount = 0;

  #alive = true;
  #abortRunning: (() => void) | undefined;

  constructor(id: string, spec: SandboxSpec | undefined, private readonly options: FakeSandboxOptions) {
    this.id = id;
    this.spec = spec;
  }

  /** True until destroy() has been called at least once. */
  get alive(): boolean {
    return this.#alive;
  }

  async run(task: SandboxTask, signal?: AbortSignal): Promise<SandboxArtifact> {
    if (!this.#alive) throw new Error(`sandbox ${this.id} is destroyed; cannot run`);
    this.tasks.push(task);

    if (signal?.aborted) return aborted(task);

    if (!this.options.hang) {
      return { status: "completed", exitCode: 0, logs: `$ ${task.command}\n`, ...this.options.artifact };
    }

    // Hanging task: settle only when aborted (via the run signal) or destroyed.
    return new Promise<SandboxArtifact>((resolve) => {
      const finish = () => {
        this.#abortRunning = undefined;
        resolve(aborted(task));
      };
      this.#abortRunning = finish;
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  async destroy(): Promise<void> {
    this.destroyCount++;
    // Best-effort: aborts the in-flight task, then releases. Idempotent —
    // a second call just bumps the count and returns.
    this.#abortRunning?.();
    this.#alive = false;
  }
}

export class FakeSandboxAdapter implements SandboxAdapter {
  readonly kind: SandboxKind = "fake";

  /** Every handle provisioned, in order, for test assertions. */
  readonly provisioned: FakeSandboxHandle[] = [];

  #seq = 0;

  constructor(private readonly options: FakeSandboxOptions = {}) {}

  async provision(spec?: SandboxSpec): Promise<SandboxHandle> {
    const handle = new FakeSandboxHandle(`fake-sbx-${++this.#seq}`, spec, this.options);
    this.provisioned.push(handle);
    return handle;
  }
}

/** The artifact a best-effort-aborted task returns. */
function aborted(task: SandboxTask): SandboxArtifact {
  return { status: "aborted", logs: `$ ${task.command}\n[aborted]\n` };
}
