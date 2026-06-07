# Gateway Desktop (Tauri v2 — macOS first)

The desktop shell. It loads the **frontend** in a WebView and launches the
**Core** as a sidecar. All connection logic lives in the Core (TS), reused
verbatim by the web delivery — the Rust side only spawns the sidecar.

## Prerequisites (one-time)

Building the native shell needs the **Rust toolchain** (not installed by
default):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

You also need the macOS Command Line Tools (already present) and app icons:

```bash
pnpm --filter @inteliside/gateway-desktop exec tauri icon path/to/logo.png
```

## Dev

`tauri dev` compiles the Rust shell and runs `beforeDevCommand` (the Vite dev
server on :1420). In dev the shell does **not** spawn the sidecar — run the Core
yourself so you can see its logs:

```bash
# terminal 1
pnpm core:dev
# terminal 2
pnpm desktop:dev
```

The frontend connects to `ws://127.0.0.1:4179` either way.

## Build (.app / .dmg)

`tauri build` runs `beforeBuildCommand`, which builds the frontend and then
`scripts/build-sidecar.mjs` — that packages the Core into a single binary at
`src-tauri/binaries/gateway-core-<target-triple>` (Node SEA; see the script and
the `tauri-shell-sidecar` skill). Then Tauri bundles it as an `externalBin`
sidecar and the release shell spawns it on startup.

```bash
pnpm --filter @inteliside/gateway-desktop build
```

## Layout

```
src-tauri/
  Cargo.toml            # tauri + tauri-plugin-shell
  tauri.conf.json       # externalBin: binaries/gateway-core, devUrl :1420
  capabilities/         # shell:allow-spawn for the sidecar
  src/{main.rs, lib.rs} # spawns the Core sidecar (release only)
  binaries/             # generated sidecar binaries (gitignored)
scripts/build-sidecar.mjs  # esbuild + Node SEA → sidecar binary
sidecar-entry.mjs          # imports the Core and starts its WS server
```
