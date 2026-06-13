/**
 * Unit test — Engram cloud shared-memory server deploy (J4-PR1).
 *
 * Drives deployEngramServer with an injected fake fetch (no Dokploy instance).
 * Verifies:
 *
 *   1. Fresh deploy: compose.create → compose.update(raw) → compose.deploy, in
 *      order, with the x-api-key header on every call.
 *   2. Secrets hygiene (rule #8 / DA-03): the committed composeFile carries NO
 *      secret values — only ${VAR} refs; the values ride the `env` payload.
 *   3. Idempotent redeploy (MEM-01): an existing compose is reused via
 *      compose.redeploy, never re-created.
 *   4. E-04 (MEM-02): a missing/weak ENGRAM_JWT_SECRET fails fast (DeployError),
 *      before any Dokploy round-trip.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/engram-server-deployer.test.ts
 */

const { deployEngramServer, buildEngramComposeFile, orgSlugFromName, ENGRAM_IMAGE } = await import(
  "../src/deploy/engram-server-deployer.js"
);
const { DeployError } = await import("../src/deploy/flue-deployer.js");
import type { DeployProgress, DeployLog } from "../src/deploy/flue-deployer.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

const NO_PROGRESS: DeployProgress = () => {};
const NO_LOG: DeployLog = () => {};
const FAKE_CFG = { url: "https://dokploy.example.local", key: "test-api-key" };
const EMPTY_BODY = Symbol("empty-body");

const STRONG_SECRETS = {
  cloudToken: "org-token-abc",
  jwtSecret: "a-strong-jwt-secret-value-1234",
  postgresPassword: "pg-pass-xyz",
};

function makeFakeFetch(responses: Record<string, unknown>): {
  fetch: typeof fetch;
  calls: string[];
  apiKeysSeen: string[];
  bodies: Record<string, unknown>;
} {
  const calls: string[] = [];
  const apiKeysSeen: string[] = [];
  const bodies: Record<string, unknown> = {};

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = String(input);
    const method = ((init?.method as string) || "GET").toUpperCase();
    const hdrs = (init?.headers ?? {}) as Record<string, string>;
    if (hdrs["x-api-key"]) apiKeysSeen.push(hdrs["x-api-key"]);
    const procedure = urlStr.match(/\/api\/([^?]+)/)?.[1] ?? "unknown";
    calls.push(`${method}:${procedure}`);
    if (typeof init?.body === "string") {
      try {
        bodies[procedure] = JSON.parse(init.body);
      } catch {
        bodies[procedure] = init.body;
      }
    }
    const data = responses[procedure];
    if (data === undefined) {
      return new Response(JSON.stringify(null), { status: 404, headers: { "Content-Type": "application/json" } });
    }
    if (data === EMPTY_BODY) return new Response("", { status: 200 });
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  return { fetch: fakeFetch as typeof fetch, calls, apiKeysSeen, bodies };
}

const PROJECT_ONLY = {
  "project.all": [
    {
      projectId: "proj-1",
      name: "fleet-project",
      environments: [{ environmentId: "env-1", isDefault: true, name: "Production", applications: [] }],
    },
  ],
};

