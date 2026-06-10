/**
 * Core server — exposes the GatewayCore over a WebSocket to the frontend.
 *
 * This is the process Tauri launches as a sidecar (and the same one the web
 * delivery connects to). The frontend speaks the Gateway API (`api.ts`), never
 * Flue — that stays between the Core and the agents.
 *
 * Env:
 *   GATEWAY_HOST     (default 127.0.0.1)
 *   GATEWAY_PORT     (default 4179)
 *   GATEWAY_DB       (default: ~/.fleet/fleet.db) — SQLite state file; use ":memory:" for ephemeral store
 *   GATEWAY_NO_AUTH  Set to "1" to skip WS token verification (dev only)
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocketServer } from "ws";
import { GatewayCore } from "./core.js";
import type { ClientRequest, ServerEvent } from "./api.js";
import { dbPath as resolveDbPath } from "./paths.js";
import { loadOrCreateToken, isAuthorizedRequestUrl } from "./auth/token.js";

const HOST = process.env.GATEWAY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GATEWAY_PORT ?? 4179);
// Persist state to a file by default so data survives Core restarts.
// Pass GATEWAY_DB=:memory: explicitly to opt into an ephemeral store (tests do this).
const DB_PATH = process.env.GATEWAY_DB ?? resolveDbPath();
const NO_AUTH = process.env.GATEWAY_NO_AUTH === "1";

export function startServer(host = HOST, port = PORT, dbPath = DB_PATH): { close: () => Promise<void> } {
  // Ensure the parent directory exists for file-based databases.
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const core = new GatewayCore({ dbPath });

  const token = NO_AUTH ? null : loadOrCreateToken();

  const wss = new WebSocketServer({
    host,
    port,
    verifyClient: token
      ? (info, done) => {
          const ok = isAuthorizedRequestUrl(info.req.url, token, `ws://${host}:${port}`);
          done(ok, ok ? undefined : 401, ok ? undefined : "Unauthorized");
        }
      : undefined,
  });

  wss.on("connection", (socket) => {
    const emit: (event: ServerEvent) => void = (event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };

    // Register this connection for server-pushed events (e.g. health monitor
    // transitions). Unregister automatically when the socket closes.
    const unregisterEmitter = core.addEmitter(emit);
    socket.on("close", unregisterEmitter);

    socket.on("message", (data) => {
      let req: ClientRequest;
      try {
        req = JSON.parse(data.toString()) as ClientRequest;
      } catch {
        emit({ type: "error", message: "invalid JSON request" });
        return;
      }
      void core.handle(req, emit);
    });
  });

  wss.on("listening", () => {
    console.log(`[gateway-core] listening on ws://${host}:${port}${token ? "" : " (auth disabled)"}`);
  });

  const close = async (): Promise<void> => {
    await core.shutdown();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };

  return { close };
}

// Run directly (sidecar entrypoint).
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = startServer();
  const stop = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
