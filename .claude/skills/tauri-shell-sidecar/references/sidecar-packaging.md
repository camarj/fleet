# Sidecar Packaging Pipeline

Source: `apps/desktop/scripts/build-sidecar.mjs` (read it directly — this file summarizes).

## Pipeline (4 steps)

### 1. Build the Core (TypeScript → JS)
```bash
pnpm --filter @inteliside/gateway-core build
```
Output: `packages/core/dist/`

### 2. esbuild: bundle to a single CJS file
```bash
esbuild apps/desktop/sidecar-entry.mjs \
  --bundle --platform=node --format=cjs --target=node22 \
  --outfile=.sidecar-build/core.cjs
```
- `ws` is bundled in.
- `node:*` built-ins (including `node:sqlite`) are kept external — they are resolved from the embedded Node runtime, not bundled.
- Entry point is `apps/desktop/sidecar-entry.mjs`, which imports the Core and calls `startServer()`.

### 3. Node SEA: blob → injected into a copy of the `node` binary

```bash
# Write sea-config.json
node --experimental-sea-config .sidecar-build/sea-config.json
# → produces .sidecar-build/core.blob

# Copy the current node binary (becomes the carrier)
cp $(which node) src-tauri/binaries/gateway-core-<triple>

# macOS: strip existing signature first
codesign --remove-signature gateway-core-<triple>

# Inject the blob
postject gateway-core-<triple> NODE_SEA_BLOB core.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA   # macOS only

# Re-sign (macOS)
codesign --sign - gateway-core-<triple>
```

The fuse string `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` is fixed — do not change it.

### 4. Target triple naming

```bash
triple=$(rustc --print host-tuple)
# binary lands at: src-tauri/binaries/gateway-core-${triple}[.exe]
```

Tauri reads `externalBin: ["binaries/gateway-core"]` from `tauri.conf.json`, appends the current build target triple, and looks for that file at bundle time.

## Why Node SEA, not pkg

`node:sqlite` is a Node 22.5+ built-in that requires the real Node runtime. `pkg` statically bundles a snapshot of Node that does NOT support Node built-ins safely. Node SEA embeds the actual `node` binary, so all built-ins work as expected.

## devDependencies required

- `esbuild` — bundler
- `postject` — SEA blob injector

## tauri.conf.json key

```json
"bundle": {
  "externalBin": ["binaries/gateway-core"]
}
```

## capabilities/default.json key

```json
{
  "identifier": "shell:allow-spawn",
  "allow": [{ "name": "binaries/gateway-core", "sidecar": true }]
}
```

Use `shell:allow-spawn` (not `shell:allow-execute`) because the Core is a long-running server process.

## Rust spawn (lib.rs)

```rust
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

let sidecar = app.shell().sidecar("gateway-core").expect("not bundled");
let (mut rx, _child) = sidecar.spawn().expect("failed to spawn");

tauri::async_runtime::spawn(async move {
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => print!("[core] {}", String::from_utf8_lossy(&bytes)),
            CommandEvent::Stderr(bytes) => eprint!("[core] {}", String::from_utf8_lossy(&bytes)),
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }
});
```

The `_child` handle must remain in scope — if dropped, the OS kills the child process.

The spawn is wrapped in `#[cfg(not(debug_assertions))]` so it only fires in release builds.

Official reference: https://v2.tauri.app/develop/sidecar/