async function main(): Promise<void> {
  // ── 1. Fresh deploy — call order + x-api-key ─────────────────────────────────
  console.log("\n[1] Fresh deploy — compose.create → update → deploy");
  const fresh = makeFakeFetch({
    ...PROJECT_ONLY,
    "compose.create": { composeId: "comp-1" },
    "compose.update": true,
    "compose.deploy": EMPTY_BODY,
    "compose.one": { composeStatus: "running" },
  });
  const res1 = await deployEngramServer({
    cfg: FAKE_CFG,
    orgSlug: "acme",
    allowedProjects: ["acme/web", "acme/api"],
    secrets: STRONG_SECRETS,
    onProgress: NO_PROGRESS,
    onLog: NO_LOG,
    fetchImpl: fresh.fetch,
    pollIntervalMs: 0,
  });
  assert(res1.composeId === "comp-1", "returns the created composeId");
  assert(res1.composeName === "engram-cloud-acme", "compose name is engram-cloud-<orgSlug>");
  assert(res1.reused === false, "fresh deploy reports reused=false");
  const order = fresh.calls.join(" | ");
  assert(
    order.indexOf("POST:compose.create") < order.indexOf("POST:compose.update") &&
      order.indexOf("POST:compose.update") < order.indexOf("POST:compose.deploy"),
    "procedure order: create → update → deploy",
  );
  assert(!fresh.calls.includes("POST:compose.redeploy"), "fresh deploy does NOT call compose.redeploy");
  assert(fresh.apiKeysSeen.every((k) => k === "test-api-key"), "x-api-key header on every call");

  const createBody = fresh.bodies["compose.create"] as { name: string; environmentId: string; composeType: string };
  assert(createBody.composeType === "docker-compose", "compose.create uses composeType=docker-compose");
  assert(createBody.environmentId === "env-1", "compose.create targets the default environment");

  // ── 2. Secrets hygiene — composeFile has NO values, env carries them ─────────
  console.log("\n[2] Secrets hygiene — composeFile is value-free, env carries secrets");
  const upd = fresh.bodies["compose.update"] as { sourceType: string; composeFile: string; env: string };
  assert(upd.sourceType === "raw", "compose.update uses sourceType=raw");
  for (const v of [STRONG_SECRETS.cloudToken, STRONG_SECRETS.jwtSecret, STRONG_SECRETS.postgresPassword]) {
    assert(!upd.composeFile.includes(v), `composeFile does NOT contain secret value "${v}"`);
  }
  assert(upd.composeFile.includes("${ENGRAM_CLOUD_TOKEN}"), "composeFile references ${ENGRAM_CLOUD_TOKEN}");
  assert(upd.composeFile.includes(ENGRAM_IMAGE), "composeFile pins the official Engram image");
  assert(upd.composeFile.includes("postgres:16-alpine"), "composeFile uses postgres:16-alpine");
  assert(!upd.composeFile.includes("ENGRAM_CLOUD_INSECURE_NO_AUTH"), "composeFile never sets INSECURE_NO_AUTH (auth mode)");
  assert(upd.env.includes(`ENGRAM_CLOUD_TOKEN=${STRONG_SECRETS.cloudToken}`), "env payload carries the cloud token value");
  assert(upd.env.includes(`ENGRAM_JWT_SECRET=${STRONG_SECRETS.jwtSecret}`), "env payload carries the JWT secret value");
  assert(upd.env.includes("ENGRAM_CLOUD_ALLOWED_PROJECTS=acme/web,acme/api"), "env payload carries the allowlist");

  // ── 3. Idempotent redeploy — existing compose is reused ──────────────────────
  console.log("\n[3] Idempotent redeploy — reuse existing compose via compose.redeploy");
  // Idempotency is detected from the compose nested in project.all (Dokploy has no
  // compose.all endpoint — verified 404 in preflight), so the existing compose
  // rides the environment object.
  const again = makeFakeFetch({
    "project.all": [
      {
        projectId: "proj-1",
        name: "fleet-project",
        environments: [
          {
            environmentId: "env-1",
            isDefault: true,
            name: "Production",
            applications: [],
            compose: [{ composeId: "comp-existing", name: "engram-cloud-acme" }],
          },
        ],
      },
    ],
    "compose.update": true,
    "compose.redeploy": EMPTY_BODY,
    "compose.one": { composeStatus: "done" },
  });
  const res3 = await deployEngramServer({
    cfg: FAKE_CFG,
    orgSlug: "acme",
    allowedProjects: ["acme/web"],
    secrets: STRONG_SECRETS,
    onProgress: NO_PROGRESS,
    onLog: NO_LOG,
    fetchImpl: again.fetch,
    pollIntervalMs: 0,
  });
  assert(res3.composeId === "comp-existing", "reuses the existing composeId");
  assert(res3.reused === true, "redeploy reports reused=true");
  assert(!again.calls.includes("POST:compose.create"), "redeploy does NOT call compose.create (no duplicate)");
  assert(again.calls.includes("POST:compose.redeploy"), "redeploy calls compose.redeploy");
  assert(!again.calls.some((c) => c.endsWith(":compose.all")), "idempotency does NOT depend on compose.all (a 404 endpoint)");

  // ── 4. E-04 — weak/missing JWT secret fails fast ─────────────────────────────
  console.log("\n[4] E-04 — weak/missing ENGRAM_JWT_SECRET fails before any Dokploy call");
  const guarded = makeFakeFetch({ ...PROJECT_ONLY });
  let threw = false;
  try {
    await deployEngramServer({
      cfg: FAKE_CFG,
      orgSlug: "acme",
      allowedProjects: [],
      secrets: { ...STRONG_SECRETS, jwtSecret: "dev" },
      onProgress: NO_PROGRESS,
      onLog: NO_LOG,
      fetchImpl: guarded.fetch,
      pollIntervalMs: 0,
    });
  } catch (err) {
    threw = err instanceof DeployError;
  }
  assert(threw, "weak JWT secret throws DeployError");
  assert(guarded.calls.length === 0, "no Dokploy call is made when the JWT secret is weak");

  // ── 5. orgSlugFromName helper ────────────────────────────────────────────────
  console.log("\n[5] orgSlugFromName — slugifies org display names");
  assert(orgSlugFromName("Acme Corp") === "acme-corp", "spaces → hyphens, lowercased");
  assert(orgSlugFromName("  --Inteliside!!  ") === "inteliside", "trims and collapses non-alphanumerics");
  assert(orgSlugFromName("") === "default", "empty name falls back to 'default'");

  console.log(buildEngramComposeFile() === buildEngramComposeFile() ? "\n✓ composeFile is deterministic" : "\n❌ composeFile not deterministic");
}

await main();
