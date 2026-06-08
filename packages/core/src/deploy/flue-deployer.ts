/**
 * FlueDeployer — the "Deploy agent" pipeline. Turns a local Claude Code project
 * into a running Flue agent the Core can connect to:
 *
 *   convert (converter lib) → write to <dataDir>/deployed/<name>
 *   → ensure a shared @flue install (once) → flue build
 *   → spawn `node dist/server.mjs` on a free port (provider key from the secrets
 *     store / env) → FlueAdapter.connect
 *
 * The deployed agent runs as a local subprocess; the Core owns its lifecycle and
 * kills it on shutdown. The provider API key is injected into the subprocess env
 * only — it is never written into the generated project (rule #8).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { convert, writeFlueProject } from "@inteliside/gateway-converter";
import { FlueAdapter } from "../adapters/flue.js";
import { deployedDir } from "../paths.js";
import type { SecretsStore } from "../secrets/store.js";

const FLUE_VERSION = "0.10.1";

/**
 * Where to run the converted agent. `docker-local` is the default: each agent is
 * a real Docker container, and each gets its OWN free host port (mapped to the
 * container's fixed internal 8080) so many agents run side by side without
 * collisions. `local-process` runs the built server as a bare Node subprocess —
 * handy for fast dev/tests, no Docker required.
 */
export type DeployTarget = "docker-local" | "local-process";

export interface DeployRequest {
  sourceDir: string;
  provider?: string;
  model?: string;
  target?: DeployTarget;
}

export type DeployStep = "converting" | "installing" | "building" | "starting" | "connecting" | "done";
export type DeployProgress = (step: DeployStep, detail?: string) => void;

export interface DeployedAgent {
  adapter: FlueAdapter;
  agentName: string;
  baseUrl: string;
  target: DeployTarget;
}

const INTERNAL_PORT = 8080; // the port the Flue server listens on inside the container

export class FlueDeployer {
  readonly #secrets: SecretsStore;
  readonly #processes = new Set<ChildProcess>();
  readonly #containers = new Set<string>();

  constructor(secrets: SecretsStore) {
    this.#secrets = secrets;
  }

  async deploy(req: DeployRequest, onProgress: DeployProgress): Promise<DeployedAgent> {
    const target: DeployTarget = req.target ?? "docker-local";

    // Convert the Claude Code project to a Flue project (deterministic).
    onProgress("converting");
    const project = convert(req.sourceDir, { provider: req.provider, model: req.model });
    const agentName = project.report.agentName;
    const agentDir = join(deployedDir(), agentName);
    rmSync(agentDir, { recursive: true, force: true });
    writeFlueProject(project, agentDir);

    const apiKeyEnv = project.report.apiKeyEnv;
    const provider = req.provider ?? "anthropic";
    const key = this.#secrets.get(provider) ?? process.env[apiKeyEnv];

    const baseUrl =
      target === "docker-local"
        ? await this.#runDockerLocal(agentName, agentDir, apiKeyEnv, key, onProgress)
        : await this.#runLocalProcess(agentName, agentDir, apiKeyEnv, key, onProgress);

    onProgress("connecting");
    const adapter = await FlueAdapter.connect({ baseUrl, agentName });
    onProgress("done");
    return { adapter, agentName, baseUrl, target };
  }

