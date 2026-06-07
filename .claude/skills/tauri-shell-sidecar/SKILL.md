---
name: tauri-shell-sidecar
description: Package the Gateway Core as a Tauri v2 sidecar, wire IPC startup, and build the desktop app.
triggers:
  - tauri sidecar
  - desktop build
  - packaging core
  - tauri spawn
  - node sea
  - externalBin
---

## Purpose

Package the Gateway Core (Node/TypeScript) into a native sidecar binary that Tauri v2 bundles and spawns on app startup. Covers the full pipeline: esbuild + Node SEA → triple-suffixed binary → `externalBin` → `shell:allow-spawn` → Rust spawn.

## When to use

- Adding or modifying the desktop build pipeline (`apps/desktop/`)
- Changing how the Core sidecar is packaged or launched
- Debugging startup, IPC, or sidecar permission errors
- Setting up the Tauri shell on a new machine (macOS first)

## Key files

| File | Role |
|---|---|
| `apps/desktop/src-tauri/tauri.conf.json` | `bundle.externalBin`, icons, devUrl |
| `apps/desktop/src-tauri/capabilities/default.json` | `shell:allow-spawn` permission for the sidecar |
| `apps/desktop/src-tauri/src/lib.rs` | Rust entry — spawns the sidecar in release only |
| `apps/desktop/scripts/build-sidecar.mjs` | esbuild + Node SEA pipeline |
| `apps/desktop/sidecar-entry.mjs` | Imports the Core and calls `startServer()` |

## Architecture summary

Two distinct protocols in play — the Rust shell only spawns the binary; all agent communication lives in the Core (TypeScript):

```
Tauri shell (Rust)
  └── spawns sidecar: gateway-core-<triple>
        └── Node SEA binary (packages/core)
              └── WS server on ws://127.0.0.1:4179
                    └── Frontend speaks Gateway API (api.ts)
```

The frontend never speaks A2A or ACP. The Core translates agent events into Gateway API packets.

## Steps

### Dev workflow

```bash
# terminal 1 — Core (log visible)
pnpm core:dev

# terminal 2 — Tauri shell (does NOT spawn the sidecar in dev)
pnpm desktop:dev
```

Tauri dev skips `start_core()` (`#[cfg(not(debug_assertions))]` gate in `lib.rs`). Frontend connects to `ws://127.0.0.1:4179` regardless.

### Release build

```bash
pnpm --filter @inteliside/gateway-desktop build
```

`tauri build` runs `beforeBuildCommand` which calls `scripts/build-sidecar.mjs`. See `references/sidecar-packaging.md` for the full pipeline detail.

### Adding the sidecar binary on a new machine

1. Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
2. Get the target triple: `rustc --print host-tuple`
3. The script auto-detects and names the binary: `gateway-core-<triple>[.exe]`
4. macOS needs `codesign` (included in Xcode Command Line Tools)

## Key gotchas

- The binary **must** carry the target-triple suffix — Tauri will not find it otherwise. The script uses `rustc --print host-tuple` to compute this.
- `shell:allow-spawn` (long-running process) is correct for the Core. `shell:allow-execute` is for one-shot commands.
- `node:sqlite` requires Node 22.5+. Node SEA embeds the real Node binary, so the built-in works. `pkg` does NOT support Node built-ins safely — that is why SEA is used.
- On macOS, strip the signature from the copied Node binary before injecting (`codesign --remove-signature`) then re-sign with `codesign --sign -` after postject.
- In release, Rust drops the `_child` handle from `sidecar.spawn()`. If the child handle is not kept alive, the sidecar process will be killed when the handle drops. The current `lib.rs` keeps `_child` in scope for the lifetime of the async task.

## References

- `references/sidecar-packaging.md` — detailed esbuild + Node SEA pipeline
- `references/macos.md` — macOS build prerequisites and steps
- `references/windows.md` — Windows notes and differences
- Official Tauri v2 sidecar: https://v2.tauri.app/develop/sidecar/
- Official Tauri v2 sidecar with Node: https://v2.tauri.app/learn/sidecar-nodejs/
