/**
 * Neutral AgentAdapter — axis 1 (FRAMEWORK), now over open standards.
 *
 * The Core talks to every agent through this neutral interface. Two
 * implementations:
 *   - A2AAdapter  — remote agents over A2A (HTTP+SSE), `@a2a-js/sdk`
 *   - AcpAdapter  — local agents over ACP (stdio subprocess), `@agentclientprotocol/sdk`
 *
 * Both map their standard's events INTO the neutral run model (`neutral.ts`),
 * so the rest of the Core never sees A2A or ACP.
 */

import type { RunInput, RunOptions, RunSink } from "../neutral.js";

export type AgentKind = "a2a" | "acp";

export interface AgentInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Default model specifier, if the standard exposes one. */
  model?: string;
}

export interface RunHandle {
  /** Resolves when the run reaches a terminal state (done|error). */
  readonly done: Promise<void>;
  /** Abort the in-flight run (A2A: tasks/cancel; ACP: session/cancel). */
  abort(): Promise<void>;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  /** Neutral identity, resolved at connect/launch time. */
  info(): AgentInfo;
  /** Start a run; stream neutral events into `sink`. */
  run(input: RunInput, options: RunOptions, sink: RunSink): RunHandle;
  /** Release resources (ACP: kill the subprocess; A2A: no-op). */
  close(): Promise<void>;
}
