/**
 * FlueAdapter — consumes a served Flue agent (the Astro team's TS agent harness)
 * over Flue's HTTP streaming API via `@flue/sdk`.
 *
 * Discovery: createFlueClient(baseUrl) + an optional admin manifest lookup. A run
 * calls `client.agents.invoke(name, id, { mode: "stream", payload })`, which yields
 * an async iterable of Flue's granular events over HTTP/SSE. Each FlueEvent (text,
 * thinking, tool, MCP-as-tool, skill/operation, compaction, subagent) is mapped to
 * a neutral RunEvent.
 *
 * KEY (verified live in WS0): a direct agent interaction is NOT a "run" in Flue's
 * model — the stream yields AttachedAgentEvents (FlueEvent minus
 * run_start/run_resume/run_end), so the terminal signal is the async iterable
 * completing, not a run_end event. Usage rides on `turn`/`operation`/`compaction`
 * payloads (no metadata key like A2A/ACP). Abort = an AbortSignal passed to invoke
 * (Flue exposes no server-side cancel — best-effort). The WebSocket path
 * (`client.agents.connect`) was NOT used: it failed to connect against a built
 * `node` server in WS0; the HTTP stream is the proven, simpler path.
 *
 * See skill `.claude/skills/flue-client/` (references/flue-wire.md) for the wire.
 */

import { createFlueClient, type AttachedAgentEvent, type FlueClient, type FlueEvent } from "@flue/sdk";
import type { RunInput, RunOptions, RunSink, Usage } from "../neutral.js";
import type { AgentAdapter, AgentInfo, RunHandle } from "./agent-adapter.js";

/**
 * Structural mirror of Flue's `PromptUsage` (the type is declared inside
 * `@flue/sdk` but not exported). Accepting it structurally lets `UsageAccumulator`
 * consume `event.usage` without importing the private type.
 */
interface FlueUsageLike {
  input: number;
  output: number;
  totalTokens: number;
}

export interface FlueConnectSpec {
  /** Where the public Flue app is mounted, e.g. http://localhost:8787 */
  baseUrl: string;
  /** Agent name as served at /agents/<name>/<id>. */
  agentName: string;
  /** Persistent agent-instance id; defaults to a generated one per connect. */
  instanceId?: string;
  /** Optional bearer token for the Flue HTTP/WS routes. */
  token?: string;
}

interface ResolvedFlueSpec {
  baseUrl: string;
  agentName: string;
  instanceId: string;
  token?: string;
}

export class FlueAdapter implements AgentAdapter {
  readonly kind = "flue" as const;
  readonly #client: FlueClient;
  readonly #spec: ResolvedFlueSpec;
  readonly #info: AgentInfo;

  private constructor(client: FlueClient, spec: ResolvedFlueSpec, info: AgentInfo) {
    this.#client = client;
    this.#spec = spec;
    this.#info = info;
  }

  static async connect(spec: FlueConnectSpec): Promise<FlueAdapter> {
    const client = createFlueClient({ baseUrl: spec.baseUrl, token: spec.token });
    const instanceId = spec.instanceId ?? "fleet_" + Math.random().toString(36).slice(2, 14);
    const resolved: ResolvedFlueSpec = { baseUrl: spec.baseUrl, agentName: spec.agentName, instanceId, token: spec.token };

    // Best-effort identity from the read-only admin manifest; falls back to the name.
    let info: AgentInfo = { id: spec.agentName, name: spec.agentName, version: "", description: "" };
    try {
      const { items } = await client.admin.agents.list();
      const entry = items.find((a) => a.name === spec.agentName);
      if (entry) info = { id: entry.name, name: entry.name, version: "", description: "" };
    } catch {
      // Admin route may be disabled/secured — the name-only identity is fine.
    }

    return new FlueAdapter(client, resolved, info);
  }

  info(): AgentInfo {
    return this.#info;
  }

  run(input: RunInput, _options: RunOptions, sink: RunSink): RunHandle {
    // Flue's prompt is a single string and carries no per-prompt model override
    // (the model is fixed at agent/profile config; provider/model swap is the
    // converter's job). So `_options.model` is intentionally not applied.
    const message = userText(input);
    const accum = new UsageAccumulator();
    const controller = new AbortController();
    let aborted = false;

    const done = (async () => {
      try {
        const stream = this.#client.agents.invoke(this.#spec.agentName, this.#spec.instanceId, {
          mode: "stream",
          payload: { message },
          signal: controller.signal,
        });
        for await (const ev of stream) {
          if (aborted) break;
          mapFlueEvent(ev, sink, accum);
        }
        const usage = accum.total();
        sink.onUsage?.(usage);
        sink.onDone?.(aborted ? "aborted" : "completed", usage);
      } catch (err) {
        if (aborted) sink.onDone?.("aborted", accum.total());
        else sink.onError?.("model_error", (err as Error).message);
      }
    })();

    return {
      done,
      abort: async () => {
        aborted = true;
        controller.abort(); // stops the HTTP stream; best-effort server-side
      },
    };
  }

  async close(): Promise<void> {
    // Each run owns its own HTTP stream; the client holds nothing to release.
  }
}