  /** Build a Docker image for the agent and run it on its own host port. */
  async #runDockerLocal(
    agentName: string,
    agentDir: string,
    apiKeyEnv: string,
    key: string | undefined,
    onProgress: DeployProgress,
  ): Promise<string> {
    ensureDockerRunning();
    const image = `fleet-agent-${agentName}`;
    const container = `fleet-${agentName}`;

    onProgress("building", "docker image");
    const build = spawnSync("docker", ["build", "-t", image, agentDir], { stdio: "pipe", encoding: "utf8" });
    if (build.status !== 0) throw new DeployError(`docker build failed:\n${build.stderr || build.stdout}`);

    // Replace any previous container of the same agent.
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });

    const hostPort = await freePort();
    onProgress("starting", `container on port ${hostPort}`);

    // Inject the key via a temp --env-file (0600) so it never lands in `ps`/args.
    const envFile = writeEnvFile(apiKeyEnv, key);
    try {
      const args = ["run", "-d", "--name", container, "-p", `${hostPort}:${INTERNAL_PORT}`, "--env-file", envFile, image];
      const run = spawnSync("docker", args, { stdio: "pipe", encoding: "utf8" });
      if (run.status !== 0) throw new DeployError(`docker run failed:\n${run.stderr || run.stdout}`);
    } finally {
      try {
        unlinkSync(envFile);
      } catch {
        /* best-effort */
      }
    }
    this.#containers.add(container);

    const baseUrl = `http://127.0.0.1:${hostPort}`;
    await waitReady(baseUrl);
    return baseUrl;
  }

  /** Run the built server as a bare Node subprocess (no Docker) on a free port. */
  async #runLocalProcess(
    agentName: string,
    agentDir: string,
    apiKeyEnv: string,
    key: string | undefined,
    onProgress: DeployProgress,
  ): Promise<string> {
    const base = deployedDir();
    ensureSharedFlue(base, onProgress);

    onProgress("building");
    const flueBin = findFlueBin(base);
    if (!flueBin) throw new DeployError("could not find the flue CLI in any node_modules/.bin up the tree.");
    const build = spawnSync(flueBin, ["build", "--root", agentDir, "--target", "node"], {
      cwd: base,
      stdio: "pipe",
      encoding: "utf8",
    });
    if (build.status !== 0) throw new DeployError(`flue build failed:\n${build.stderr || build.stdout}`);

    const port = await freePort();
    onProgress("starting", `process on port ${port}`);
    const child = spawn("node", ["dist/server.mjs"], {
      cwd: agentDir,
      detached: true,
      env: { ...process.env, HOST: "0.0.0.0", PORT: String(port), ...(key ? { [apiKeyEnv]: key } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#processes.add(child);
    child.on("exit", () => this.#processes.delete(child));

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitReady(baseUrl);
    return baseUrl;
  }

  /** Kill every deployed agent (subprocesses + containers). Called on Core shutdown. */
  async shutdown(): Promise<void> {
    for (const child of this.#processes) {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    }
    this.#processes.clear();
    for (const container of this.#containers) {
      spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    }
    this.#containers.clear();
  }
}

export class DeployError extends Error {}

function ensureDockerRunning(): void {
  const probe = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (probe.status !== 0) {
    throw new DeployError("Docker is not available. Install Docker and start the daemon (Docker Desktop), then retry.");
  }
}

/** Write a 0600 temp env file for `docker run --env-file` (keeps secrets out of argv). */
function writeEnvFile(apiKeyEnv: string, key: string | undefined): string {
  const file = join(tmpdir(), `fleet-env-${Math.random().toString(36).slice(2)}.env`);
  const lines = ["HOST=0.0.0.0"];
  if (key) lines.push(`${apiKeyEnv}=${key}`);
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
  return file;
}

// ── shared @flue install ────────────────────────────────────────────────────

/**
 * Deployed agents resolve `@flue/runtime` (and the build resolves `@flue/cli`) by
 * walking up to `<base>/node_modules`. If that's already resolvable — the
 * monorepo dev tree, or a previous deploy — skip the install. Otherwise write a
 * tiny package.json next to the agents and `npm install` once.
 */
function ensureSharedFlue(base: string, onProgress: DeployProgress): void {
  if (canResolveFlue(base)) return;
  onProgress("installing", "Flue runtime (first deploy — this can take a minute)");
  writeFileSync(
    join(base, "package.json"),
    JSON.stringify(
      {
        name: "fleet-deployed",
        private: true,
        dependencies: { "@flue/runtime": FLUE_VERSION },
        devDependencies: { "@flue/cli": FLUE_VERSION },
      },
      null,
      2,
    ),
  );
  const install = spawnSync("npm", ["install"], { cwd: base, stdio: "pipe", encoding: "utf8" });
  if (install.status !== 0) {
    throw new DeployError(`installing the Flue runtime failed:\n${install.stderr || install.stdout}`);
  }
}

/**
 * A reachable `flue` CLI shim up the tree implies @flue/runtime is installed in
 * the same node_modules — enough to skip the install. (We can't `require.resolve`
 * @flue/runtime: it is ESM-only and has no CJS "require" export.)
 */
function canResolveFlue(base: string): boolean {
  return findFlueBin(base) !== null;
}

/** Find the `flue` CLI shim in any node_modules/.bin up the tree from `base`. */
function findFlueBin(base: string): string | null {
  let dir = base;
  for (;;) {
    const bin = join(dir, "node_modules", ".bin", "flue");
    if (existsSync(bin)) return bin;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── process helpers ──────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/`);
      return;
    } catch {
      await sleep(400);
    }
  }
  throw new DeployError("the deployed agent did not start listening in time.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
