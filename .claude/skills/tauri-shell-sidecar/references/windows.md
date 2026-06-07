# Windows Notes

The build pipeline in `build-sidecar.mjs` handles Windows via the `isWin` flag:

```js
const isWin = process.platform === "win32";
const ext = isWin ? ".exe" : "";
// Binary: gateway-core-<triple>.exe
```

## Differences from macOS

| Step | macOS | Windows |
|---|---|---|
| Binary suffix | _(none)_ | `.exe` |
| Signature strip | `codesign --remove-signature` | Not needed |
| postject flag | `--macho-segment-name NODE_SEA` | _(flag omitted)_ |
| Re-sign | `codesign --sign -` | Not needed |

## Prerequisites

- Rust toolchain: https://rustup.rs/
- Node 22.5+ (24 recommended)
- Visual Studio C++ Build Tools (required by Tauri for native compilation)
  - Install via: https://visualstudio.microsoft.com/visual-cpp-build-tools/
- WebView2 runtime (usually pre-installed on Windows 10/11)

## Target triple examples

| Machine | Triple |
|---|---|
| x64 Windows | `x86_64-pc-windows-msvc` |
| ARM64 Windows | `aarch64-pc-windows-msvc` |

Get current: `rustc --print host-tuple`

## Build command

Same as macOS:
```bash
pnpm --filter @inteliside/gateway-desktop build
```

Tauri produces an `.msi` and/or `.exe` installer in `target/release/bundle/`.

Note: As of the current repo, macOS is the primary development target. Windows has not been validated end-to-end. Verify the full pipeline on Windows before shipping.

Official reference: https://v2.tauri.app/develop/sidecar/
