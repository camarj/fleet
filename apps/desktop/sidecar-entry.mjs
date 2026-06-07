/**
 * Sidecar entrypoint — what the packaged Core binary runs.
 *
 * Imports the built Core and starts its WebSocket server. esbuild bundles this
 * into a single CJS file; Node SEA turns that into the `gateway-core` binary
 * Tauri ships as an externalBin sidecar. See scripts/build-sidecar.mjs.
 */
import { startServer } from "../../packages/core/dist/index.js";

startServer();
