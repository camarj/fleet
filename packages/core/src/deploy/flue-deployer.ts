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
import { chmodSync, existsSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { convert, writeFlueProject } from "@inteliside/gateway-converter";
import { FlueAdapter } from "../adapters/flue.js";
import { deployedDir } from "../paths.js";
import type { SecretsStore } from "../secrets/store.js";

const FLUE_VERSION = "0.10.1";
const AGENTS_VERSION = "0.15.0"; // Cloudflare Agents SDK — peer dep of the CF Worker build
const WRANGLER_VERSION = "4.98.0"; // Cloudflare deploy + secrets CLI

/**
 * Where to run the converted agent.
 *
 * - `docker-local` (default): a real Docker container, each on its OWN free host
 *   port (mapped to the container's fixed internal 8080) so many agents coexist.
 * - `local-process`: the built server as a bare Node subprocess — fast dev/tests,
 *   no Docker.
 * - `fly`: `flyctl deploy` builds the Dockerfile on Fly.io and runs it; Fleet
 *   reads the `*.fly.dev` URL and connects. Needs `FLY_API_TOKEN`.
 * - `github`: publish the project as a Git repo (with its Dockerfile) so you can
 *   wire it to a self-hosted Docker PaaS (Coolify, Dokploy, …). Produces an
 *   ARTIFACT (a repo URL), not a running agent — connect Fleet by URL once it runs.
 * - `cloudflare`: `flue build --target cloudflare` + `wrangler deploy` to a Workers
 *   `*.workers.dev` URL, then connect. Needs `CLOUDFLARE_API_TOKEN`.
 */
export type DeployTarget = "docker-local" | "local-process" | "fly" | "github" | "cloudflare";

export interface DeployRequest {
  sourceDir: string;
  provider?: string;
  model?: string;
  target?: DeployTarget;
}

export type DeployStep =
  | "converting"
  | "installing"
  | "building"
  | "starting"
  | "pushing"
  | "deploying"
  | "connecting"
  | "done";
export type DeployProgress = (step: DeployStep, detail?: string) => void;
/** Live output lines from the deploy's underlying commands. */
export type DeployLog = (lines: string[]) => void;
const NO_LOG: DeployLog = () => {};

/** A deployed, connected agent the Core can talk to. */
export interface DeployedAgent {
  kind: "connected";
  adapter: FlueAdapter;
  agentName: string;
  baseUrl: string;
  target: DeployTarget;
}

/** A produced artifact that is not (yet) a running agent — e.g. a published repo. */
export interface DeployArtifact {
  kind: "artifact";
  agentName: string;
  target: DeployTarget;
  /** Where the artifact lives (e.g. the GitHub repo URL). */
  url: string;
  /** Human-readable next step for the user. */
  message: string;
}

export type DeployResult = DeployedAgent | DeployArtifact;

const INTERNAL_PORT = 8080; // the port the Flue server listens on inside the container

export class FlueDeployer {
  readonly #secrets: SecretsStore;
  readonly #processes = new Set<ChildProcess>();
  readonly #containers = new Set<string>();

  constructor(secrets: SecretsStore) {
    this.#secrets = secrets;
  }

  async deploy(req: DeployRequest, onProgress: DeployProgress, onLog: DeployLog = NO_LOG): Promise<DeployResult> {
    const target: DeployTarget = req.target ?? "docker-local";

    // Convert the Claude Code project to a Flue project (deterministic).
    onProgress("converting");
    const project = convert(req.sourceDir, { provider: req.provider, model: req.model });
    const agentName = project.report.agentName;
    const agentDir = join(deployedDir(), agentName);
    rmSync(agentDir, { recursive: true, force: true });
    writeFlueProject(project, agentDir);

    // `github` publishes a repo for CI to build — there is nothing to connect to yet.
    if (target === "github") {
      return await this.#runGithub(agentName, agentDir, onProgress, onLog);
    }

    const apiKeyEnv = project.report.apiKeyEnv;
    // The provider id is the first segment of the resolved specifier (e.g.
    // "opencode-go/kimi-k2.6" → "opencode-go", "openrouter/anthropic/x" → "openrouter").
    const provider = project.report.modelSpecifier.split("/")[0] ?? "anthropic";
    const key = this.#secrets.get(provider) ?? process.env[apiKeyEnv];

    // Fail fast: an agent with no provider key would still build and "connect",
    // then fail on the first message with an opaque model error. Catch it here —
    // before the slow build — with an actionable message. (`github` returns above:
    // it publishes a repo and the key is supplied later by CI/the PaaS.)
    if (!key) {
      throw new DeployError(
        `No API key for provider "${provider}" (model ${project.report.modelSpecifier}). ` +
          `Add a "${provider}" key in Settings (it is read from ${apiKeyEnv}), then deploy again.`,
      );
    }

    let baseUrl: string;
    switch (target) {
      case "docker-local":
        baseUrl = await this.#runDockerLocal(agentName, agentDir, apiKeyEnv, key, onProgress, onLog);
        break;
      case "fly":
        baseUrl = await this.#runFly(agentName, agentDir, apiKeyEnv, key, onProgress, onLog);
        break;
      case "cloudflare":
        baseUrl = await this.#runCloudflare(agentName, agentDir, apiKeyEnv, key, onProgress, onLog);
        break;
      default:
        baseUrl = await this.#runLocalProcess(agentName, agentDir, apiKeyEnv, key, onProgress, onLog);
    }

    onProgress("connecting");
    const adapter = await FlueAdapter.connect({ baseUrl, agentName });
    onProgress("done");
    return { kind: "connected", adapter, agentName, baseUrl, target };
  }

  /** Build a Docker image for the agent and run it on its own host port. */
  async #runDockerLocal(
    agentName: string,
    agentDir: string,
    apiKeyEnv: string,
    key: string | undefined,
    onProgress: DeployProgress,
    onLog: DeployLog,
  ): Promise<string> {
    ensureDockerRunning();
    const image = `fleet-agent-${agentName}`;
    const container = `fleet-${agentName}`;

    onProgress("building", "docker image");
    // Stream the build (npm install + flue build happen inside) so the UI shows progress.
    const build = await spawnStreaming("docker", ["build", "--progress=plain", "-t", image, agentDir], {}, onLog);
    if (build.status !== 0) throw new DeployError(`docker build failed:\n${build.output}`);

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
    onLog: DeployLog,
  ): Promise<string> {
    const base = deployedDir();
    await ensureSharedFlue(base, onProgress, onLog);

    onProgress("building");
    const flueBin = findBin(base, "flue");
    if (!flueBin) throw new DeployError("could not find the flue CLI in any node_modules/.bin up the tree.");
    const build = await spawnStreaming(flueBin, ["build", "--root", agentDir, "--target", "node"], { cwd: base }, onLog);
    if (build.status !== 0) throw new DeployError(`flue build failed:\n${build.output}`);

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

  /**
   * Publish the converted project as a GitHub repo whose CI builds the image to
   * GHCR. Returns the repo URL (an artifact — nothing is running yet). The user
   * deploys the published image on a host and connects Fleet by URL.
   */
  async #runGithub(
    agentName: string,
    agentDir: string,
    onProgress: DeployProgress,
    onLog: DeployLog,
  ): Promise<DeployArtifact> {
    ensureCli("git", "Git is not available. Install Git, then retry.");
    ensureCli("gh", "The GitHub CLI is not available. Install `gh` and run `gh auth login`, then retry.");

    onProgress("building", "git repository");
    onLog(["Initializing git repository…"]);
    git(agentDir, ["init", "-q", "-b", "main"]);
    git(agentDir, ["add", "-A"]);
    git(agentDir, [
      "-c",
      "user.email=fleet@inteliside.local",
      "-c",
      "user.name=Fleet",
      "commit", "-q", "-m", "chore: initial Flue agent (generated by Fleet)",
    ]);

    onProgress("pushing", "GitHub repository");
    const repo = `fleet-agent-${agentName}`;
    const res = await spawnStreaming(
      "gh",
      ["repo", "create", repo, "--private", "--source", ".", "--push"],
      { cwd: agentDir },
      onLog,
    );
    if (res.status !== 0) throw new DeployError(`gh repo create failed:\n${res.output}`);
    const url = parseRepoUrl(res.output) ?? `https://github.com/<your-account>/${repo}`;

    onProgress("done");
    return {
      kind: "artifact",
      agentName,
      target: "github",
      url,
      message:
        "Repo published with its Dockerfile. Point a self-hosted Docker PaaS (Coolify, Dokploy, …) " +
        "at it to build and run the agent, then connect Fleet to the running URL.",
    };
  }

  /**
   * Build the agent for Cloudflare Workers and `wrangler deploy` it. Needs
   * `CLOUDFLARE_API_TOKEN` (and a Cloudflare account). The model provider key is
   * stored as a Worker secret after deploy — never in the repo. Returns the live
   * `*.workers.dev` base URL.
   */
  async #runCloudflare(
    agentName: string,
    agentDir: string,
    apiKeyEnv: string,
    key: string | undefined,
    onProgress: DeployProgress,
    onLog: DeployLog,
  ): Promise<string> {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) {
      throw new DeployError(
        "Cloudflare deploy needs CLOUDFLARE_API_TOKEN (and a Cloudflare account). Set it in the environment, then retry.",
      );
    }
    const base = deployedDir();
    await ensureCloudflareDeps(base, onProgress, onLog);

    onProgress("building", "cloudflare worker");
    const flueBin = findBin(base, "flue");
    if (!flueBin) throw new DeployError("could not find the flue CLI after installing the Cloudflare build deps.");
    const build = await spawnStreaming(
      flueBin,
      ["build", "--target", "cloudflare", "--root", agentDir],
      { cwd: agentDir },
      onLog,
    );
    if (build.status !== 0) throw new DeployError(`flue build --target cloudflare failed:\n${build.output}`);

    const outDir = findCfOutputDir(join(agentDir, "dist"));
    if (!outDir) throw new DeployError("the Cloudflare build did not produce a deployable dist/<worker>/ directory.");

    const wranglerBin = findBin(base, "wrangler");
    if (!wranglerBin) throw new DeployError("could not find wrangler after installing the Cloudflare build deps.");
    const cfEnv = { ...process.env, CLOUDFLARE_API_TOKEN: token };

    onProgress("deploying", "wrangler deploy");
    const deploy = await spawnStreaming(wranglerBin, ["deploy"], { cwd: outDir, env: cfEnv }, onLog);
    if (deploy.status !== 0) throw new DeployError(`wrangler deploy failed:\n${deploy.output}`);

    const baseUrl = parseWorkersUrl(deploy.output);
    if (!baseUrl) {
      throw new DeployError(`could not determine the deployed Worker URL from wrangler output:\n${deploy.output}`);
    }

    // Store the model provider key as a Worker secret (stdin → never in argv/repo).
    if (key) {
      const secret = spawnSync(wranglerBin, ["secret", "put", apiKeyEnv], {
        cwd: outDir,
        input: key,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
        env: cfEnv,
      });
      if (secret.status !== 0) {
        throw new DeployError(`wrangler secret put ${apiKeyEnv} failed:\n${secret.stderr || secret.stdout}`);
      }
    }

    await waitReady(baseUrl);
    return baseUrl;
  }

  /**
   * Deploy to Fly.io: build the Dockerfile on Fly's remote builders and run it,
   * then connect to the `*.fly.dev` URL. Needs `FLY_API_TOKEN` + `flyctl`. The
   * model provider key is staged as a Fly secret (stdin → never in argv/repo).
   * fly.toml is written here (not by the converter) because the app name must be
   * globally unique, so it is chosen at deploy time.
   */
  async #runFly(
    agentName: string,
    agentDir: string,
    apiKeyEnv: string,
    key: string | undefined,
    onProgress: DeployProgress,
    onLog: DeployLog,
  ): Promise<string> {
    const token = process.env.FLY_API_TOKEN;
    if (!token) {
      throw new DeployError(
        "Fly.io deploy needs FLY_API_TOKEN (and a Fly.io account). Set it in the environment, then retry.",
      );
    }
    ensureCli("flyctl", "The Fly.io CLI (flyctl) is not available. Install flyctl, then retry.");
    const flyEnv = { ...process.env, FLY_API_TOKEN: token };
    const app = flyAppName(agentName);
    writeFileSync(join(agentDir, "fly.toml"), flyToml(app));

    onProgress("building", `fly app ${app}`);
    // Create the app (idempotent — a duplicate just errors, which we ignore).
    spawnSync("flyctl", ["apps", "create", app, "--org", "personal"], { stdio: "pipe", encoding: "utf8", env: flyEnv });

    // Stage the provider key as a Fly secret (applied on the next deploy).
    if (key) {
      const sec = spawnSync("flyctl", ["secrets", "import", "--app", app, "--stage"], {
        cwd: agentDir,
        input: `${apiKeyEnv}=${key}\n`,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
        env: flyEnv,
      });
      if (sec.status !== 0) throw new DeployError(`flyctl secrets import failed:\n${sec.stderr || sec.stdout}`);
    }

    onProgress("deploying", "flyctl deploy");
    const deploy = await spawnStreaming(
      "flyctl",
      ["deploy", "--app", app, "--remote-only", "--yes"],
      { cwd: agentDir, env: flyEnv },
      onLog,
    );
    if (deploy.status !== 0) throw new DeployError(`flyctl deploy failed:\n${deploy.output}`);

    const baseUrl = `https://${app}.fly.dev`;
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

/**
 * Run a command, streaming its combined stdout/stderr to `onLog` line-by-line as
 * it arrives (so the UI shows live progress), and resolving with the exit status
 * + full captured output. Never rejects.
 */
function spawnStreaming(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  onLog: DeployLog,
): Promise<{ status: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let buf = "";
    const onChunk = (data: Buffer): void => {
      const text = data.toString();
      output += text;
      buf += text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      if (lines.length) onLog(lines);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => {
      onLog([err.message]);
      resolve({ status: 1, output: `${output}\n${err.message}` });
    });
    child.on("close", (code) => {
      if (buf) onLog([buf]);
      resolve({ status: code ?? 0, output });
    });
  });
}

