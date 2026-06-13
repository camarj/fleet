/**
 * EngramServerDeployer — deploys the per-org Engram cloud server (the shared
 * memory backend) to a self-hosted Dokploy instance as a `docker-compose` stack.
 *
 * The stack has two services (design DA-01):
 *   - `cloud`    — `engram cloud serve`, the memory sync server (port 18080)
 *   - `postgres` — `postgres:16-alpine`, the chunk store the cloud server uses
 *
 * Why compose (not application.*): a Dokploy application is ONE container; this
 * needs two services with a healthcheck + `depends_on` ordering, which only the
 * compose family models (DA-01). The server runs in AUTH mode (DA-03): the token
 * and JWT secret are injected through Dokploy's `env` field, NEVER baked into the
 * committed compose file (rule #8) — the YAML only references them as `${VAR}`.
 *
 * Reuses `dokployApi` + `resolveDokployTarget` from flue-deployer.ts so there is a
 * single Dokploy HTTP client and one project/environment resolution path.
 *
 * exported for tests — pass fetchImpl and pollIntervalMs to inject fakes.
 */

import { DeployError, dokployApi, resolveDokployTarget, type DeployLog, type DeployProgress } from "./flue-deployer.js";

/**
 * Pinned Engram server image (preflight TASK-01, verified live 2026-06-13).
 * MUST stay byte-identical to the tag the converted agent installs (DA-02 = DA-04)
 * so server and client are version-locked — no runtime skew (R1/E-03).
 */
export const ENGRAM_IMAGE = "ghcr.io/gentleman-programming/engram:1.16.3";
/** Postgres image backing the cloud server's chunk store. */
export const ENGRAM_POSTGRES_IMAGE = "postgres:16-alpine";
/** Port the `engram cloud serve` process listens on inside the container. */
export const ENGRAM_SERVER_PORT = 18080;

const POLL_INTERVAL_MS = 5_000;
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

/**
 * Obvious development defaults the upstream binary rejects (and that we reject
 * up-front for a clear error instead of a cryptic boot crash — MEM-02/E-04).
 */
const WEAK_JWT_SECRETS = new Set([
  "",
  "change-me",
  "changeme",
  "dev",
  "development",
  "secret",
  "insecure",
  "default",
  "test",
]);

/** The secret values injected through Dokploy's `env` (never into the YAML). */
export interface EngramServerSecrets {
  /** ENGRAM_CLOUD_TOKEN — the org bearer token agents authenticate with. */
  cloudToken: string;
  /** ENGRAM_JWT_SECRET — MUST be non-default (the binary rejects the dev default). */
  jwtSecret: string;
  /** POSTGRES_PASSWORD — backing Postgres password. */
  postgresPassword: string;
}

export interface DeployEngramServerOptions {
  cfg: { url: string; key: string };
  /** Org slug — names the compose `engram-cloud-<orgSlug>` (one per org). */
  orgSlug: string;
  /** Engram project keys allowed to sync (ENGRAM_CLOUD_ALLOWED_PROJECTS, MEM-11). */
  allowedProjects: string[];
  /** Secret values — sourced from the secrets store / operator env, never the repo. */
  secrets: EngramServerSecrets;
  onProgress: DeployProgress;
  onLog: DeployLog;
  /** Resolved DOKPLOY_PROJECT (store wins over the env var of the same name). */
  projectName?: string;
  /** Override fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
  /** Override poll interval in ms (use 0 for fast tests). */
  pollIntervalMs?: number;
}

export interface EngramServerDeployResult {
  /** The Dokploy compose id of the deployed (or redeployed) stack. */
  composeId: string;
  /** The compose name (`engram-cloud-<orgSlug>`). */
  composeName: string;
  /** True when an existing compose was redeployed instead of created (idempotency). */
  reused: boolean;
}

/**
 * Build the compose YAML for the Engram server stack. Secret values are NEVER
 * written here — they are referenced as `${VAR}` and resolved by Dokploy from the
 * `env` field of `compose.update` (rule #8 / DA-03). The shape mirrors the
 * upstream `docker-compose.cloud.yml`, adapted for prod (official pinned image +
 * auth mode, no INSECURE_NO_AUTH).
 */
