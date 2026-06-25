/**
 * A2aAdapter — a foreign adapter (ADR-13) that speaks the Agent2Agent (A2A)
 * protocol and maps an A2A task onto Fleet's neutral run model (`neutral.ts`),
 * exactly as `FlueAdapter` maps Flue. A2A is the coordination layer that
 * reintroduces interop with third-party agents; Flue stays the native runtime.
 *
 * A run drives `message/stream` (the injected `A2aClient` seam), whose events
 * (`Task | Message | TaskStatusUpdateEvent | TaskArtifactUpdateEvent`) are mapped
 * to neutral `RunEvent`s. The terminal task state decides the outcome:
 * `completed` → done, `canceled` → aborted, `failed`/`rejected` → error. Abort
 * requests `tasks/cancel` by task id and stops the stream (best-effort).
 *
 * The mapper `mapA2aEvent` is pure and exported so it can be unit-tested with
 * synthetic events (mirrors `mapFlueEvent`). Usage scaffolding is reused from the
 * shared neutral-mapping module (#61); no Flue/A2A duplication.
 */

import type { RunInput, RunOptions, RunSink } from "../../neutral.js";
import type { AgentAdapter, AgentInfo, RunHandle } from "../agent-adapter.js";
import { UsageAccumulator, type TokenUsageLike } from "../neutral-mapping.js";
import {
  A2A_TERMINAL_STATES,
  type A2aClient,
  type A2aMessage,
  type A2aPart,
  type A2aStreamEvent,
  type A2aTaskState,
  type AgentCard,
} from "./a2a-types.js";

export interface A2aConnectSpec {
  /** Where the A2A agent is reachable (its JSON-RPC endpoint base). */
  baseUrl: string;
  /** Agent name as Fleet knows it (fallback identity if the card is unavailable). */
  agentName: string;
  /** Optional bearer token for the A2A HTTP routes. */
  token?: string;
}

export class A2aAdapter implements AgentAdapter {
  readonly kind = "a2a" as const;
  readonly #client: A2aClient;
  readonly #info: AgentInfo;

  /**
   * Construct directly with an injected client — the seam tests use to drive a
   * fake A2A server. Production code calls `connect()`.
   */
  constructor(client: A2aClient, info: AgentInfo) {
    this.#client = client;
    this.#info = info;
  }

  /** Build the production adapter: fetch the Agent Card for identity, fall back to the name. */
  static async connect(spec: A2aConnectSpec, makeClient: (spec: A2aConnectSpec) => A2aClient): Promise<A2aAdapter> {
    const client = makeClient(spec);
    let info: AgentInfo = { id: spec.agentName, name: spec.agentName, version: "", description: "" };
    try {
      const card = await client.getAgentCard();
      if (card) info = { id: card.name, name: card.name, version: card.version ?? "", description: card.description ?? "" };
    } catch {
      // Card route unavailable/secured — the name-only identity is fine.
    }
    return new A2aAdapter(client, info);
  }

  info(): AgentInfo {
    return this.#info;
  }

  run(input: RunInput, _options: RunOptions, sink: RunSink): RunHandle {
    const message = toA2aMessage(input);
    const accum = new UsageAccumulator();
    const controller = new AbortController();
    let aborted = false;
    let taskId: string | undefined;
    let terminal: A2aTaskState | undefined;
    let terminalMessage = "";

    const done = (async () => {
      try {
        const stream = this.#client.sendMessageStream({ message, signal: controller.signal });
        for await (const ev of stream) {
          if (aborted) break;
          taskId = trackTaskId(ev) ?? taskId;
          const t = trackTerminal(ev);
          if (t) {
            terminal = t.state;
            terminalMessage = t.message || terminalMessage;
          }
          mapA2aEvent(ev, sink, accum);
        }
        const usage = accum.total();
        sink.onUsage?.(usage);
        if (aborted || terminal === "canceled") {
          sink.onDone?.("aborted", usage);
        } else if (terminal === "failed" || terminal === "rejected") {
          sink.onError?.("model_error", terminalMessage || `A2A task ${terminal}`);
        } else {
          sink.onDone?.("completed", usage);
        }
      } catch (err) {
        if (aborted) sink.onDone?.("aborted", accum.total());
        else sink.onError?.("model_error", (err as Error).message);
      }
    })();

    return {
      done,
      abort: async () => {
        aborted = true;
        controller.abort(); // stop the SSE stream
        if (taskId) await this.#client.cancelTask(taskId).catch(() => {}); // best-effort server-side cancel
      },
    };
  }