// ── shared @flue install ────────────────────────────────────────────────────

/**
 * Deployed agents resolve `@flue/runtime` (and the build resolves `@flue/cli`) by
 * walking up to `<base>/node_modules`. If that's already resolvable — the
 * monorepo dev tree, or a previous deploy — skip the install. Otherwise write a
 * tiny package.json next to the agents and `npm install` once.
 */
async function ensureSharedFlue(base: string, onProgress: DeployProgress, onLog: DeployLog): Promise<void> {
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
  const install = await spawnStreaming("npm", ["install"], { cwd: base }, onLog);
  if (install.status !== 0) throw new DeployError(`installing the Flue runtime failed:\n${install.output}`);
}

/**
 * A reachable `flue` CLI shim up the tree implies @flue/runtime is installed in
 * the same node_modules — enough to skip the install. (We can't `require.resolve`
 * @flue/runtime: it is ESM-only and has no CJS "require" export.)
 */
function canResolveFlue(base: string): boolean {
  return findBin(base, "flue") !== null;
}

/** Find a CLI shim (`flue`, `wrangler`, …) in any node_modules/.bin up the tree from `base`. */
function findBin(base: string, name: string): string | null {
  let dir = base;
  for (;;) {
    const bin = join(dir, "node_modules", ".bin", name);
    if (existsSync(bin)) return bin;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── Cloudflare build deps + GitHub helpers ────────────────────────────────────

/**
 * Cloudflare builds run on the HOST (not in Docker), so the build deps must be
 * resolvable from `<base>`: @flue, the `agents` peer (CF Worker entry imports it),
 * and `wrangler` (deploy + secrets). Installed once; skipped if already present.
 */
async function ensureCloudflareDeps(base: string, onProgress: DeployProgress, onLog: DeployLog): Promise<void> {
  if (findBin(base, "flue") && findBin(base, "wrangler")) return;
  onProgress("installing", "Cloudflare build tools (first cloudflare deploy — this can take a minute)");
  writeFileSync(
    join(base, "package.json"),
    JSON.stringify(
      {
        name: "fleet-deployed",
        private: true,
        dependencies: { "@flue/runtime": FLUE_VERSION, agents: AGENTS_VERSION },
        devDependencies: { "@flue/cli": FLUE_VERSION, wrangler: WRANGLER_VERSION },
      },
      null,
      2,
    ),
  );
  const install = await spawnStreaming("npm", ["install"], { cwd: base }, onLog);
  if (install.status !== 0) throw new DeployError(`installing the Cloudflare build tools failed:\n${install.output}`);
}

/** Find the `flue build --target cloudflare` output dir (the one holding wrangler.json). */
function findCfOutputDir(distDir: string): string | null {
  if (!existsSync(distDir)) return null;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(distDir, entry.name, "wrangler.json"))) {
      return join(distDir, entry.name);
    }
  }
  return null;
}

/** Assert a CLI is on PATH (`cmd --version` succeeds). */
function ensureCli(cmd: string, message: string): void {
  const probe = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  if (probe.status !== 0) throw new DeployError(message);
}

/** Run a git command in `dir`, throwing on failure. */
function git(dir: string, args: string[]): void {
  const res = spawnSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
  if (res.status !== 0) throw new DeployError(`git ${args.join(" ")} failed:\n${res.stderr || res.stdout}`);
}

/** Extract the first GitHub repo URL from `gh` output. */
function parseRepoUrl(out: string): string | null {
  return out.match(/https:\/\/github\.com\/[^\s]+/)?.[0] ?? null;
}

/** Extract the first `*.workers.dev` URL from wrangler output. */
function parseWorkersUrl(out: string): string | null {
  return out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0] ?? null;
}

/** A globally-unique, Fly-valid app name: lowercase-alnum-dashes + a short suffix. */
function flyAppName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `fleet-${slug}-${suffix}`.slice(0, 30).replace(/-+$/g, "");
}

/** Minimal fly.toml for the agent container (the Dockerfile EXPOSEs 8080). */
function flyToml(app: string): string {
  return `# Generated by Fleet at deploy time.
app = "${app}"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0
`;
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