export function buildEngramComposeFile(): string {
  return `services:
  postgres:
    image: ${ENGRAM_POSTGRES_IMAGE}
    environment:
      POSTGRES_USER: engram
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: engram_cloud
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U engram -d engram_cloud"]
      interval: 5s
      timeout: 3s
      retries: 10
    volumes:
      - engram-cloud-pg:/var/lib/postgresql/data
  cloud:
    image: ${ENGRAM_IMAGE}
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      ENGRAM_DATABASE_URL: postgres://engram:\${POSTGRES_PASSWORD}@postgres:5432/engram_cloud?sslmode=disable
      ENGRAM_JWT_SECRET: \${ENGRAM_JWT_SECRET}
      ENGRAM_CLOUD_TOKEN: \${ENGRAM_CLOUD_TOKEN}
      ENGRAM_CLOUD_ALLOWED_PROJECTS: \${ENGRAM_CLOUD_ALLOWED_PROJECTS}
      ENGRAM_CLOUD_HOST: 0.0.0.0
      ENGRAM_PORT: "${ENGRAM_SERVER_PORT}"
    command: ["cloud", "serve"]
    ports: ["${ENGRAM_SERVER_PORT}:${ENGRAM_SERVER_PORT}"]
volumes:
  engram-cloud-pg:
`;
}

/**
 * Slugify an org name into a DNS-safe compose-name segment. Lowercases, replaces
 * runs of non-alphanumerics with a single hyphen, trims leading/trailing hyphens.
 */
export function orgSlugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "default";
}

/**
 * Build the newline-separated `env` payload for `compose.update`. These are the
 * ONLY place secret values live — referenced as `${VAR}` in the YAML and resolved
 * by Dokploy at deploy time. ENGRAM_CLOUD_ALLOWED_PROJECTS is config, not a secret.
 */
function buildEnvPayload(secrets: EngramServerSecrets, allowedProjects: string[]): string {
  const allowed = allowedProjects.map((p) => p.trim()).filter(Boolean).join(",");
  return [
    `POSTGRES_PASSWORD=${secrets.postgresPassword}`,
    `ENGRAM_JWT_SECRET=${secrets.jwtSecret}`,
    `ENGRAM_CLOUD_TOKEN=${secrets.cloudToken}`,
    `ENGRAM_CLOUD_ALLOWED_PROJECTS=${allowed}`,
  ].join("\n");
}

/**
 * Validate the secret inputs BEFORE touching Dokploy so a bad config fails with a
 * clear, actionable message rather than a cryptic container crash (MEM-02/E-04).
 */
function validateSecrets(secrets: EngramServerSecrets): void {
  if (!secrets.cloudToken) {
    throw new DeployError(
      "Engram server deploy needs ENGRAM_CLOUD_TOKEN (the org bearer token). Set it in Settings → Infrastructure (or export it), then retry.",
    );
  }
  if (!secrets.postgresPassword) {
    throw new DeployError(
      "Engram server deploy needs POSTGRES_PASSWORD. Set it in Settings → Infrastructure (or export it), then retry.",
    );
  }
  const jwt = secrets.jwtSecret ?? "";
  // The engram binary HARD-REQUIRES ≥32 bytes ("jwt secret must be at least 32
  // bytes") — verified live 2026-06-13. A shorter secret crashes the server on
  // boot, so reject it up-front with a clear message instead.
  if (WEAK_JWT_SECRETS.has(jwt.toLowerCase()) || Buffer.byteLength(jwt, "utf8") < 32) {
    throw new DeployError(
      "Engram server deploy needs a strong, non-default ENGRAM_JWT_SECRET (≥32 bytes; the binary rejects shorter or default secrets). Set it in Settings → Infrastructure (or export it), then retry.",
    );
  }
}

type DokployCompose = { composeId: string; name: string; environmentId?: string; composeStatus?: string };

/**
 * Deploy (or redeploy, idempotently) the Engram cloud server stack to Dokploy:
 *
 *   resolve project/environment  →  compose.create (if new)
 *   →  compose.update(sourceType:"raw", composeFile, env)
 *   →  compose.deploy (new) | compose.redeploy (existing)  →  poll until live
 *
 * Idempotent: an existing `engram-cloud-<orgSlug>` compose in the same
 * environment is reused (redeployed), never duplicated (MEM-01).
 */
