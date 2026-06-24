# Running the Gateway locally (browser path — no Rust needed)

The Gateway is **Core (WebSocket server) + Frontend (React)**. The desktop shell
(Tauri) only wraps these in a native window and packages the Core as a sidecar —
it adds nothing to the Gateway's behavior. For testing, run the Core + Frontend
and use the **browser**. No Rust toolchain required.

```
┌────────────┐  Gateway API (WS)  ┌──────────┐  Flue (HTTP+WS) ┌─────────┐
│  Frontend  │ ◀────────────────▶ │   Core   │ ◀─────────────▶ │  Agent  │
│  :1420     │   ws://…:4179      │  :4179   │   FlueAdapter   │  :8080  │
└────────────┘                    └──────────┘                 └─────────┘
```

## 1. Launch Core + Frontend

From the repo root:

```bash
pnpm dev          # runs Core (ws://127.0.0.1:4179) + Frontend (http://localhost:1420) in parallel
```

(Or separately: `pnpm core:dev` and `pnpm frontend:dev` in two terminals.)

By default the Core uses an in-memory SQLite DB (state is lost on restart). To
persist, set a file path:

```bash
GATEWAY_DB=/tmp/gateway.db pnpm dev
```

Open **http://localhost:1420** in your browser.

## 2. Get a Flue agent to talk to

Fleet is **Flue-only**: every agent is a Flue agent reached through `FlueAdapter`.
There are two ways to get one, both from the browser UI:

- **Deploy** a local Claude Code project — Fleet converts it to a Flue agent and
  deploys it. The default target is `docker-local` (needs Docker running); other
  targets are `fly`, `cloudflare`, `github`, and `dokploy`. This is the usual path
  and needs no separate server.
- **Connect** to a Flue agent that is **already running** somewhere, by its URL.

Set the provider API key first (**Settings → API keys**, e.g. `ANTHROPIC_API_KEY`).
Sending a message makes a real, paid model call.

## 3. Use it

In the browser UI:

1. **Deploy:** Sidebar → **"+ Deploy agent"** → pick the Claude Code project folder
   and a target (default `docker-local`) → run the pre-deploy checks → **Deploy**.
   When it finishes, the agent appears in the fleet as `online`.

   **Or connect:** Sidebar → **"⟳ Connect agent"** ("Connect a Flue agent") → enter
   the agent's base URL + agent name (+ token if it's protected) → **Connect**.
2. Select the agent. The **Terminal** panel shows its name + model.
3. Type a message and press Enter.
4. Watch the streamed reply, then the usage/cost line on completion. **Abort**
   cancels an in-flight run.

> **A2A is not wired up yet.** Reintroducing A2A as a coordination layer alongside
> Flue is the direction of the Baton pivot (ADR-13), not a current feature — there
> is no "Connect A2A agent" action in the UI today. ACP is out of scope.

## 4. Stop everything

```bash
# Core + Frontend: Ctrl-C in the `pnpm dev` terminal
```

A deployed agent is torn down from the UI (**Stop** / **Delete** in the sidebar);
the Core stops its `docker-local` container / `local-process` subprocess. A
**connected** agent runs independently — stop it wherever it is hosted.

---

## Desktop app (Tauri) — built & validated

The desktop shell under `apps/desktop/` builds, packages, and runs. In a release
bundle the Rust shell spawns the Core as a sidecar binary (Node SEA) and loads
the frontend in a WebView; the frontend connects to `ws://127.0.0.1:4179` exactly
as in the browser. Tauri adds the native window + sidecar process management +
packaging — not Gateway functionality.

### One-time prerequisite: Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # then: source ~/.cargo/env
```

(macOS Command Line Tools must be present — they are.)

### Dev (hot reload)

```bash
pnpm core:dev                                    # terminal 1 — the Core (shell does NOT spawn it in dev)
pnpm --filter @inteliside/gateway-desktop dev    # terminal 2 — tauri dev (native window + Vite on :1420)
```

### Build (.app + .dmg)

```bash
source ~/.cargo/env
pnpm --filter @inteliside/gateway-desktop build
```

Artifacts land in `apps/desktop/src-tauri/target/release/bundle/`:

- `macos/Fleet.app`
- `dmg/Fleet_<version>_aarch64.dmg`

The release `.app` is self-contained: launching it spawns the embedded Core
(no separate `pnpm dev` needed) and binds `:4179`. Connect agents from the UI as
above.

### Icons

The Fleet icon — a hub-and-spoke mark (command center + agent fleet) on a blue
squircle — lives at `apps/desktop/icon-source.png` (1024×1024). The icon set in
`src-tauri/icons/` is generated from it. To change the logo, replace the source
and regenerate (pass an **absolute** path — Tauri runs from `apps/desktop`):

```bash
pnpm --filter @inteliside/gateway-desktop exec tauri icon "$(pwd)/apps/desktop/icon-source.png"
```

### Notes / fixes applied while wiring the first build

- `scripts/build-sidecar.mjs`: the `postject` step now runs with `cwd: apps/desktop`
  (it isn't resolvable from the repo root), and the copied `node` binary is
  `chmod 0o755` before injection (it ships read-only at mode 555).
- `tauri.conf.json`: `beforeBuildCommand` calls `node scripts/build-sidecar.mjs`
  (relative to `apps/desktop`, where Tauri runs it) — not `../scripts/...`.
