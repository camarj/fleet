/**
 * Neutral SandboxAdapter — the single seam the Core uses to provision an
 * ephemeral, writable execution environment for a single task (ADR-14).
 *
 * The semantics are **ephemeral per task**: provision a workspace → run the
 * stateful work (clone, analyze, modify code) → return the artifact (diff / PR /
 * logs) → destroy. This is the *execution* layer, not where the Agent lives: it
 * is INDEPENDENT of the Agent's Deploy target (an agent deployed to Fly may
 * still provision a Docker sandbox here, or a microVM, or anything else behind
 * the seam).
 *
 * Same pluggable shape as `AgentAdapter`: a tiny, deep interface (much behavior
 * behind few methods) with one real implementation per backend. The only
 * implementation in this slice is the in-memory `FakeSandboxAdapter` (for
 * contract tests). The real Docker(+gVisor) default and the optional microVM
 * adapter are out of scope here (issue #72 / slice C2).
 *
 * Lifecycle:
 *   const handle = await adapter.provision(spec);    // workspace exists
 *   const artifact = await handle.run(task, signal); // stateful work, abortable
 *   await handle.destroy();                           // torn down; idempotent
 */

/** Which backend provides the sandbox. Mirrors `AgentKind`. */
export type SandboxKind = "fake" | "docker" | "microvm";

/** How a task ended. Drives what a caller does with the artifact. */
export type SandboxStatus = "completed" | "aborted" | "failed";

/**
 * What to provision. Optional knobs only — the default is a bare, empty,
 * ephemeral workspace. Carries env var NAMES only, never secret values
 * (rule #8): the backend resolves them from a secure store at run time.
 */
export interface SandboxSpec {
  /** Git repo to clone into the workspace, if the task needs a checkout. */
  repo?: string;
  /** Branch / ref / commit to check out after cloning. */
  ref?: string;
  /** Names of env vars to expose inside the sandbox (never their values). */
  envNames?: readonly string[];
  /** Hard wall-clock budget for the whole sandbox; backend tears down on breach. */
  timeoutMs?: number;
}

/**
 * The stateful unit of work to run inside an already-provisioned sandbox. A
 * sandbox is single-task by design (ephemeral per task), so a handle expects
 * exactly one `run`.
 */
export interface SandboxTask {
  /** The command line to execute inside the workspace. */
  command: string;
  /** Working directory relative to the workspace root (defaults to root). */
  cwd?: string;
}

/**
 * The product of a task — the only thing that survives the sandbox. Captured
 * before teardown so the caller can open a PR, surface a diff, or store logs.
 */
export interface SandboxArtifact {
  /** Terminal outcome of the task. */
  status: SandboxStatus;
  /** Process exit code of the task command, if it ran to completion. */
  exitCode?: number;
  /** Combined stdout/stderr captured from the task. */
  logs: string;
  /** Unified diff of the workspace changes, if the task modified files. */
  diff?: string;
  /** URL of a pull request opened from the work, if any. */
  prUrl?: string;
}

/**
 * A live, provisioned sandbox. Holds the workspace until `destroy`. The handle
 * is the unit of teardown — abort cancels the in-flight task (best-effort),
 * destroy releases the workspace.
 */
export interface SandboxHandle {
  /** Opaque id of this ephemeral sandbox. */
  readonly id: string;
  /**
   * Run the stateful work and resolve with its artifact. `signal` aborts the
   * task best-effort (backend-specific: kill/signal); on abort the promise
   * resolves with a `status: "aborted"` artifact rather than rejecting, so the
   * caller still gets whatever partial logs were captured.
   */
  run(task: SandboxTask, signal?: AbortSignal): Promise<SandboxArtifact>;
  /**
   * Tear down the workspace and release all resources. Idempotent and
   * best-effort: calling it more than once is a no-op, and it never throws for
   * an already-destroyed sandbox. Destroying mid-task aborts the task first.
   */
  destroy(): Promise<void>;
}

/**
 * Pluggable provider of ephemeral sandboxes. The Core depends only on this
 * interface; the backend (Docker, microVM, fake) is injected.
 */
export interface SandboxAdapter {
  readonly kind: SandboxKind;
  /** Provision a fresh, empty (or cloned) ephemeral workspace. */
  provision(spec?: SandboxSpec): Promise<SandboxHandle>;
}
