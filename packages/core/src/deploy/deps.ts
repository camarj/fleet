/**
 * Shared "install build deps once" helper. Several deploy targets need a set of
 * npm packages resolvable from a base dir (the deployed/ tree): the Flue runtime
 * for every target, plus the Cloudflare build tools for the CF Worker build. The
 * pattern is identical — skip if the required CLIs already resolve, otherwise
 * write a tiny package.json and `npm install` once — so it lives here instead of
 * being copy-pasted per target.
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DeployError, spawnStreaming, type LogSink } from "./spawn.js";

/** Find a CLI shim (`flue`, `wrangler`, …) in any node_modules/.bin up the tree from `base`. */
export function findBin(base: string, name: string): string | null {
  let dir = base;
  for (;;) {
    const bin = join(dir, "node_modules", ".bin", name);
    if (existsSync(bin)) return bin;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface DepsSpec {
  /** Runtime dependencies for the generated package.json. */
  dependencies: Record<string, string>;
  /** Dev dependencies for the generated package.json. */
  devDependencies: Record<string, string>;
  /** CLIs that must resolve up the tree; if all are present the install is skipped. */
  requiredBins: readonly string[];
  /** Progress message shown while installing (only on the install path). */
  installLabel: string;
  /** Noun used in the failure message: `installing <errorWhat> failed`. */
  errorWhat: string;
}

/**
 * Ensure `spec`'s deps are installed under `base`. No-op when every `requiredBins`
 * entry already resolves (the monorepo dev tree, or a previous deploy). Otherwise
 * writes `<base>/package.json` and runs `npm install` once.
 */
export async function ensureDeps(
  base: string,
  spec: DepsSpec,
  onProgress: (label: string) => void,
  onLog: LogSink,
): Promise<void> {
  if (spec.requiredBins.every((bin) => findBin(base, bin))) return;
  onProgress(spec.installLabel);
  writeFileSync(
    join(base, "package.json"),
    JSON.stringify(
      { name: "fleet-deployed", private: true, dependencies: spec.dependencies, devDependencies: spec.devDependencies },
      null,
      2,
    ),
  );
  const install = await spawnStreaming("npm", ["install"], { cwd: base }, onLog);
  if (install.status !== 0) throw new DeployError(`installing ${spec.errorWhat} failed:\n${install.output}`);
}
