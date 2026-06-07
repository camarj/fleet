/**
 * A2AAdapter — consumes a REMOTE agent over A2A via `@a2a-js/sdk` (1.x, the
 * proto-based generation of the spec).
 *
 * Discovery: ClientFactory.createFromUrl() fetches the Agent Card (whose
 * transports live in `supported_interfaces`) and picks a transport. A run =
 * sendMessageStream(); the streamed StreamResponse payloads (message / task /
 * status-update / artifact-update) are mapped to neutral RunEvents. Usage rides
 * in `metadata["inteliside/usage"]` (the agreed compatibility key). Abort =
 * cancelTask().
 */

import { ClientFactory, type Client } from "@a2a-js/sdk/client";
import {
  Role,
  TaskState,
  type CancelTaskRequest,
  type Message,
  type Part,
  type SendMessageRequest,
  type StreamResponse,
} from "@a2a-js/sdk";
import { A2A_USAGE_METADATA_KEY, type RunInput, type RunOptions, type RunSink, type RunStatus, type Usage } from "../neutral.js";
import type { AgentAdapter, AgentInfo, RunHandle } from "./agent-adapter.js";

/** The slice of the Agent Card the Gateway surfaces; fetched as plain JSON. */
interface CardInfo {
  name: string;
  version: string;
  description: string;
}

export class A2AAdapter implements AgentAdapter {
  readonly kind = "a2a" as const;
  readonly #client: Client;
  readonly #card: CardInfo;

  private constructor(client: Client, card: CardInfo) {
    this.#client = client;
    this.#card = card;
  }

  static async connect(baseUrl: string): Promise<A2AAdapter> {
    const factory = new ClientFactory();
    const client = await factory.createFromUrl(baseUrl);
    const card = await fetchCardInfo(baseUrl);
    return new A2AAdapter(client, card);
  }

  info(): AgentInfo {
    return {
      id: this.#card.name,
      name: this.#card.name,
      version: this.#card.version,
      description: this.#card.description,
    };
  }

  run(input: RunInput, options: RunOptions, sink: RunSink): RunHandle {
    let taskId: string | undefined;
    let aborted = false;

    const request = buildRequest(input, options);

    const done = (async () => {
      try {
        const result = await consumeStream(this.#client.sendMessageStream(request), sink, () => aborted);
        taskId = result.taskId ?? taskId;
        if (result.usage) sink.onUsage?.(result.usage);
        if (result.failed) sink.onError?.("model_error", "A2A task failed");
        else sink.onDone?.(aborted ? "aborted" : result.status, result.usage);
      } catch (err) {
        sink.onError?.("internal_error", (err as Error).message);
      }
    })();

    return {
      done,
      abort: async () => {
        aborted = true;
        if (taskId) {
          const cancel: CancelTaskRequest = { tenant: "", id: taskId, metadata: undefined };
          await this.#client.cancelTask(cancel);
        }
      },
    };
  }

  async close(): Promise<void> {
    // The A2A client holds no persistent connection to release.
  }
}

export interface StreamOutcome {
  status: RunStatus;
  usage: Usage | null;
  failed: boolean;
  taskId?: string;
}

/**
 * Map an A2A StreamResponse stream onto a neutral RunSink. Exported so it can be
 * unit-tested with synthetic payloads — the real HTTP/SSE transport is covered
 * by the live E2E (test/e2e-a2a-live.ts).
 */
export async function consumeStream(
  stream: AsyncIterable<StreamResponse>,
  sink: RunSink,
  isAborted: () => boolean = () => false,
): Promise<StreamOutcome> {
  let usage: Usage | null = null;
  let status: RunStatus = "completed";
  let failed = false;
  let taskId: string | undefined;

  for await (const response of stream) {
    if (isAborted()) break;
    const payload = response.payload;
    if (!payload) continue;

    switch (payload.$case) {
      case "task":
        taskId = payload.value.id;
        usage = readUsage(payload.value.status?.message?.metadata) ?? usage;
        break;
      case "message":
        emitParts(sink, payload.value.parts);
        usage = readUsage(payload.value.metadata) ?? usage;
        break;
      case "artifactUpdate":
        taskId = payload.value.taskId || taskId;
        emitParts(sink, payload.value.artifact?.parts ?? []);
        usage = readUsage(payload.value.metadata) ?? readUsage(payload.value.artifact?.metadata) ?? usage;
        break;
      case "statusUpdate": {
        const ev = payload.value;
        taskId = ev.taskId || taskId;
        emitParts(sink, ev.status?.message?.parts ?? []);
        usage = readUsage(ev.metadata) ?? readUsage(ev.status?.message?.metadata) ?? usage;
        const state = ev.status?.state;
        if (state === TaskState.TASK_STATE_CANCELED) status = "aborted";
        else if (state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED) failed = true;
        break;
      }
    }
  }

  return { status, usage, failed, taskId };
}

/** Build a one-message streaming request from neutral input. */
function buildRequest(input: RunInput, options: RunOptions): SendMessageRequest {
  const parts: Part[] = input.messages
    .filter((m) => m.role === "user")
    .map((m) => textPart(m.content));

  const message: Message = {
    messageId: cryptoRandomId(),
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts,
    metadata: options.model ? { "inteliside/overrides": { model: options.model } } : undefined,
    extensions: [],
    referenceTaskIds: [],
  };

  return { tenant: "", message, configuration: undefined, metadata: undefined };
}

function textPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

function emitParts(sink: RunSink, parts: Part[]): void {
  for (const p of parts) {
    if (p.content?.$case === "text" && p.content.value) {
      sink.onEvent?.({ type: "message.delta", role: "assistant", content: p.content.value });
    }
  }
}

function readUsage(meta: Record<string, unknown> | undefined): Usage | null {
  if (!meta || typeof meta !== "object") return null;
  const u = meta[A2A_USAGE_METADATA_KEY] as Partial<Usage> | undefined;
  if (!u || typeof u !== "object") return null;
  return {
    inputTokens: Number(u.inputTokens ?? 0),
    outputTokens: Number(u.outputTokens ?? 0),
    totalTokens: Number(u.totalTokens ?? 0),
    model: String(u.model ?? ""),
  };
}

/** Fetch the Agent Card as plain JSON (the alpha Client exposes no getter). */
async function fetchCardInfo(baseUrl: string): Promise<CardInfo> {
  const base = baseUrl.replace(/\/+$/, "");
  const url = base.endsWith(".json") ? base : `${base}/.well-known/agent-card.json`;
  try {
    const res = await fetch(url);
    const card = (await res.json()) as Partial<CardInfo>;
    return {
      name: card.name ?? "agent",
      version: card.version ?? "0.0.0",
      description: card.description ?? "",
    };
  } catch {
    return { name: "agent", version: "0.0.0", description: "" };
  }
}

function cryptoRandomId(): string {
  return "msg_" + Math.random().toString(36).slice(2, 14);
}
