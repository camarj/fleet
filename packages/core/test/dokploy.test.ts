/**
 * Unit test — Dokploy deploy-target orchestration.
 *
 * Tests the runDokployOrchestration function directly with an injected fake
 * fetch, so no Dokploy instance, git, or gh is needed. Verifies:
 *
 *   1. Fresh deploy: correct procedure call order + x-api-key header present.
 *   2. Existing-app reuse: application.create is skipped, domain.byApplicationId
 *      reuse path is taken.
 *   3. Deployment error: applicationStatus "error" → throws DeployError.
 *   4. Preflight: missing DOKPLOY_URL / DOKPLOY_API_KEY → failing checks.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/dokploy.test.ts
 */

import { join } from "node:path";
import { tmpdir } from "node:os";

const { runDokployOrchestration, DeployError, FlueDeployer } = await import("../src/deploy/flue-deployer.js");
const { SecretsStore } = await import("../src/secrets/store.js");
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
/** Marks a procedure whose response is an empty body (no JSON). */
const EMPTY_BODY = Symbol("empty-body");
const FAKE_PUSH = { owner: "fleet-owner", repo: "fleet-agent-test" };
const FAKE_AGENT = "test-agent";

/** Build a fake fetch that records calls and returns canned responses. */
function makeFakeFetch(responses: Record<string, unknown>): {
  fetch: typeof fetch;
  calls: string[];
  apiKeysSeen: string[];
} {
  const calls: string[] = [];
  const apiKeysSeen: string[] = [];

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = String(input);
    const method = ((init?.method as string) || "GET").toUpperCase();

    // Collect x-api-key header values.
    const hdrs = (init?.headers ?? {}) as Record<string, string>;
    if (hdrs["x-api-key"]) apiKeysSeen.push(hdrs["x-api-key"]);

    // Extract procedure from URL path (strip query string).
    const procedureMatch = urlStr.match(/\/api\/([^?]+)/);
    const procedure = procedureMatch?.[1] ?? "unknown";
    calls.push(`${method}:${procedure}`);

    const data = responses[procedure];
    if (data === undefined) {
      return new Response(JSON.stringify(null), { status: 404, headers: { "Content-Type": "application/json" } });
    }
    // Sentinel: self-hosted Dokploy returns an EMPTY body from some procedures
    // (seen live on application.deploy) — simulate that.
    if (data === EMPTY_BODY) {
      return new Response("", { status: 200 });
    }
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  return { fetch: fakeFetch as typeof fetch, calls, apiKeysSeen };
}

// Base canned responses for a fresh deploy (no existing app, no DOKPLOY_DOMAIN).
const BASE_RESPONSES: Record<string, unknown> = {
  "github.githubProviders": [{ githubId: "gh-app-123" }],
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
        },
      ],
    },
  ],
  "application.create": { applicationId: "app-test-1", appName: "app-test-1" },
  "application.saveGithubProvider": true,
  "application.saveBuildType": true,
  "application.saveEnvironment": true,
  "domain.generateDomain": "test-agent.traefik.me",
  "domain.create": { domainId: "dom-1" },
  // Empty body — matches the live behavior of self-hosted Dokploy instances.
  "application.deploy": EMPTY_BODY,
  "application.one": { applicationStatus: "done" },
};

