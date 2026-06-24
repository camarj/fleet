/**
 * DockerProvisioner — the low-level Docker primitives Fleet uses to turn an agent
 * build context into a running container: `build`, `run`, `rm`, plus secure secret
 * injection via a 0600 env-file (never in argv, rule #8).
 *
 * Extracted from `flue-deployer.ts` so it can be reused. The deployer drives the
 * PERSISTENT `docker-local` lifecycle on top of it; the ephemeral SandboxAdapter
 * (ADR-14 — provision → run task → artifact → destroy) will build its own
 * per-task semantics on the same primitives instead of re-implementing the
 * Docker commands. This class owns only the commands; port allocation and
 * readiness probing stay with the caller.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError, spawnStreaming, type LogSink } from "./spawn.js";

/** One host→container port publication, e.g. `{ host: 49213, container: 8080 }`. */
export interface PortMapping {
  host: number;
  container: number;
}

export interface DockerRunSpec {
  /** Image tag to run. */
  image: string;
  /** Container name (`docker run --name`). */
  name: string;
  /** Ports to publish (`-p host:container`). */
  ports?: readonly PortMapping[];
  /**
   * Env vars to inject. Written to a temporary 0600 env-file consumed via
   * `--env-file`, so secret VALUES never appear in argv / `ps` (rule #8). The
   * file is deleted immediately after `docker run` returns.
   */
  env?: Record<string, string>;
  /** Run detached (`-d`). Persistent deploys do; a foreground task may not. */
  detached?: boolean;
}

export class DockerProvisioner {
  /** Fail fast with a friendly message if the Docker daemon is unreachable. */
  ensureRunning(): void {
    const probe = spawnSync("docker", ["info"], { stdio: "ignore" });
    if (probe.status !== 0) {
      throw new DeployError(
        "Docker is not available. Install Docker and start the daemon (Docker Desktop), then retry.",
      );
    }
  }

  /**
   * Build an image from `contextDir`, streaming build output to `onLog` so the UI
   * shows live progress (npm install + flue build happen inside the Dockerfile).
   */
  async build(image: string, contextDir: string, onLog: LogSink): Promise<void> {
    const build = await spawnStreaming("docker", ["build", "--progress=plain", "-t", image, contextDir], {}, onLog);
    if (build.status !== 0) throw new DeployError(`docker build failed:\n${build.output}`);
  }

  /**
   * Run a container from `spec`. Secrets are injected through a 0600 temp
   * env-file that is unlinked as soon as `docker run` returns.
   */
  run(spec: DockerRunSpec): void {
    const args = ["run"];
    if (spec.detached) args.push("-d");
    args.push("--name", spec.name);
    for (const p of spec.ports ?? []) args.push("-p", `${p.host}:${p.container}`);
    const envFile = spec.env ? writeEnvFile(spec.env) : undefined;
    if (envFile) args.push("--env-file", envFile);
    args.push(spec.image);
    try {
      const run = spawnSync("docker", args, { stdio: "pipe", encoding: "utf8" });
      if (run.status !== 0) throw new DeployError(`docker run failed:\n${run.stderr || run.stdout}`);
    } finally {
      if (envFile) {
        try {
          unlinkSync(envFile);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /** Force-remove a container by name (best-effort, like `docker rm -f`). */
  rm(name: string): void {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  }
}

/**
 * Write a 0600 temp env-file for `docker run --env-file`, one `KEY=value` per
 * line in insertion order. Keeping secrets in a file (not argv) is rule #8.
 */
function writeEnvFile(env: Record<string, string>): string {
  const file = join(tmpdir(), `fleet-env-${Math.random().toString(36).slice(2)}.env`);
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
  return file;
}
