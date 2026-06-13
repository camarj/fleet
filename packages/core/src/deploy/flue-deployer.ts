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
import { convert, resolveModel, writeFlueProject, type UnmappedItem } from "@inteliside/gateway-converter";
import { FlueAdapter } from "../adapters/flue.js";
import { deployEngramServer, type EngramServerDeployResult } from "./engram-server-deployer.js";
import { deployedDir } from "../paths.js";
import type { PreflightCheck } from "../api.js";
import type { SecretsStore } from "../secrets/store.js";

const FLUE_VERSION = "0.10.1";
const AGENTS_VERSION = "0.15.0"; // Cloudflare Agents SDK — peer dep of the CF Worker build
const WRANGLER_VERSION = "4.98.0"; // Cloudflare deploy + secrets CLI

/**
 * Infrastructure credential ids — the env-var names used for the remote deploy
 * targets. These ride the same SecretsStore as provider API keys: a value stored
 * under this id takes precedence over the environment variable of the same name.
 * Mirrored in frontend/src/lib/providers.ts (the frontend deliberately does not
 * import the Core).
 */
export const INFRA_CREDENTIAL_IDS: readonly string[] = [
  "FLY_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "DOKPLOY_URL",
  "DOKPLOY_API_KEY",
  "DOKPLOY_PROJECT",
  "DOKPLOY_GITHUB_ID",
  "DOKPLOY_DOMAIN",
  // J4 — Engram cloud shared-memory server secrets (compose env, never the repo).
  "ENGRAM_CLOUD_TOKEN",
  "ENGRAM_JWT_SECRET",
  "POSTGRES_PASSWORD",
] as const;

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
 *   wire it to a self-hosted Docker PaaS (Coolify, …). Produces an ARTIFACT (a
 *   repo URL), not a running agent — connect Fleet by URL once it runs.
 * - `cloudflare`: `flue build --target cloudflare` + `wrangler deploy` to a Workers
 *   `*.workers.dev` URL, then connect. Needs `CLOUDFLARE_API_TOKEN`.
 * - `dokploy`: push the project as a GitHub repo, then drive a self-hosted Dokploy
 *   instance via its REST API to create, configure, deploy, and wait for the agent.
 *   Returns the live base URL and connects automatically. Needs `DOKPLOY_URL` +
 *   `DOKPLOY_API_KEY` (and the Dokploy instance must have a GitHub App connected).
 */
export type DeployTarget = "docker-local" | "local-process" | "fly" | "github" | "cloudflare" | "dokploy";

export interface DeployRequest {
  sourceDir: string;
  provider?: string;
  model?: string;
  target?: DeployTarget;
  /** GitHub account or organization that receives the generated repo. Defaults to
   * the authenticated user's personal account when unset. Applies to `github` and
   * `dokploy` targets only; ignored for all other targets. */
  repoOwner?: string;
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
  /** Features of the source project that did not convert to Flue (surfaced to the user). */
  unmapped: UnmappedItem[];
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
  /** Features of the source project that did not convert to Flue (surfaced to the user). */
  unmapped: UnmappedItem[];
}

export type DeployResult = DeployedAgent | DeployArtifact;

const INTERNAL_PORT = 8080; // the port the Flue server listens on inside the container

export class FlueDeployer {
  readonly #secrets: SecretsStore;
  /** Maps agentName → child process for local-process deploys. */
  readonly #processes = new Map<string, ChildProcess>();
  readonly #containers = new Set<string>();

  constructor(secrets: SecretsStore) {
    this.#secrets = secrets;
  }

