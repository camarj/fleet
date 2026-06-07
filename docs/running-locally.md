# Running the Gateway locally (browser path — no Rust needed)

The Gateway is **Core (WebSocket server) + Frontend (React)**. The desktop shell
(Tauri) only wraps these in a native window and packages the Core as a sidecar —
it adds nothing to the Gateway's behavior. For testing, run the Core + Frontend
and use the **browser**. No Rust toolchain required.

```
┌────────────┐  Gateway API (WS)  ┌──────────┐  A2A / ACP  ┌─────────┐
│  Frontend  │ ◀────────────────▶ │   Core   │ ◀─────────▶ │  Agent  │
│  :1420     │   ws://…:4179      │  :4179   │             │  :8080  │
└────────────┘                    └──────────┘             └─────────┘
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

## 2. Launch an agent to talk to

A working A2A test agent (the `soporte-facturacion` example, main agent only —
the subagent is disabled pending the Component 1 fix) lives at `/tmp/soporte-e2e`:

```bash
cd /tmp/soporte-e2e
source .venv/bin/activate
python -m runtime.a2a_server          # serves A2A on http://127.0.0.1:8080
```

Its `.env` already carries `ANTHROPIC_API_KEY` (sending a message makes a real,
paid Anthropic call).

## 3. Use it

In the browser UI:

1. **Sidebar → "Connect A2A agent"** → enter `http://127.0.0.1:8080` → **Add**.
   The agent appears in the fleet with an `a2a` badge and `online`.
2. Select it. The **Terminal** panel shows its name + model.
3. Type a message (e.g. *"Tengo la factura INV-1001, ¿puedo pedir un reembolso?"*)
   and press Enter.
4. Watch the streamed reply, then the usage/cost line on completion. **Abort**
   cancels an in-flight run.

To connect any **other** A2A agent, just use its base URL. For a **local ACP**
agent, use "Launch ACP agent" with the path to the agent.

## 4. Stop everything

```bash
# Core + Frontend: Ctrl-C in the `pnpm dev` terminal
# Agent:
kill "$(cat /tmp/soporte-e2e/a2a.pid)"
```

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

The icon set in `src-tauri/icons/` is a generated **placeholder** (brand-colored
mark). Replace it with the real logo any time:

```bash
pnpm --filter @inteliside/gateway-desktop exec tauri icon path/to/logo.png   # 1024×1024 PNG
```

### Notes / fixes applied while wiring the first build

- `scripts/build-sidecar.mjs`: the `postject` step now runs with `cwd: apps/desktop`
  (it isn't resolvable from the repo root), and the copied `node` binary is
  `chmod 0o755` before injection (it ships read-only at mode 555).
- `tauri.conf.json`: `beforeBuildCommand` calls `node scripts/build-sidecar.mjs`
  (relative to `apps/desktop`, where Tauri runs it) — not `../scripts/...`.
