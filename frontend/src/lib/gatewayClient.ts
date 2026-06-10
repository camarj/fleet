/**
 * GatewayClient — the frontend's WebSocket client toward the Core.
 *
 * The ONLY way the frontend reaches agents: it never connects to an agent
 * directly. It speaks the Gateway API (`api.ts`); the Core translates to Flue.
 *
 * Auto-reconnects: if the socket drops (e.g. the Core restarts in dev), it keeps
 * retrying and notifies status listeners so the UI reflects the real state.
 */

import type { ClientRequest, ServerEvent } from "./api";

export type GatewayListener = (event: ServerEvent) => void;
export type StatusListener = (connected: boolean) => void;

export class GatewayClient {
  #ws: WebSocket | null = null;
  readonly #urlProvider: () => Promise<string>;
  readonly #listeners = new Set<GatewayListener>();
  readonly #statusListeners = new Set<StatusListener>();
  #shouldReconnect = true;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(urlProvider: () => Promise<string>) {
    this.#urlProvider = urlProvider;
  }

  /** Open the connection and keep it alive (auto-reconnect). Resolves on first open. */
  connect(): Promise<void> {
    return new Promise((resolve) => {
      // Never let a synchronous throw in #open leave connect() hanging.
      void this.#open(resolve).catch(() => resolve());
    });
  }

  async #open(onFirstOpen?: () => void): Promise<void> {
    let firstOpen = onFirstOpen;
    let url: string;
    try {
      url = await this.#urlProvider();
    } catch {
      firstOpen?.();
      firstOpen = undefined;
      this.#emitStatus(false);
      if (this.#shouldReconnect) this.#scheduleReconnect();
      return;
    }
    const ws = new WebSocket(url);
    ws.onopen = () => {
      this.#emitStatus(true);
      firstOpen?.();
      firstOpen = undefined;
    };
    ws.onclose = () => {
      if (this.#ws === ws) this.#ws = null;
      this.#emitStatus(false);
      if (this.#shouldReconnect) this.#scheduleReconnect();
    };
    ws.onerror = () => {
      // Let onclose drive reconnect; resolve the first connect so the app proceeds.
      firstOpen?.();
      firstOpen = undefined;
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
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#open();
    }, 1000);
  }

  on(fn: GatewayListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Subscribe to connection state changes. Fires immediately with the current state. */
  onStatus(fn: StatusListener): () => void {
    this.#statusListeners.add(fn);
    fn(this.connected);
    return () => this.#statusListeners.delete(fn);
  }

  #emitStatus(connected: boolean): void {
    for (const fn of this.#statusListeners) fn(connected);
  }

  /** Send a request. Returns false (and drops it) if not connected. */
  send(request: ClientRequest): boolean {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify(request));
    return true;
  }

  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }
}
