/**
 * Neutral AgentAdapter — the single interface the Core uses to talk to agents.
 *
 * Fleet is Flue-only: every agent is a Flue agent (converted from a Claude Code
 * project and deployed by Fleet), reached through `FlueAdapter` over Flue's
 * HTTP+WebSocket API. The adapter maps Flue's events INTO the neutral run model
 * (`neutral.ts`) so the rest of the Core never sees the wire protocol. The
 * `foreign/` placeholder remains for future non-Flue agents.
 */

import type { RunInput, RunOptions, RunSink } from "../neutral.js";

export type AgentKind = "flue" | "a2a";

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
  /** Abort the in-flight run (Flue: best-effort socket close / signal). */
  abort(): Promise<void>;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  /** Neutral identity, resolved at connect/launch time. */
  info(): AgentInfo;
  /** Start a run; stream neutral events into `sink`. */
  run(input: RunInput, options: RunOptions, sink: RunSink): RunHandle;
  /** Release resources held for this agent. */
  close(): Promise<void>;
}