async function main(): Promise<void> {
  // Clean up env vars that might interfere across test cases.
  const envCleanup = ["DOKPLOY_GITHUB_ID", "DOKPLOY_PROJECT", "DOKPLOY_DOMAIN"];
  const savedEnv = Object.fromEntries(envCleanup.map((k) => [k, process.env[k]]));
  for (const k of envCleanup) delete process.env[k];

  try {
    // ── 1. Fresh deploy: call order + x-api-key header ───────────────────────
    console.log("\n[1] Fresh deploy — procedure call order and x-api-key header");

    const { fetch: f1, calls: c1, apiKeysSeen: a1 } = makeFakeFetch(BASE_RESPONSES);

    const baseUrl1 = await runDokployOrchestration({
      cfg: FAKE_CFG,
      agentName: FAKE_AGENT,
      apiKeyEnv: "ANTHROPIC_API_KEY",
      key: "sk-test-key",
      owner: FAKE_PUSH.owner,
      repo: FAKE_PUSH.repo,
      onProgress: NO_PROGRESS,
      onLog: NO_LOG,
      fetchImpl: f1,
      pollIntervalMs: 0,
    });

    // Verify the expected procedures were called in order.
    const expectedOrder = [
      "GET:github.githubProviders",
      "GET:project.all",
      "POST:application.create",
      "POST:application.saveGithubProvider",
      "POST:application.saveBuildType",
      "POST:application.saveEnvironment",
      "POST:domain.generateDomain",
      "POST:domain.create",
      "POST:application.deploy",
      "GET:application.one",
    ];
    assert(
      expectedOrder.every((step, i) => c1[i] === step),
      `fresh deploy: procedure order is correct (got: ${c1.join(", ")})`,
    );
    assert(c1.length === expectedOrder.length, `fresh deploy: exactly ${expectedOrder.length} API calls made (got ${c1.length})`);
    assert(a1.length > 0 && a1.every((k) => k === FAKE_CFG.key), "x-api-key header is present and correct on every call");
    assert(baseUrl1 === "http://test-agent.traefik.me", `fresh deploy: baseUrl is http (no TLS, generated domain) (got: ${baseUrl1})`);

    // ── 2. Existing-app reuse: skips application.create, reuses domain ────────
    console.log("\n[2] Existing-app reuse — skips create, reuses domain");

    const redeployResponses = {
      ...BASE_RESPONSES,
      "project.all": [
        {
          projectId: "proj-1",
          name: "fleet-project",
          environments: [
            {
              environmentId: "env-1",
              isDefault: true,
              name: "Production",
              // The app already exists in the environment.
              applications: [
                {
                  applicationId: "app-existing-1",
                  appName: "app-existing-1",
                  name: FAKE_AGENT,
                  applicationStatus: "done",
                },
              ],
            },
          ],
        },
      ],
      // domain.byApplicationId succeeds and returns an existing domain.
      "domain.byApplicationId": [{ host: "test-agent.traefik.me", https: false, certificateType: "none" }],
    };

    const { fetch: f2, calls: c2 } = makeFakeFetch(redeployResponses);

    await runDokployOrchestration({
      cfg: FAKE_CFG,
      agentName: FAKE_AGENT,
      apiKeyEnv: "ANTHROPIC_API_KEY",
      key: "sk-test-key",
      owner: FAKE_PUSH.owner,
      repo: FAKE_PUSH.repo,
      onProgress: NO_PROGRESS,
      onLog: NO_LOG,
      fetchImpl: f2,
      pollIntervalMs: 0,
    });

    assert(!c2.includes("POST:application.create"), "existing-app reuse: application.create is NOT called");
    assert(c2.includes("GET:domain.byApplicationId"), "existing-app reuse: domain.byApplicationId is called");
    assert(!c2.includes("POST:domain.generateDomain"), "existing-app reuse: domain.generateDomain is NOT called");
    assert(!c2.includes("POST:domain.create"), "existing-app reuse: domain.create is NOT called");
    assert(c2.includes("POST:application.deploy"), "existing-app reuse: application.deploy IS called");

    // ── 3. Deployment error: applicationStatus "error" → DeployError ─────────
    console.log("\n[3] Deployment error → throws DeployError");

    const errorResponses = {
      ...BASE_RESPONSES,
      "application.one": { applicationStatus: "error" },
    };

    const { fetch: f3 } = makeFakeFetch(errorResponses);

    let threw = false;
    try {
      await runDokployOrchestration({
        cfg: FAKE_CFG,
        agentName: FAKE_AGENT,
        apiKeyEnv: "ANTHROPIC_API_KEY",
        key: "sk-test-key",
        owner: FAKE_PUSH.owner,
        repo: FAKE_PUSH.repo,
        onProgress: NO_PROGRESS,
        onLog: NO_LOG,
        fetchImpl: f3,
        pollIntervalMs: 0,
      });
    } catch (err) {
      threw = err instanceof DeployError;
    }
    assert(threw, "applicationStatus 'error' → throws DeployError");

    // ── 4. Preflight: missing DOKPLOY_URL / DOKPLOY_API_KEY → failing checks ──
    console.log("\n[4] Preflight — missing Dokploy env vars are reported");

    const savedDokployEnv = { url: process.env.DOKPLOY_URL, key: process.env.DOKPLOY_API_KEY };
    delete process.env.DOKPLOY_URL;
    delete process.env.DOKPLOY_API_KEY;
    try {
      const deployer = new FlueDeployer(new SecretsStore(join(tmpdir(), `fleet-test-secrets-${process.pid}.json`)));
      const checks = await deployer.preflight({ target: "dokploy" });
      const urlCheck = checks.find((c) => c.id === "dokploy-url");
      const keyCheck = checks.find((c) => c.id === "dokploy-api-key");
      assert(!!urlCheck && !urlCheck.ok && !!urlCheck.detail, "preflight: missing DOKPLOY_URL → ok:false with detail");
      assert(!!keyCheck && !keyCheck.ok && !!keyCheck.detail, "preflight: missing DOKPLOY_API_KEY → ok:false with detail");
    } finally {
      if (savedDokployEnv.url !== undefined) process.env.DOKPLOY_URL = savedDokployEnv.url;
      if (savedDokployEnv.key !== undefined) process.env.DOKPLOY_API_KEY = savedDokployEnv.key;
    }
  } finally {
    // Restore env vars.
    for (const k of envCleanup) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    }
  }

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main();
