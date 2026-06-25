/**
 * HttpA2aClient — the production `A2aClient`: A2A over JSON-RPC 2.0 + SSE, per the
 * official spec. Tests do NOT use this (they inject a fake client); it is the real
 * transport the factory wires for `kind: "a2a"`.
 *
 *  - `message/stream`  → POST JSON-RPC, parse the `text/event-stream` body; each
 *    SSE `data:` line is a JSON-RPC envelope whose `result` is one A2A event.
 *  - `tasks/cancel`    → POST JSON-RPC by task id.
 *  - Agent Card        → GET `/.well-known/agent-card.json`.
 */

import type { A2aClient, A2aMessage, A2aStreamEvent, AgentCard } from "./a2a-types.js";
import type { A2aConnectSpec } from "./a2a.js";

interface JsonRpcEnvelope<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

export class HttpA2aClient implements A2aClient {
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  #rpcId = 0;

  constructor(spec: A2aConnectSpec) {
    this.#baseUrl = spec.baseUrl.replace(/\/$/, "");
    this.#headers = { "content-type": "application/json", ...(spec.token ? { authorization: `Bearer ${spec.token}` } : {}) };
  }

  async *sendMessageStream(params: { message: A2aMessage; signal?: AbortSignal }): AsyncIterable<A2aStreamEvent> {
    const res = await fetch(`${this.#baseUrl}/`, {
      method: "POST",
      headers: { ...this.#headers, accept: "text/event-stream" },
      body: JSON.stringify(this.#rpc("message/stream", { message: params.message })),
      signal: params.signal,
    });
    if (!res.ok || !res.body) throw new Error(`A2A message/stream failed: HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; each frame's `data:` line is one JSON-RPC envelope.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data) continue;
        const env = JSON.parse(data) as JsonRpcEnvelope<A2aStreamEvent>;
        if (env.error) throw new Error(`A2A stream error: ${env.error.message}`);
        if (env.result) yield env.result;
      }
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    await fetch(`${this.#baseUrl}/`, {
      method: "POST",
      headers: this.#headers,
      body: JSON.stringify(this.#rpc("tasks/cancel", { id: taskId })),
    });
  }

  async getAgentCard(): Promise<AgentCard | null> {
    const res = await fetch(`${this.#baseUrl}/.well-known/agent-card.json`, { headers: this.#headers });
    if (!res.ok) return null;
    return (await res.json()) as AgentCard;
  }

  #rpc(method: string, params: Record<string, unknown>): Record<string, unknown> {
    return { jsonrpc: "2.0", id: ++this.#rpcId, method, params };
  }
}