export async function deployEngramServer(opts: DeployEngramServerOptions): Promise<EngramServerDeployResult> {
  const { cfg, orgSlug, allowedProjects, secrets, onProgress, onLog } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const api = (method: "GET" | "POST", procedure: string, body?: unknown) =>
    dokployApi(cfg, method, procedure, body, fetchImpl);

  // Fail fast on bad secrets before any Dokploy round-trip (MEM-02/E-04).
  validateSecrets(secrets);

  const composeName = `engram-cloud-${orgSlug}`;

  // 1. Resolve project + default environment. resolveDokployTarget runs project.all
  //    and returns the environment with its nested resources already populated.
  onProgress("deploying", "resolving Dokploy project and environment");
  onLog(["[engram] resolving project and environment…"]);
  const { project, defaultEnv } = await resolveDokployTarget(api, {
    agentName: composeName,
    projectName: opts.projectName,
  });
  onLog([`[engram] project="${project.name}" environment="${defaultEnv.name}"`]);

  // 2. Detect an existing compose for this org (idempotency, MEM-01). Dokploy has
  //    NO compose.all endpoint (verified 404 in preflight TASK-01); the environment
  //    returned by project.all already carries its composes nested under `compose`,
  //    so we match by name there — names are unique per environment, no extra call.
  const existing = (defaultEnv.compose ?? []).find((c) => c.name === composeName);

  // 3. Create the compose record if it does not exist yet.
  let composeId: string;
  const reused = !!existing;
  if (existing) {
    composeId = existing.composeId;
    onLog([`[engram] reusing existing compose "${composeName}" (${composeId})`]);
  } else {
    onLog([`[engram] creating compose "${composeName}"…`]);
    const created = (await api("POST", "compose.create", {
      name: composeName,
      environmentId: defaultEnv.environmentId,
      composeType: "docker-compose",
    })) as { composeId: string };
    if (!created?.composeId) {
      throw new DeployError("Dokploy compose.create did not return a composeId. Check the instance supports the compose.* API.");
    }
    composeId = created.composeId;
    onLog([`[engram] compose created (${composeId})`]);
  }

  // 4. Push the raw compose + inject the secret values via env. The committed
  //    composeFile only references ${VAR}; values live ONLY in this env payload.
  onProgress("deploying", "configuring compose");
  onLog(["[engram] uploading compose definition and secrets…"]);
  await api("POST", "compose.update", {
    composeId,
    sourceType: "raw",
    composeFile: buildEngramComposeFile(),
    env: buildEnvPayload(secrets, allowedProjects),
  });

  // 5. Deploy (new) or redeploy (existing) — both are idempotent on Dokploy.
  onProgress("deploying", reused ? "redeploying Engram server" : "deploying Engram server");
  onLog([`[engram] triggering ${reused ? "redeploy" : "deploy"}…`]);
  await api("POST", reused ? "compose.redeploy" : "compose.deploy", { composeId });

  // 6. Poll until the stack reaches a terminal state. Dokploy compose status is
  //    assumed to mirror the application enum (idle|running|done|error); we accept
  //    "running"/"done" as ready and "error" as failure. (Live-verified in PR4.)
  onLog(["[engram] waiting for the server to become ready…"]);
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    let status: string | undefined;
    try {
      const state = (await api("GET", "compose.one", { composeId })) as DokployCompose;
      status = state?.composeStatus;
    } catch (err) {
      onLog([`[engram] status poll error (will retry): ${(err as Error).message}`]);
      continue;
    }
    onLog([`[engram] deployment status: ${status ?? "unknown"}`]);
    if (status === "done" || status === "running") {
      ready = true;
      break;
    }
    if (status === "error") {
      throw new DeployError(
        "Engram server deployment failed. Check the compose logs in your Dokploy dashboard for details.",
      );
    }
  }
  if (!ready) {
    throw new DeployError(
      "Engram server deployment timed out after 10 minutes. Check the compose logs in your Dokploy dashboard.",
    );
  }

  onProgress("done", composeName);
  onLog([`[engram] server "${composeName}" is live (${composeId})`]);
  return { composeId, composeName, reused };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