/**
 * Map one Flue event onto a neutral RunSink. Pure and exported so it can be
 * unit-tested with synthetic events — the live WebSocket transport is covered by
 * the WS0 probe. Accepts the broad FlueEvent type; the direct-agent socket only
 * ever delivers the AttachedAgentEvent subset (no run_start/run_resume/run_end).
 */
export function mapFlueEvent(ev: FlueEvent | AttachedAgentEvent, sink: RunSink, accum: UsageAccumulator): void {
  switch (ev.type) {
    case "text_delta":
      sink.onEvent?.({ type: "message.delta", role: "assistant", content: ev.text });
      return;

    case "thinking_start":
      sink.onEvent?.({ type: "thinking.start" });
      return;
    case "thinking_delta":
      sink.onEvent?.({ type: "thinking.delta", content: ev.delta });
      return;
    case "thinking_end":
      sink.onEvent?.({ type: "thinking.end", content: ev.content });
      return;

    case "tool_start": {
      const mcp = parseMcpTool(ev.toolName);
      const input = (ev.args ?? {}) as Record<string, unknown>;
      if (mcp) sink.onEvent?.({ type: "mcp.call", id: ev.toolCallId, server: mcp.server, name: mcp.name, input });
      else sink.onEvent?.({ type: "tool.call", id: ev.toolCallId, name: ev.toolName, input });
      return;
    }
    case "tool_call": {
      const mcp = parseMcpTool(ev.toolName);
      if (mcp)
        sink.onEvent?.({ type: "mcp.result", id: ev.toolCallId, server: mcp.server, name: mcp.name, output: ev.result, isError: ev.isError });
      else sink.onEvent?.({ type: "tool.result", id: ev.toolCallId, name: ev.toolName, output: ev.result });
      return;
    }

    case "task_start":
      sink.onEvent?.({ type: "subagent.start", name: ev.agent ?? ev.taskId });
      return;
    case "task":
      sink.onEvent?.({ type: "subagent.end", name: ev.agent ?? ev.taskId });
      return;

    case "operation_start":
      // Flue operation events carry no skill name; the id is the only handle.
      if (ev.operationKind === "skill") sink.onEvent?.({ type: "skill.start", id: ev.operationId, name: ev.operationId });
      return;
    case "operation":
      if (ev.operationKind === "skill")
        sink.onEvent?.({ type: "skill.end", id: ev.operationId, name: ev.operationId, isError: ev.isError, durationMs: ev.durationMs });
      // operation.usage aggregates the model work for this operation across all
      // kinds — the single, non-double-counting source of truth for usage.
      accum.add(ev.usage);
      return;

    case "compaction_start":
      sink.onEvent?.({ type: "memory.start", reason: ev.reason, estimatedTokens: ev.estimatedTokens });
      return;
    case "compaction":
      sink.onEvent?.({ type: "memory.end", messagesBefore: ev.messagesBefore, messagesAfter: ev.messagesAfter, durationMs: ev.durationMs });
      return;

    case "turn":
      // Capture the model/provider for the usage record; tokens come from
      // `operation` events to avoid double-counting per-turn vs per-operation.
      accum.note(ev.model, ev.provider);
      return;

    case "turn_request":
      accum.note(ev.model, ev.provider);
      return;

    // run_*, agent_*, turn_start/turn_end, message_*, idle, log → no neutral event.
    default:
      return;
  }
}

/** `mcp__<server>__<tool>` → { server, name }; otherwise null. */
export function parseMcpTool(toolName: string): { server: string; name: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return m ? { server: m[1]!, name: m[2]! } : null;
}

/**
 * Aggregates Flue PromptUsage across a run into the neutral Usage shape.
 * Flue tokens are `input`/`output` (+ cache + cost); neutral keeps the three
 * core counts plus the model specifier.
 */
export class UsageAccumulator {
  #input = 0;
  #output = 0;
  #total = 0;
  #model = "";

  add(usage: FlueUsageLike | undefined): void {
    if (!usage) return;
    this.#input += usage.input ?? 0;
    this.#output += usage.output ?? 0;
    this.#total += usage.totalTokens ?? 0;
  }

  /** Record the model/provider seen on a turn as a neutral specifier. */
  note(model: string | undefined, provider: string | undefined): void {
    if (!model) return;
    this.#model = provider ? `${provider}/${model}` : model;
  }

  total(): Usage {
    return { inputTokens: this.#input, outputTokens: this.#output, totalTokens: this.#total, model: this.#model };
  }
}

/** Flatten the neutral user messages into the single string Flue's prompt takes. */
function userText(input: RunInput): string {
  const user = input.messages.filter((m) => m.role === "user").map((m) => m.content);
  if (user.length > 0) return user.join("\n\n");
  return input.messages.at(-1)?.content ?? "";
}
