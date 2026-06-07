/**
 * AcpAdapter — consumes a LOCAL agent over ACP (stdio) via
 * `@agentclientprotocol/sdk`. The Gateway SPAWNS the agent as a subprocess and
 * talks newline-delimited JSON-RPC over its stdin/stdout.
 *
 * A run = session/prompt; incremental output arrives via the `sessionUpdate`
 * push callback (mapped to neutral RunEvents). Usage rides in
 * `result._meta["inteliside_usage"]` (the agreed compatibility key). Abort =
 * session/cancel (a notification; prompt resolves with stopReason "cancelled").
 *
 * Filesystem/terminal/permission callbacks are denied by default (MVP — we do
 * not grant a foreign agent access to our machine).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { ACP_USAGE_META_KEY, type RunInput, type RunOptions, type RunSink, type Usage } from "../neutral.js";
import type { AgentAdapter, AgentInfo, RunHandle } from "./agent-adapter.js";

export interface AcpLaunchSpec {
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Neutral identity for the agent (ACP initialize carries little identity). */
  id?: string;
  name?: string;
}

export class AcpAdapter implements AgentAdapter {
  readonly kind = "acp" as const;
  readonly #proc: ChildProcess;
  readonly #conn: acp.ClientSideConnection;
  readonly #info: AgentInfo;
  #sessionId?: string;
  #sink?: RunSink;

  private constructor(proc: ChildProcess, conn: acp.ClientSideConnection, info: AgentInfo) {
    this.#proc = proc;
    this.#conn = conn;
    this.#info = info;
  }

  static async launch(spec: AcpLaunchSpec): Promise<AcpAdapter> {
    const proc = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "inherit"],
    });

    const ref: { adapter?: AcpAdapter } = {};
    const handler: acp.Client = {
      async sessionUpdate(params: acp.SessionNotification): Promise<void> {
        ref.adapter?.handleUpdate(params);
      },
      async requestPermission(): Promise<acp.RequestPermissionResponse> {
        // Deny by default — the MVP does not grant filesystem/tool access.
        return { outcome: { outcome: "cancelled" } };
      },
    };

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    );
    const conn = new acp.ClientSideConnection(() => handler, stream);

    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });

    const info: AgentInfo = {
      id: spec.id ?? "acp-agent",
      name: spec.name ?? spec.id ?? "ACP agent",
      version: "",
      description: "",
    };
    const adapter = new AcpAdapter(proc, conn, info);
    ref.adapter = adapter;
    return adapter;
  }

  info(): AgentInfo {
    return this.#info;
  }

  /** Map an ACP session/update notification to neutral events. */
  handleUpdate(params: acp.SessionNotification): void {
    const sink = this.#sink;
    if (!sink) return;
    const u = params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = blockText(u.content);
        if (text) sink.onEvent?.({ type: "message.delta", role: "assistant", content: text });
        return;
      }
      case "tool_call":
        sink.onEvent?.({ type: "tool.call", id: u.toolCallId, name: u.title ?? u.toolCallId, input: {} });
        return;
      case "tool_call_update":
        if (u.status === "completed") {
          sink.onEvent?.({ type: "tool.result", id: u.toolCallId, name: u.toolCallId, output: null });
        }
        return;
      default:
        return;
    }
  }

  run(input: RunInput, _options: RunOptions, sink: RunSink): RunHandle {
    this.#sink = sink;
    const done = (async () => {
      try {
        const session = await this.#conn.newSession({ cwd: this.#info.id ? process.cwd() : process.cwd(), mcpServers: [] });
        this.#sessionId = session.sessionId;
        const prompt = input.messages
          .filter((m) => m.role === "user")
          .map((m) => ({ type: "text" as const, text: m.content }));
        const result = await this.#conn.prompt({ sessionId: session.sessionId, prompt });
        const usage = readUsage(result._meta);
        if (usage) sink.onUsage?.(usage);
        sink.onDone?.(result.stopReason === "cancelled" ? "aborted" : "completed", usage);
      } catch (err) {
        sink.onError?.("internal_error", (err as Error).message);
      } finally {
        this.#sink = undefined;
      }
    })();

    return {
      done,
      abort: async () => {
        if (this.#sessionId) await this.#conn.cancel({ sessionId: this.#sessionId });
      },
    };
  }

  async close(): Promise<void> {
    this.#proc.kill();
    try {
      await this.#conn.closed;
    } catch {
      // ignore
    }
  }
}

function blockText(block: unknown): string | undefined {
  if (block && typeof block === "object") {
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") return b["text"];
  }
  return undefined;
}

function readUsage(meta: Record<string, unknown> | null | undefined): Usage | null {
  const u = meta?.[ACP_USAGE_META_KEY] as Partial<Usage> | undefined;
  if (!u || typeof u !== "object") return null;
  return {
    inputTokens: Number(u.inputTokens ?? 0),
    outputTokens: Number(u.outputTokens ?? 0),
    totalTokens: Number(u.totalTokens ?? 0),
    model: String(u.model ?? ""),
  };
}
