/**
 * Package the Gateway Core (Node/TS) into a single-file binary Tauri can ship
 * as a sidecar (`externalBin`). Pipeline:
 *
 *   1. Build the Core (tsc → dist).
 *   2. esbuild: bundle the sidecar entry → one CJS file (ws bundled; node:
 *      builtins like node:sqlite stay external — they live in the Node runtime).
 *   3. Node SEA: blob → injected into a copy of the `node` binary (postject).
 *   4. Name it with the Rust host target triple and drop it in
 *      src-tauri/binaries/gateway-core-<triple>[.exe].
 *
 * Node SEA embeds the REAL node binary, so node:sqlite (Node 22.5+) works —
 * which is why SEA is preferred over pkg here.
 *
 * Requires: Node 22.5+ (24 recommended), devDeps `esbuild` + `postject`, and on
 * macOS the `codesign` CLT. Run after installing Rust, as part of `tauri build`
 * (wired via beforeBuildCommand) or manually: `node scripts/build-sidecar.mjs`.
 */

import { execSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repo = resolve(desktop, "..", "..");
const work = join(desktop, ".sidecar-build");
const binaries = join(desktop, "src-tauri", "binaries");

const isWin = process.platform === "win32";
const ext = isWin ? ".exe" : "";
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

mkdirSync(work, { recursive: true });
mkdirSync(binaries, { recursive: true });

// 1. Build the Core.
run("pnpm --filter @inteliside/gateway-core build", { cwd: repo });

// 2. Bundle the sidecar entry to a single CJS file.
const bundle = join(work, "core.cjs");
run(
  `pnpm exec esbuild ${join(desktop, "sidecar-entry.mjs")} --bundle --platform=node ` +
    `--format=cjs --target=node22 --outfile=${bundle}`,
  { cwd: desktop },
);

// 3. Node SEA: config → blob → injected binary.
const seaConfig = join(work, "sea-config.json");
const blob = join(work, "core.blob");
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2),
);
run(`node --experimental-sea-config ${seaConfig}`);

const triple = execSync("rustc --print host-tuple").toString().trim();
const outBin = join(binaries, `gateway-core-${triple}${ext}`);
copyFileSync(process.execPath, outBin);
// `node` ships read-only (mode 555); postject must open it read-write.
chmodSync(outBin, 0o755);

if (process.platform === "darwin") run(`codesign --remove-signature "${outBin}"`);

run(
  `pnpm exec postject "${outBin}" NODE_SEA_BLOB "${blob}" ` +
    `--sentinel-fuse ${SEA_FUSE}` +
    (process.platform === "darwin" ? " --macho-segment-name NODE_SEA" : ""),
  { cwd: desktop },
);

if (process.platform === "darwin") run(`codesign --sign - "${outBin}"`);

rmSync(work, { recursive: true, force: true });
console.log(`\n✓ sidecar ready: ${outBin}`);