  /**
   * Resolve an infrastructure credential: SecretsStore wins over the env var of
   * the same name, matching the provider-key lookup order used in deploy().
   */
  #infraCred(id: string): string | undefined {
    return this.#secrets.get(id) ?? process.env[id];
  }

  /**
   * Preflight check for an infrastructure credential (store OR env var).
   * Mirrors checkEnvToken's id derivation (lowercase-kebab) but is store-aware.
   */
  #checkInfraCred(id: string, label: string, missingDetail: string): PreflightCheck {
    const ok = !!this.#infraCred(id);
    return { id: id.toLowerCase().replace(/_/g, "-"), label, ok, detail: ok ? undefined : missingDetail };
  }

  async deploy(req: DeployRequest, onProgress: DeployProgress, onLog: DeployLog = NO_LOG): Promise<DeployResult> {
    const target: DeployTarget = req.target ?? "docker-local";

    // Convert the Claude Code project to a Flue project (deterministic).
    onProgress("converting");
    const project = convert(req.sourceDir, {
      provider: req.provider,
      model: req.model,
      target: target === "cloudflare" ? "cloudflare" : "node",
    });
    const agentName = project.report.agentName;
    const unmapped = project.report.unmapped;
    const agentDir = join(deployedDir(), agentName);
    rmSync(agentDir, { recursive: true, force: true });
    writeFlueProject(project, agentDir);

    // `github` publishes a repo for CI to build — there is nothing to connect to yet.
    if (target === "github") {
      return { ...(await this.#runGithub(agentName, agentDir, req.repoOwner, onProgress, onLog)), unmapped };
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
      case "dokploy":
        baseUrl = await this.#runDokploy(agentName, agentDir, apiKeyEnv, key, req.repoOwner, onProgress, onLog);
        break;
      default:
        baseUrl = await this.#runLocalProcess(agentName, agentDir, apiKeyEnv, key, onProgress, onLog);
    }

    onProgress("connecting");
    const adapter = await FlueAdapter.connect({ baseUrl, agentName });
    onProgress("done");
    return { kind: "connected", adapter, agentName, baseUrl, target, unmapped };
  }

  /**
   * Deploy (or idempotently redeploy) the per-org Engram cloud shared-memory
   * server to Dokploy (J4 — MEM-01/MEM-02). Resolves the Dokploy credentials and
   * the server secrets from the SecretsStore / operator env (the same #infraCred
   * lookup as agent deploys) and delegates the compose orchestration to
   * `deployEngramServer`. Secret VALUES are injected through Dokploy's compose
   * `env` field — never written to the repo (rule #8).
   *
   * Requires DOKPLOY_URL + DOKPLOY_API_KEY, plus ENGRAM_CLOUD_TOKEN,
   * ENGRAM_JWT_SECRET (non-default) and POSTGRES_PASSWORD.
   */
  async deployEngramServer(opts: {
    orgSlug: string;
    allowedProjects: string[];
    onProgress: DeployProgress;
    onLog?: DeployLog;
  }): Promise<EngramServerDeployResult> {
    const onLog = opts.onLog ?? NO_LOG;
    const dokployUrl = this.#infraCred("DOKPLOY_URL");
    const dokployKey = this.#infraCred("DOKPLOY_API_KEY");
    if (!dokployUrl || !dokployKey) {
      throw new DeployError(
        "Engram server deploy needs DOKPLOY_URL and DOKPLOY_API_KEY. Set them in Settings → Infrastructure (or export them), then retry.",
      );
    }
    return deployEngramServer({
      cfg: { url: dokployUrl, key: dokployKey },
      orgSlug: opts.orgSlug,
      allowedProjects: opts.allowedProjects,
      secrets: {
        cloudToken: this.#infraCred("ENGRAM_CLOUD_TOKEN") ?? "",
        jwtSecret: this.#infraCred("ENGRAM_JWT_SECRET") ?? "",
        postgresPassword: this.#infraCred("POSTGRES_PASSWORD") ?? "",
      },
      projectName: this.#infraCred("DOKPLOY_PROJECT"),
      onProgress: opts.onProgress,
      onLog,
    });
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
    this.#processes.set(agentName, child);
    child.on("exit", () => this.#processes.delete(agentName));

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitReady(baseUrl);
    return baseUrl;
  }

  /**
   * Push the converted project to a new (or existing) GitHub repo.
   * Shared by `#runGithub` (which returns it as an artifact) and `#runDokploy`
   * (which then drives the Dokploy API against the pushed code).
   *
   * Idempotency: if `gh repo create` fails because the repo already exists,
   * recovers by resolving the URL via `gh repo view`, (re-)setting the remote,
   * and force-pushing main — so re-deploying the same agent works cleanly.
   */
  async #pushToGithub(
    agentName: string,
    agentDir: string,
    repoOwner: string | undefined,
    onProgress: DeployProgress,
    onLog: DeployLog,
  ): Promise<{ url: string; owner: string; repo: string }> {
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
    const repoName = `fleet-agent-${agentName}`;
    // Use an owner-qualified name (org/repo) when the caller specifies an owner;
    // bare name when not (gh defaults to the authenticated user's personal account).
    const qualifiedName = repoOwner ? `${repoOwner}/${repoName}` : repoName;
    const res = await spawnStreaming(
      "gh",
      ["repo", "create", qualifiedName, "--private", "--source", ".", "--push"],
      { cwd: agentDir },
      onLog,
    );

    let url: string;
    let owner: string;
    let repo: string;

    if (res.status !== 0) {
      if (!/already exists/i.test(res.output)) {
        throw new DeployError(`gh repo create failed:\n${res.output}`);
      }
      // Repo already exists — recover: get URL, set remote, force-push.
      onLog([`[github] repo "${qualifiedName}" already exists — recovering…`]);
      const viewRes = spawnSync("gh", ["repo", "view", qualifiedName, "--json", "url", "--jq", ".url"], {
        stdio: "pipe",
        encoding: "utf8",
      });
      url = viewRes.stdout?.trim() ?? "";
      if (!url) {
        throw new DeployError(
          `Repo "${qualifiedName}" already exists but its URL could not be resolved. ` +
          `Run \`gh repo view ${qualifiedName}\` to confirm and set the remote manually.`,
        );
      }
      // Set or update the remote.
      const remoteOk = spawnSync("git", ["remote", "get-url", "origin"], {
        cwd: agentDir, stdio: "pipe", encoding: "utf8",
      }).status === 0;
      if (remoteOk) {
        spawnSync("git", ["remote", "set-url", "origin", url], { cwd: agentDir, stdio: "ignore" });
      } else {
        spawnSync("git", ["remote", "add", "origin", url], { cwd: agentDir, stdio: "ignore" });
      }
      const pushRes = await spawnStreaming("git", ["push", "-f", "origin", "main"], { cwd: agentDir }, onLog);
      if (pushRes.status !== 0) throw new DeployError(`git push -f origin main failed:\n${pushRes.output}`);
      const parsed = parseOwnerRepo(url);
      if (!parsed) throw new DeployError(`Could not parse owner/repo from URL: ${url}`);
      owner = parsed.owner;
      repo = parsed.repo;
    } else {
      url = parseRepoUrl(res.output) ?? `https://github.com/<your-account>/${repoName}`;
      const parsed = parseOwnerRepo(url);
      owner = parsed?.owner ?? "<your-account>";
      repo = parsed?.repo ?? repoName;
    }

    return { url, owner, repo };
  }

  /**
   * Publish the converted project as a GitHub repo whose CI builds the image to
   * GHCR. Returns the repo URL (an artifact — nothing is running yet). The user
   * deploys the published image on a host and connects Fleet by URL.
   */
  async #runGithub(
    agentName: string,
    agentDir: string,
    repoOwner: string | undefined,
    onProgress: DeployProgress,
    onLog: DeployLog,
  ): Promise<Omit<DeployArtifact, "unmapped">> {
    const { url } = await this.#pushToGithub(agentName, agentDir, repoOwner, onProgress, onLog);
    onProgress("done");
    return {
      kind: "artifact",
      agentName,
      target: "github",
      url,
      message:
        "Repo published with its Dockerfile. Point a self-hosted Docker PaaS (Coolify, …) " +
        "at it to build and run the agent, then connect Fleet to the running URL.",
    };
  }

  /**
   * Push the project to GitHub, then drive a Dokploy instance (via its REST API)
   * to create/configure/deploy the agent and wait until it is live. Returns the
   * `baseUrl` so the generic `deploy()` tail can connect the FlueAdapter.
   *
   * Requires DOKPLOY_URL + DOKPLOY_API_KEY — set them in Settings → Infrastructure
   * or export them as env vars (preflight checks these). The Dokploy instance must
   * have a GitHub App connected in its UI.
   */
  async #runDokploy(
    agentName: string,
    agentDir: string,
    apiKeyEnv: string,
    key: string | undefined,
    repoOwner: string | undefined,
    onProgress: DeployProgress,
    onLog: DeployLog,
  ): Promise<string> {
    const dokployUrl = this.#infraCred("DOKPLOY_URL");
    const dokployKey = this.#infraCred("DOKPLOY_API_KEY");
    // Should never reach here with missing creds (preflight guards them), but
    // fail fast with a clear message rather than a cryptic network error.
    if (!dokployUrl || !dokployKey) {
      throw new DeployError(
        "Dokploy deploy needs DOKPLOY_URL and DOKPLOY_API_KEY. Set them in Settings → Infrastructure (or export them), then retry.",
      );
    }
    const { owner, repo } = await this.#pushToGithub(agentName, agentDir, repoOwner, onProgress, onLog);
    const baseUrl = await runDokployOrchestration({
      cfg: { url: dokployUrl, key: dokployKey },
      agentName,
      apiKeyEnv,
      key,
      owner,
      repo,
      githubId: this.#infraCred("DOKPLOY_GITHUB_ID"),
      projectName: this.#infraCred("DOKPLOY_PROJECT"),
      domain: this.#infraCred("DOKPLOY_DOMAIN"),
      onProgress,
      onLog,
    });
    // Dokploy reports "done" when the BUILD finishes; the container swap and
    // app boot happen after that and routinely exceed the default 60 s window
    // (seen live: agent up ~2 min after status done). Give it 3 minutes.
    await waitReady(baseUrl, 180_000);
    return baseUrl;
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
    const token = this.#infraCred("CLOUDFLARE_API_TOKEN");
    if (!token) {
      throw new DeployError(
        "Cloudflare deploy needs CLOUDFLARE_API_TOKEN (and a Cloudflare account). Set it in Settings → Infrastructure (or export CLOUDFLARE_API_TOKEN), then retry.",
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

    // Build-success guard. The build emits the worker to dist/<worker>/wrangler.json
    // AND a `.wrangler/deploy/config.json` redirect at the project root pointing to it.
    const outDir = findCfOutputDir(join(agentDir, "dist"));
    if (!outDir) throw new DeployError("the Cloudflare build did not produce a deployable dist/<worker>/ directory.");

    const wranglerBin = findBin(base, "wrangler");
    if (!wranglerBin) throw new DeployError("could not find wrangler after installing the Cloudflare build deps.");
    const cfEnv = { ...process.env, CLOUDFLARE_API_TOKEN: token };

    // Run wrangler from the PROJECT ROOT (agentDir), not the dist output dir. The
    // modern Flue/Cloudflare-Vite build writes a deploy-config redirect at
    // <agentDir>/.wrangler/deploy/config.json → dist/<worker>/wrangler.json.
    // Running inside dist/<worker> makes wrangler find that built wrangler.json
    // AND the redirect two levels up, on different base paths → it aborts with
    // "not clear which should be used". From the root the redirect resolves cleanly.
    onProgress("deploying", "wrangler deploy");
    const deploy = await spawnStreaming(wranglerBin, ["deploy"], { cwd: agentDir, env: cfEnv }, onLog);
    if (deploy.status !== 0) throw new DeployError(`wrangler deploy failed:\n${deploy.output}`);

    const baseUrl = parseWorkersUrl(deploy.output);
    if (!baseUrl) {
      throw new DeployError(`could not determine the deployed Worker URL from wrangler output:\n${deploy.output}`);
    }

    // Store the model provider key as a Worker secret (stdin → never in argv/repo).
    // Also from the project root so the same deploy-config redirect targets the worker.
    if (key) {
      const secret = spawnSync(wranglerBin, ["secret", "put", apiKeyEnv], {
        cwd: agentDir,
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
    const token = this.#infraCred("FLY_API_TOKEN");
    if (!token) {
      throw new DeployError(
        "Fly.io deploy needs FLY_API_TOKEN (and a Fly.io account). Set it in Settings → Infrastructure (or export FLY_API_TOKEN), then retry.",
      );
    }
    ensureCli("flyctl", "The Fly.io CLI (flyctl) is not available. Install flyctl, then retry.");
    const flyEnv = { ...process.env, FLY_API_TOKEN: token };
    const app = flyAppName(agentName);
    writeFileSync(join(agentDir, "fly.toml"), flyToml(app));

    onProgress("building", `fly app ${app}`);
    // Create the app. A name collision is fine (idempotent re-run), but any other
    // failure must surface its REAL error — otherwise the later `secrets import`
    // / `deploy` fails with a confusing "Could not find App", hiding the actual
    // cause (e.g. a high-risk account that needs verification, an invalid org, or
    // a deploy-scoped token that can't create apps).
    const created = spawnSync("flyctl", ["apps", "create", app, "--org", "personal"], {
      stdio: "pipe",
      encoding: "utf8",
      env: flyEnv,
    });
    if (created.status !== 0) {
      const detail = (created.stderr || created.stdout || "").trim();
      const alreadyExists = /already.*(taken|exist)/i.test(detail);
      if (!alreadyExists) {
        throw new DeployError(`flyctl apps create failed:\n${detail}`);
      }
    }

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

  /**
   * Stop a single deployed agent's runtime (called by GatewayCore on agent.stop / agent.delete).
   * For docker-local: removes the container. For local-process: kills the child.
   * For dokploy: stops the remote application via the Dokploy API (best-effort; the
   * application record, domain, and GitHub repo are NOT deleted).
   * For fly, cloudflare, github: no-op — remote infra teardown must be done manually
   * (flyctl/wrangler/PaaS UI).
   */
  async stopDeployment(agentName: string, target: DeployTarget): Promise<void> {
    if (target === "docker-local") {
      const container = `fleet-${agentName}`;
      spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      this.#containers.delete(container);
    } else if (target === "local-process") {
      const child = this.#processes.get(agentName);
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
      this.#processes.delete(agentName);
    } else if (target === "dokploy") {
      const url = this.#infraCred("DOKPLOY_URL");
      const key = this.#infraCred("DOKPLOY_API_KEY");
      // Without credentials there is nothing Fleet can do remotely.
      if (!url || !key) return;
      await stopDokployApplication({
        cfg: { url, key },
        agentName,
        projectName: this.#infraCred("DOKPLOY_PROJECT"),
      });
    }
  }

  /**
   * Run preflight checks for a deploy target and return all results (never throws).
   * Each check is self-contained — ok:false means the deploy would likely fail for
   * that reason, with `detail` carrying an actionable fix hint.
   */
  async preflight(req: { provider?: string; model?: string; target: DeployTarget }): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];

    switch (req.target) {
      case "docker-local":
        checks.push(checkDockerDaemon());
        break;
      case "fly":
        checks.push(checkBinary("flyctl", "flyctl CLI", "Install the Fly.io CLI: https://fly.io/docs/getting-started/installing-flyctl/"));
        checks.push(this.#checkInfraCred("FLY_API_TOKEN", "Fly.io API token (FLY_API_TOKEN)", "Set it in Settings → Infrastructure (or export FLY_API_TOKEN)."));
        break;
      case "cloudflare":
        checks.push(checkWrangler());
        checks.push(this.#checkInfraCred("CLOUDFLARE_API_TOKEN", "Cloudflare API token (CLOUDFLARE_API_TOKEN)", "Set it in Settings → Infrastructure (or export CLOUDFLARE_API_TOKEN)."));
        break;
      case "github":
        checks.push(checkBinary("git", "Git CLI", "Install Git: https://git-scm.com/"));
        checks.push(checkGhAuth());
        break;
      case "dokploy":
        checks.push(checkBinary("git", "Git CLI", "Install Git: https://git-scm.com/"));
        checks.push(checkGhAuth());
        checks.push(this.#checkInfraCred("DOKPLOY_URL", "Dokploy instance URL (DOKPLOY_URL)", "Set it in Settings → Infrastructure (or export DOKPLOY_URL)."));
        checks.push(this.#checkInfraCred("DOKPLOY_API_KEY", "Dokploy API key (DOKPLOY_API_KEY)", "Set it in Settings → Infrastructure (or export DOKPLOY_API_KEY)."));
        break;
      default:
        // local-process: no CLI/daemon check (Node is already running); apiKey below.
        break;
    }

    // All targets EXCEPT github require the provider API key.
    // (github publishes a repo; the key is supplied later by CI / the PaaS.)
    if (req.target !== "github") {
      checks.push(this.#checkApiKey(req.provider, req.model));
    }

    return checks;
  }

  /**
   * Check whether the provider API key is present (secrets store first, then env var).
   * Mirrors the exact logic in `deploy()` — same provider derivation, same lookup order.
   */
  #checkApiKey(provider?: string, model?: string): PreflightCheck {
    try {
      const resolved = resolveModel(undefined, { provider, model });
      const providerId = resolved.provider.id;
      const apiKeyEnv = resolved.provider.apiKeyEnv;
      const key = this.#secrets.get(providerId) ?? process.env[apiKeyEnv];
      return {
        id: "apiKey",
        label: `Provider API key (${providerId} / ${apiKeyEnv})`,
        ok: !!key,
        detail: key
          ? undefined
          : `Set a "${providerId}" key in Settings (env var: ${apiKeyEnv}).`,
      };
    } catch (err) {
      return {
        id: "apiKey",
        label: "Provider API key",
        ok: false,
        detail: (err as Error).message,
      };
    }
  }

  /** Kill every deployed agent (subprocesses + containers). Called on Core shutdown. */
  async shutdown(): Promise<void> {
    for (const child of this.#processes.values()) {
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

// ── preflight helpers ────────────────────────────────────────────────────────

/** Check that the Docker daemon is reachable (`docker info` exit 0). */
function checkDockerDaemon(): PreflightCheck {
  const probe = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
  const ok = probe.status === 0;
  return {
    id: "docker",
    label: "Docker daemon",
    ok,
    detail: ok ? undefined : "Docker daemon is not running — start Docker Desktop (or the Docker service), then Re-check.",
  };
}

/**
 * Check that a CLI binary is available on PATH (`cmd --version` exit 0).
 * The id is the command name itself (e.g. "flyctl", "git").
 */
function checkBinary(cmd: string, label: string, installHint: string): PreflightCheck {
  const probe = spawnSync(cmd, ["--version"], { stdio: "ignore", timeout: 5000 });
  const ok = probe.status === 0;
  return { id: cmd, label, ok, detail: ok ? undefined : installHint };
}

/**
 * Check wrangler availability. The deployer auto-installs wrangler from npm on
 * first Cloudflare deploy, so this check never blocks (ok is always true). We
 * surface whether wrangler is already present so the user has an accurate picture.
 */
function checkWrangler(): PreflightCheck {
  const onPath = spawnSync("wrangler", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0;
  const locally = findBin(deployedDir(), "wrangler") !== null;
  const alreadyInstalled = onPath || locally;
  return {
    id: "wrangler",
    label: "wrangler CLI",
    ok: true, // deployer auto-installs via npm — never blocks the deploy
    detail: alreadyInstalled ? undefined : "Not installed yet — will be auto-installed from npm on first Cloudflare deploy.",
  };
}

/**
 * Check that the GitHub CLI is installed AND authenticated (`gh auth status` exit 0).
 * Mirrors what the github deploy path needs: `gh` on PATH + valid auth.
 */
function checkGhAuth(): PreflightCheck {
  const ghProbe = spawnSync("gh", ["--version"], { stdio: "ignore", timeout: 5000 });
  if (ghProbe.status !== 0) {
    return {
      id: "gh",
      label: "GitHub CLI (gh)",
      ok: false,
      detail: "GitHub CLI is not installed. Install it at https://cli.github.com/, then run `gh auth login`.",
    };
  }
  const authProbe = spawnSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 10000 });
  const ok = authProbe.status === 0;
  return {
    id: "gh",
    label: "GitHub CLI auth (gh auth status)",
    ok,
    detail: ok ? undefined : "Not authenticated. Run `gh auth login` first.",
  };
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

/** Extract owner and repo name from a GitHub HTTPS URL (repo names may contain dots). */
function parseOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com\/([^/\s]+)\/([^/\s]+)/);
  if (!m || !m[1] || !m[2]) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
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

// ── Dokploy API client + orchestration ──────────────────────────────────────

const DOKPLOY_POLL_INTERVAL_MS = 5_000;
const DOKPLOY_DEPLOY_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

/**
 * Minimal Dokploy REST API client. All Dokploy endpoints follow the pattern
 * `<DOKPLOY_URL>/api/<procedure>` with `x-api-key` authentication.
 * GET queries receive params appended as a query string; POSTs send a JSON body.
 * Throws DeployError on any non-2xx response.
 *
 * exported for tests — the fetchImpl parameter allows injection of a fake fetch.
 */
export async function dokployApi(
  cfg: { url: string; key: string },
  method: "GET" | "POST",
  procedure: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  // Accept DOKPLOY_URL with or without a scheme — fetch() needs an absolute
  // URL, and a bare host like "dev1.example.com" otherwise fails to parse.
  const withScheme = /^https?:\/\//i.test(cfg.url) ? cfg.url : `https://${cfg.url}`;
  const base = withScheme.replace(/\/$/, "");
  const headers: Record<string, string> = { "x-api-key": cfg.key, "Content-Type": "application/json" };
  let url = `${base}/api/${procedure}`;
  const init: RequestInit = { method, headers };

  if (method === "GET" && body && typeof body === "object") {
    const qs = new URLSearchParams(body as Record<string, string>).toString();
    url = `${url}?${qs}`;
  } else if (method === "POST" && body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetchImpl(url, init);
  if (!res.ok) {
    const text = await (res as Response).text().catch(() => "");
    throw new DeployError(`Dokploy API ${procedure} failed (${res.status}): ${text}`);
  }
  // Some procedures return an empty body on self-hosted instances (e.g.
  // `application.deploy` enqueues and returns nothing) — `res.json()` would
  // throw "Unexpected end of JSON input". Parse defensively.
  const text = await (res as Response).text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type DokployApp = { applicationId: string; name: string; applicationStatus: string; appName?: string };
type DokployComposeRef = { composeId: string; name: string; composeStatus?: string };
type DokployEnv = {
  name: string;
  environmentId: string;
  isDefault: boolean;
  applications?: DokployApp[];
  compose?: DokployComposeRef[];
};
type DokployProject = { projectId: string; name: string; environments: DokployEnv[] };

/**
 * Resolve the Dokploy project, its default environment, and (when present) the
 * application named `agentName`. Shared by deploy and stop so both follow the
 * same project/environment selection rules (DOKPLOY_PROJECT, single-project
 * fallback, isDefault environment).
 */
export async function resolveDokployTarget(
  api: (method: "GET" | "POST", procedure: string, body?: unknown) => Promise<unknown>,
  opts: { agentName: string; projectName?: string },
): Promise<{ project: DokployProject; defaultEnv: DokployEnv; existingApp: DokployApp | undefined }> {
  const projects = (await api("GET", "project.all")) as DokployProject[];
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new DeployError("No projects found in Dokploy. Create a project first, then retry.");
  }

  let project: DokployProject;
  const projectName = opts.projectName ?? process.env.DOKPLOY_PROJECT;
  if (projectName) {
    // Exact match wins; otherwise fall back to a unique case-insensitive match —
    // Dokploy project names are display names and demanding exact case is friction.
    const wanted = projectName.toLowerCase();
    const ciMatches = projects.filter((p) => p.name.toLowerCase() === wanted);
    const found = projects.find((p) => p.name === projectName) ?? (ciMatches.length === 1 ? ciMatches[0] : undefined);
    if (!found) {
      throw new DeployError(
        `Project "${projectName}" not found (DOKPLOY_PROJECT). Available: ${projects.map((p) => p.name).join(", ")}.`,
      );
    }
    project = found;
  } else if (projects.length === 1) {
    project = projects[0]!;
  } else {
    throw new DeployError(
      `Multiple projects found. Set DOKPLOY_PROJECT to one of: ${projects.map((p) => p.name).join(", ")}.`,
    );
  }

  const envs = project.environments ?? [];
  if (envs.length === 0) {
    throw new DeployError(`Project "${project.name}" has no environments.`);
  }
  const defaultEnv = envs.find((e) => e.isDefault) ?? (envs.length === 1 ? envs[0] : null);
  if (!defaultEnv) {
    throw new DeployError(
      `No default environment in project "${project.name}". Set isDefault on one environment in Dokploy.`,
    );
  }

  const existingApp = (defaultEnv.applications ?? []).find((a) => a.name === opts.agentName);
  return { project, defaultEnv, existingApp };
}

/**
 * Stop the Dokploy application backing a deployed agent (`application.stop`).
 * Best-effort remote companion to local teardown: the application record, its
 * domain, and the pushed GitHub repo are deliberately NOT deleted — only the
 * running container stops. Returns true when a stop was issued, false when no
 * application with that name exists.
 *
 * exported for tests — pass fetchImpl to inject a fake fetch.
 */
export async function stopDokployApplication(opts: {
  cfg: { url: string; key: string };
  agentName: string;
  projectName?: string;
  onLog?: DeployLog;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const onLog = opts.onLog ?? (() => {});
  const api = (method: "GET" | "POST", procedure: string, body?: unknown) =>
    dokployApi(opts.cfg, method, procedure, body, opts.fetchImpl ?? fetch);

  const { existingApp } = await resolveDokployTarget(api, {
    agentName: opts.agentName,
    projectName: opts.projectName,
  });
  if (!existingApp) {
    onLog([`[dokploy] no application named "${opts.agentName}" found — nothing to stop`]);
    return false;
  }

  await api("POST", "application.stop", { applicationId: existingApp.applicationId });
  onLog([`[dokploy] application "${opts.agentName}" (${existingApp.applicationId}) stopped`]);
  return true;
}

/**
 * Drive the Dokploy REST API to create/configure/deploy the agent and poll until
 * it is live. Takes the GitHub owner/repo produced by `#pushToGithub` so this
 * function is testable in isolation without spawning git or gh processes.
 *
 * exported for tests — pass fetchImpl and pollIntervalMs to inject fakes.
 */
export async function runDokployOrchestration(opts: {
  cfg: { url: string; key: string };
  agentName: string;
  apiKeyEnv: string;
  key: string | undefined;
  owner: string;
  repo: string;
  onProgress: DeployProgress;
  onLog: DeployLog;
  /** Override fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
  /** Override poll interval in ms (use 0 for fast tests). */
  pollIntervalMs?: number;
  /** Resolved DOKPLOY_GITHUB_ID (store wins over env var of the same name). */
  githubId?: string;
  /** Resolved DOKPLOY_PROJECT (store wins over env var of the same name). */
  projectName?: string;
  /** Resolved DOKPLOY_DOMAIN (store wins over env var of the same name). */
  domain?: string;
}): Promise<string> {
  const { cfg, agentName, apiKeyEnv, key, owner, repo, onProgress, onLog } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pollIntervalMs = opts.pollIntervalMs ?? DOKPLOY_POLL_INTERVAL_MS;
  const api = (method: "GET" | "POST", procedure: string, body?: unknown) =>
    dokployApi(cfg, method, procedure, body, fetchImpl);

  // 1. Resolve githubId
  onLog(["[dokploy] resolving GitHub provider…"]);
  let githubId: string;
  const resolvedGithubId = opts.githubId ?? process.env.DOKPLOY_GITHUB_ID;
  if (resolvedGithubId) {
    githubId = resolvedGithubId;
    onLog([`[dokploy] using DOKPLOY_GITHUB_ID=${githubId}`]);
  } else {
    const providers = (await api("GET", "github.githubProviders")) as Array<{ githubId: string }>;
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new DeployError(
        "No GitHub App provider found in Dokploy. Connect a GitHub App in Dokploy's Git Providers settings, then retry.",
      );
    }
    if (providers.length > 1) {
      throw new DeployError(
        `Multiple GitHub providers found. Set DOKPLOY_GITHUB_ID to one of: ${providers.map((p) => p.githubId).join(", ")}.`,
      );
    }
    githubId = providers[0]!.githubId;
  }

  // 2. Resolve project + default environment (+ existing application, if any)
  onLog(["[dokploy] resolving project and environment…"]);
  const { project, defaultEnv, existingApp } = await resolveDokployTarget(api, {
    agentName,
    projectName: opts.projectName,
  });

  // 3. Find or create application
  onLog([`[dokploy] project="${project.name}" environment="${defaultEnv.name}"`]);
  let applicationId: string;
  let appName: string;

  if (existingApp) {
    applicationId = existingApp.applicationId;
    appName = existingApp.appName ?? existingApp.name;
    onLog([`[dokploy] reusing existing application "${agentName}" (${applicationId})`]);
  } else {
    onLog([`[dokploy] creating application "${agentName}"…`]);
    const created = (await api("POST", "application.create", {
      name: agentName,
      environmentId: defaultEnv.environmentId,
    })) as { applicationId: string; appName?: string; name?: string };
    applicationId = created.applicationId;
    appName = created.appName ?? created.name ?? agentName;
    onLog([`[dokploy] application created (${applicationId})`]);
  }

  // 4. Configure GitHub source
  onLog(["[dokploy] configuring GitHub source…"]);
  await api("POST", "application.saveGithubProvider", {
    applicationId,
    repository: repo,
    owner,
    branch: "main",
    buildPath: "/",
    githubId,
    triggerType: "push",
  });

  // 5. Configure build type
  onLog(["[dokploy] setting build type to dockerfile…"]);
  await api("POST", "application.saveBuildType", {
    applicationId,
    buildType: "dockerfile",
    dockerfile: "Dockerfile",
    dockerContextPath: null,
    dockerBuildStage: null,
    herokuVersion: null,
    railpackVersion: null,
  });

  // 6. Inject the model provider key as an environment variable
  onLog(["[dokploy] setting provider environment variable…"]);
  await api("POST", "application.saveEnvironment", {
    applicationId,
    env: `${apiKeyEnv}=${key ?? ""}`,
    buildArgs: null,
    buildSecrets: null,
    createEnvFile: false,
  });

  // 7. Domain — reuse on redeploy if possible; otherwise create
  type DomainResult = { host: string; https: boolean; certificateType: string };
  let domainResult: DomainResult | null = null;

  if (existingApp) {
    try {
      const domains = (await api("GET", "domain.byApplicationId", { applicationId })) as DomainResult[];
      if (Array.isArray(domains) && domains.length > 0) {
        const d = domains[0]!;
        domainResult = { host: d.host, https: d.https, certificateType: d.certificateType };
        onLog([`[dokploy] reusing existing domain ${domainResult.host}`]);
      }
    } catch {
      // domain.byApplicationId may not be available on all Dokploy versions — fall through
    }
  }

  if (!domainResult) {
    const customDomain = opts.domain ?? process.env.DOKPLOY_DOMAIN;
    let host: string;
    let tlsEnabled: boolean;
    let certType: string;

    if (customDomain) {
      host = customDomain;
      tlsEnabled = true;
      certType = "letsencrypt";
      onLog([`[dokploy] using custom domain ${host} (https + letsencrypt)`]);
    } else {
      onLog(["[dokploy] generating domain…"]);
      const generated = (await api("POST", "domain.generateDomain", { appName })) as unknown;
      host = typeof generated === "string" ? generated : String(generated);
      tlsEnabled = false;
      certType = "none";
      onLog([`[dokploy] generated domain: ${host}`]);
    }

    onLog(["[dokploy] creating domain record…"]);
    await api("POST", "domain.create", {
      host,
      applicationId,
      port: 8080,
      https: tlsEnabled,
      certificateType: certType,
      domainType: "application",
      path: "/",
    });

    domainResult = { host, https: tlsEnabled, certificateType: certType };
  }

  // 8. Trigger deployment
  onProgress("deploying", "dokploy deploy");
  onLog(["[dokploy] triggering deployment…"]);
  await api("POST", "application.deploy", { applicationId });

  // 9. Poll until the deployment reaches a terminal state
  onLog(["[dokploy] waiting for deployment to complete…"]);
  type AppStatus = { applicationStatus: "idle" | "running" | "done" | "error" };
  const deadline = Date.now() + DOKPLOY_DEPLOY_TIMEOUT_MS;
  let deployDone = false;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const appState = (await api("GET", "application.one", { applicationId })) as AppStatus;
    onLog([`[dokploy] deployment status: ${appState.applicationStatus}`]);
    if (appState.applicationStatus === "done") {
      deployDone = true;
      break;
    }
    if (appState.applicationStatus === "error") {
      throw new DeployError(
        "Dokploy deployment failed. Check the deployment logs in your Dokploy dashboard for details.",
      );
    }
  }
  if (!deployDone) {
    throw new DeployError("Dokploy deployment timed out after 10 minutes. Check the deployment logs in your Dokploy dashboard.");
  }

  return `${domainResult.https ? "https" : "http"}://${domainResult.host}`;
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

/**
 * Ping an agent's root endpoint with a 3 s timeout.
 * Returns true if the server responds with ANY HTTP status (even 4xx/5xx) —
 * the signal is "the process is up and accepting connections", not the status code.
 * (Flue's root path returns a non-2xx; we only need reachability.)
 * Returns false on network errors or timeouts (connection refused, AbortError).
 * Used by the health monitor to detect online→offline and offline→online transitions.
 */
export async function pingAgent(baseUrl: string): Promise<boolean> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    try {
      await fetch(`${baseUrl}/`, { signal: ac.signal });
      return true; // any HTTP response = server is reachable
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function waitReady(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Accept any HTTP response — even 4xx/5xx — as proof the server is listening.
      // (Flue's root path may return 404; we only need to know the process is up.)
      // Cap each attempt so a hanging connection can't silently eat the window.
      await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(3_000) });
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
