/**
 * ExecutionEngine — the reusable core of running a set of inter-dependent tasks:
 * topological execution (a task runs once all its deps finish, so independent
 * branches run in parallel), a per-task wall-clock timeout, chained abort
 * (external signal → in-flight tasks), fail-fast (any task failure aborts the
 * rest), and status hooks.
 *
 * It is agnostic of "workflow", "DAG", or "capability": the DAG `Orchestrator`
 * adapts its nodes to `EngineTask`s and delegates here, keeping its own validation
 * and `{{...}}` interpolation. The future agentic orchestrator (ADR-12) can build
 * tasks from a plan and reuse the same engine instead of duplicating timeout /
 * abort / fail-fast.
 */

export type TaskStatus = "running" | "completed" | "failed";
export type EngineRunStatus = "completed" | "failed" | "aborted";

/** Context handed to a task's `run`: completed dependency results + its abort signal. */
export interface TaskContext<T> {
  /** Results of completed tasks (at least every dependency of this task). */
  results: Record<string, T>;
  /** Aborts on this task's timeout, on fail-fast, or on external abort. */
  signal: AbortSignal;
}

export interface EngineTask<T> {
  id: string;
  /** Ids this task depends on; it runs only after all of them complete. */
  deps: string[];
  /** Execute the task and resolve with its result. Rejects on error/abort. */
  run(ctx: TaskContext<T>): Promise<T>;
  /** Subject to the per-task timeout? Instantaneous tasks set this false. */
  timed?: boolean;
}

export interface EngineHooks<T> {
  onTaskStatus?(id: string, status: TaskStatus, info?: { result?: T; error?: string }): void;
}

export interface EngineResult<T> {
  status: EngineRunStatus;
  /** Results of the tasks that completed, keyed by task id. */
  results: Record<string, T>;
  /** Failure/abort reason, when status !== "completed". */
  error?: string;
}

export interface ExecutionEngineOptions {
  /** Max wall-clock per `timed` task. A task exceeding it fails (fail-fast then
   * aborts the run). Tasks with `timed: false` are not subject to it. */
  taskTimeoutMs?: number;
  /** Message for a timed-out task's failure. Default: `task "<id>" timed out after <ms>ms`. */
  timeoutMessage?(taskId: string, ms: number): string;
}

const DEFAULT_TASK_TIMEOUT_MS = 600_000; // 10 minutes — generous for real work, finite for hangs.

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export class ExecutionEngine<T> {
  readonly #taskTimeoutMs: number;
  readonly #timeoutMessage: (taskId: string, ms: number) => string;

  constructor(options: ExecutionEngineOptions = {}) {
    this.#taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.#timeoutMessage = options.timeoutMessage ?? ((id, ms) => `task "${id}" timed out after ${ms}ms`);
  }

  /**
   * Run `tasks`. Each runs once its deps finish; any failure fails the whole run
   * and aborts in-flight tasks (no retries). An external `signal` abort yields
   * status "aborted".
   */
  async run(tasks: EngineTask<T>[], hooks: EngineHooks<T> = {}, signal?: AbortSignal): Promise<EngineResult<T>> {
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const results: Record<string, T> = {};
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const memo = new Map<string, Promise<T>>();
    const runTask = (id: string): Promise<T> => {
      const existing = memo.get(id);
      if (existing) return existing;
      const task = taskById.get(id)!;
      const promise = (async () => {
        // Wait for every dependency to finish; their results are now in `results`.
        await Promise.all(task.deps.map(runTask));
        if (controller.signal.aborted) throw new AbortError();

        hooks.onTaskStatus?.(id, "running");
        try {
          const result = task.timed
            ? await this.#runTimed(task, results, controller)
            : await task.run({ results, signal: controller.signal });
          results[id] = result;
          hooks.onTaskStatus?.(id, "completed", { result });
          return result;
        } catch (err) {
          hooks.onTaskStatus?.(id, "failed", { error: (err as Error).message });
          throw err;
        }
      })();
      memo.set(id, promise);
      return promise;
    };

    try {
      await Promise.all(tasks.map((t) => runTask(t.id)));
      return { status: "completed", results };
    } catch (err) {
      // Fail fast: cancel any in-flight tasks.
      controller.abort();
      const status: EngineRunStatus = signal?.aborted ? "aborted" : "failed";
      return { status, results, error: (err as Error).message };
    } finally {
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
  }

  /**
   * Run one task under a wall-clock deadline. The task gets its own controller
   * chained to the run controller, so fail-fast / external abort still cancel it,
   * while a timeout cancels ONLY this task (its failure then propagates through the
   * normal fail-fast path). A timeout surfaces as the configured timeout message.
   */
  async #runTimed(task: EngineTask<T>, results: Record<string, T>, runController: AbortController): Promise<T> {
    const taskCtl = new AbortController();
    const onRunAbort = (): void => taskCtl.abort();
    runController.signal.addEventListener("abort", onRunAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      taskCtl.abort();
    }, this.#taskTimeoutMs);
    try {
      return await task.run({ results, signal: taskCtl.signal });
    } catch (err) {
      // Distinguish "this task timed out" from "the run was aborted/failed elsewhere".
      if (timedOut && !runController.signal.aborted) {
        throw new Error(this.#timeoutMessage(task.id, this.#taskTimeoutMs));
      }
      throw err;
    } finally {
      clearTimeout(timer);
      runController.signal.removeEventListener("abort", onRunAbort);
    }
  }
}
