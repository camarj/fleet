/**
 * GatewayClient — the frontend's WebSocket client toward the Core.
 *
 * This is the ONLY way the frontend reaches agents: it never connects to an
 * agent directly. It speaks the Gateway API (`api.ts`), and the Core translates
 * to the Runtime Protocol.
 */

import type { ClientRequest, ServerEvent } from "./api";

export type GatewayListener = (event: ServerEvent) => void;

export class GatewayClient {
  #ws: WebSocket | null = null;
  readonly #url: string;
  readonly #listeners = new Set<GatewayListener>();

  constructor(url: string) {
    this.#url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.#url);
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not connect to the Gateway Core at ${this.#url}`));
      ws.onclose = () => {
        if (this.#ws === ws) this.#ws = null;
      };
      ws.onmessage = (ev) => {
        let event: ServerEvent;
        try {
          event = JSON.parse(ev.data as string) as ServerEvent;
        } catch {
          return;
        }
        for (const fn of this.#listeners) fn(event);
      };
      this.#ws = ws;
    });
  }

  on(fn: GatewayListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  send(request: ClientRequest): void {
    if (this.#ws?.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway is not connected");
    }
    this.#ws.send(JSON.stringify(request));
  }

  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }
}
