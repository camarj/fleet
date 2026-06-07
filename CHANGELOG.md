# Changelog

All notable changes to **Fleet** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/). See
[VERSIONING.md](./VERSIONING.md) for the policy.

## [Unreleased]

## [0.1.0] - 2026-06-07

Initial release — the multiplexer + operations center (Component 2).

### Added
- **Core** (`packages/core`): TS/Node WebSocket server exposing the neutral
  Gateway API to the frontend, with SQLite state via built-in `node:sqlite`.
- **A2A adapter** for **remote** agents over A2A (`@a2a-js/sdk` 1.x, HTTP+SSE).
- **ACP adapter** for **local** agents over ACP (`@agentclientprotocol/sdk`,
  stdio subprocess).
- Neutral run model (`message.delta` / `tool.call` / `tool.result` / `subagent.*`
  / usage) shared by both adapters; usage carried via `metadata["inteliside/usage"]`
  (A2A) and `_meta["inteliside_usage"]` (ACP).
- **Frontend** (`frontend`): React 19 + Vite — Sidebar (fleet), xterm.js terminal
  panel, and a Phase-2 workflow-canvas stub.
- **Desktop shell** (`apps/desktop`): Tauri v2 (macOS), packaging the Core as a
  Node SEA sidecar binary; ships as `.app` + `.dmg`.

### Notes
- The internal package names (`@inteliside/gateway-*`) and the `gateway-core`
  sidecar describe the architectural role; the product is **Fleet**.

[Unreleased]: https://github.com/camarj/fleet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/camarj/fleet/releases/tag/v0.1.0
