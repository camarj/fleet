/**
 * SecretInjector — one small interface for "stage these KEY=value secrets on the
 * target", with an implementation per delivery mechanism. Secrets always travel
 * via stdin or an env-file, never argv (CLAUDE.md rule #8).
 *
 * The mechanisms across the 6 deploy targets:
 *   - env-file (docker-local): handled by `DockerProvisioner` (0600 env-file) —
 *     not re-implemented here, see docker-provisioner.ts.
 *   - stdin import (fly): a single `flyctl secrets import --stage` → FlySecretInjector.
 *   - stdin per-key (cloudflare): one `wrangler secret put <name>` per key →
 *     WranglerSecretInjector.
 *   - REST env (dokploy): injected through the Dokploy compose `env` field by the
 *     orchestration helper — not a CLI, so not modelled here.
 *   - none (github, local-process): github produces an artifact; local-process gets
 *     its key through the subprocess env directly.
 */

import { spawnSync } from "node:child_process";
import { DeployError } from "./spawn.js";

export interface SecretInjector {
  /**
   * Stage the given secrets on the target. A no-op for an empty map. Secret VALUES
   * are passed via stdin (never argv); throws DeployError if the CLI fails.
   */
  inject(secrets: Record<string, string>): void;
}

/** Run a CLI feeding `input` on stdin; throw a labelled DeployError on non-zero exit. */
function runWithStdin(
  cmd: string,
  args: string[],
  input: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  errLabel: string,
): void {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    input,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (res.status !== 0) throw new DeployError(`${errLabel}:\n${res.stderr || res.stdout}`);
}

/**
 * Fly.io: stage every secret in one `flyctl secrets import --app <app> --stage`,
 * fed `KEY=value` lines on stdin. A single import so the next deploy applies all
 * of them at once.
 */
export class FlySecretInjector implements SecretInjector {
  constructor(
    private readonly app: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly cwd: string,
  ) {}

  inject(secrets: Record<string, string>): void {
    const lines = Object.entries(secrets).map(([k, v]) => `${k}=${v}`);
    if (lines.length === 0) return;
    runWithStdin(
      "flyctl",
      ["secrets", "import", "--app", this.app, "--stage"],
      lines.join("\n") + "\n",
      { cwd: this.cwd, env: this.env },
      "flyctl secrets import failed",
    );
  }
}

/**
 * Cloudflare Workers: store each secret with its own `wrangler secret put <name>`,
 * fed the value on stdin. Wrangler takes one secret per invocation.
 */
export class WranglerSecretInjector implements SecretInjector {
  constructor(
    private readonly wranglerBin: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  inject(secrets: Record<string, string>): void {
    for (const [name, value] of Object.entries(secrets)) {
      runWithStdin(
        this.wranglerBin,
        ["secret", "put", name],
        value,
        { cwd: this.cwd, env: this.env },
        `wrangler secret put ${name} failed`,
      );
    }
  }
}
