# macOS Build Guide

## Prerequisites (one-time)

```bash
# 1. Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. Xcode Command Line Tools (provides codesign, clang)
xcode-select --install

# 3. Node 22.5+ (24 recommended) — required for node:sqlite
# Verify: node --version

# 4. App icon (one-time — generates all sizes)
pnpm --filter @inteliside/gateway-desktop exec tauri icon path/to/logo.png
# → writes to apps/desktop/src-tauri/icons/
```

## Dev workflow

```bash
# Terminal 1 — Core (log visible in this terminal)
pnpm core:dev

# Terminal 2 — Tauri shell
pnpm desktop:dev
```

The Tauri shell in dev (`tauri dev`) does NOT spawn the sidecar — `lib.rs` gates it with `#[cfg(not(debug_assertions))]`. Both connect to `ws://127.0.0.1:4179`.

## Release build

```bash
pnpm --filter @inteliside/gateway-desktop build
```

This runs:
1. `pnpm --filter @inteliside/gateway-frontend build` (Vite → `frontend/dist/`)
2. `node apps/desktop/scripts/build-sidecar.mjs` (esbuild + Node SEA → `src-tauri/binaries/gateway-core-<triple>`)
3. `tauri build` (Rust compile + DMG/app bundle)

## macOS-specific steps in build-sidecar.mjs

1. Strip existing code signature from the copied Node binary:
   `codesign --remove-signature gateway-core-<triple>`
2. Inject the SEA blob with `--macho-segment-name NODE_SEA` flag (macOS only).
3. Re-sign with an ad-hoc signature:
   `codesign --sign - gateway-core-<triple>`

Without step 1, postject injection fails. Without step 3, macOS Gatekeeper blocks execution.

## Target triple examples

| Machine | Triple |
|---|---|
| Apple Silicon (M1/M2/M3) | `aarch64-apple-darwin` |
| Intel Mac | `x86_64-apple-darwin` |

Get current: `rustc --print host-tuple`

## Icons

`tauri icon` generates `icons/icon.icns` and `icons/icon.png` referenced in `tauri.conf.json`:

```json
"icon": ["icons/icon.icns", "icons/icon.png"]
```

Official reference: https://v2.tauri.app/develop/sidecar/