  async close(): Promise<void> {
    // Each run owns its own stream; the client holds nothing to release.
  }
}

/**
 * Map one A2A stream event onto a neutral RunSink. Pure and exported for unit
 * testing with synthetic events. Agent-authored text (messages, status messages,
 * output artifacts) becomes assistant `message.delta`s; token usage rides event
 * metadata under Fleet's `inteliside/usage` key (the convention from the prior
 * A2A integration — not invented wire).
 */
export function mapA2aEvent(ev: A2aStreamEvent, sink: RunSink, accum: UsageAccumulator): void {
  switch (ev.kind) {
    case "message":
      if (ev.role === "agent") emitTextParts(ev.parts, sink);
      accum.add(readUsage(ev.metadata));
      return;
    case "task":
      // Initial/non-final snapshot — surface any agent status text.
      if (ev.status.message?.role === "agent") emitTextParts(ev.status.message.parts, sink);
      accum.add(readUsage(ev.status.message?.metadata));
      return;
    case "status-update":
      if (ev.status.message?.role === "agent") emitTextParts(ev.status.message.parts, sink);
      accum.add(readUsage(ev.status.message?.metadata));
      return;
    case "artifact-update":
      // The agent's output artifact — its text parts are the answer.
      emitTextParts(ev.artifact.parts, sink);
      return;
    default:
      return;
  }
}

/** Emit each text part as an assistant delta (non-text parts are ignored in v1). */
function emitTextParts(parts: A2aPart[], sink: RunSink): void {
  for (const p of parts) {
    if (p.kind === "text" && p.text) sink.onEvent?.({ type: "message.delta", role: "assistant", content: p.text });
  }
}

/** The task id an event is associated with, if any (for `tasks/cancel`). */
function trackTaskId(ev: A2aStreamEvent): string | undefined {
  switch (ev.kind) {
    case "task":
      return ev.id;
    case "status-update":
    case "artifact-update":
      return ev.taskId;
    case "message":
      return ev.taskId;
    default:
      return undefined;
  }
}

/** If this event carries a terminal task state, return it plus any failure text. */
function trackTerminal(ev: A2aStreamEvent): { state: A2aTaskState; message: string } | undefined {
  const status = ev.kind === "task" ? ev.status : ev.kind === "status-update" ? ev.status : undefined;
  if (!status || !A2A_TERMINAL_STATES.has(status.state)) return undefined;
  const message = status.message ? textOf(status.message.parts) : "";
  return { state: status.state, message };
}

/** Concatenate the text parts of a message. */
function textOf(parts: A2aPart[]): string {
  return parts.filter((p): p is Extract<A2aPart, { kind: "text" }> => p.kind === "text").map((p) => p.text).join("");
}

/**
 * Read a token-usage record from A2A event metadata under Fleet's documented key
 * `inteliside/usage`. Returns undefined when absent (usage stays zero) — we never
 * fabricate token counts the protocol did not provide.
 */
function readUsage(metadata: Record<string, unknown> | undefined): TokenUsageLike | undefined {
  const raw = metadata?.["inteliside/usage"];
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return { input: num(u.input), output: num(u.output), totalTokens: num(u.totalTokens) };
}

/** Flatten the neutral user messages into a single A2A user message. */
function toA2aMessage(input: RunInput): A2aMessage {
  const user = input.messages.filter((m) => m.role === "user").map((m) => m.content);
  const text = user.length > 0 ? user.join("\n\n") : input.messages.at(-1)?.content ?? "";
  return { kind: "message", role: "user", parts: [{ kind: "text", text }], messageId: "fleet_" + Math.random().toString(36).slice(2, 14) };
}
