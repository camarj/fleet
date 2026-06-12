/**
 * PR1a: OrgRegistry interface contract + OrgStore round-trip + GitHubRegistry unit tests.
 *
 * Level 1:  FakeRegistry interface contract — all methods callable, return
 *           correct shapes, no secret fields in SharedAgentEntry (ORG-14).
 * Level 2:  SharedAgentEntry type-shape — no secrets (ORG-14).
 * Level 3:  OrgStore write + read + clear binding round-trip (ORG-01, ORG-03).
 * Level 4:  OrgStore persistence across instances.
 * Level 5:  Role derivation — owner when org.json.owner === whoami (ADR-3b).
 * Level 6:  OrgStore: forward-compat unknown schemaVersion.
 * Level 7:  OrgStore: corrupt JSON returns null.
 * Level 8:  OrgStore: nested non-existent directory.
 * Level 9:  OrgStore: overwrite without clear().
 * Level 10: OrgError typed error codes.
 * Level 11: GitHubRegistry exec-seam unit tests — no network (T6-ii, PR1a-ii).
 *
 * Note: T10 (PR1b) will append reconcile + DB + guard tests to this file.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/org.test.ts
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".org-test");
process.env.GATEWAY_DATA_DIR = DATA_DIR;

import type {
  GhExecFn,
  OrgBinding,
  OrgMember,
  OrgMeta,
  OrgRegistry,
  OrgRole,
  ReconcileResult,
  SharedAgentEntry,
} from "../src/org/index.js";
import { GitHubRegistry, OrgError, OrgManager, OrgStore, classifyGhError, decodeBase64Content, encodeBase64Content } from "../src/org/index.js";
import { GatewayState } from "../src/state/db.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

// ── FakeRegistry — in-memory OrgRegistry for unit testing ──────────────────
// This is the seam used by OrgManager tests in PR1b (T10) as well.

class FakeRegistry implements OrgRegistry {
  #login: string;
  #orgMeta: OrgMeta | null = null;
  #agents: Map<string, SharedAgentEntry> = new Map();
  #members: OrgMember[] = [];
  #pullShouldFail: boolean = false;

  constructor(login: string) {
    this.#login = login;
  }

  async whoami(): Promise<string> {
    return this.#login;
  }

  async createOrg(repo: string, name: string): Promise<OrgMeta> {
    if (this.#orgMeta !== null) {
      throw new OrgError("alreadyExists", `Fake: org already exists at ${repo}`);
    }
    this.#orgMeta = {
      schemaVersion: 1,
      orgId: `org_${Date.now()}`,
      name,
      owner: this.#login,
      createdAt: new Date().toISOString(),
    };
    this.#members = [{ login: this.#login, role: "owner" }];
    return this.#orgMeta;
  }

  async bindOrg(repo: string): Promise<OrgMeta> {
    if (!this.#orgMeta) throw new OrgError("notFound", `Fake: no org at ${repo}`);
    return this.#orgMeta;
  }

  async pullDirectory(): Promise<SharedAgentEntry[]> {
    if (this.#pullShouldFail) {
      this.#pullShouldFail = false;
      throw new OrgError("networkError", "Fake: simulated pull failure");
    }
    return Array.from(this.#agents.values());
  }

  /**
   * Make the NEXT pullDirectory() call throw OrgError (for prune-guard tests).
   * The flag resets to false after one failure (one-shot).
   */
  simulatePullFailure(): void {
    this.#pullShouldFail = true;
  }

  async shareAgent(entry: SharedAgentEntry): Promise<void> {
    this.#agents.set(entry.id, entry);
  }

  async unshareAgent(agentId: string): Promise<void> {
    this.#agents.delete(agentId);
  }

  async listMembers(): Promise<OrgMember[]> {
    return [...this.#members];
  }

  async getOrgMeta(): Promise<OrgMeta> {
    if (!this.#orgMeta) throw new OrgError("notFound", "Fake: no org meta available");
    return this.#orgMeta;
  }

  async inviteMember(login: string): Promise<void> {
    if (!this.#members.find((m) => m.login === login)) {
      this.#members.push({ login, role: "member" });
    }
  }

  /** Seed org meta directly (for bindOrg tests). */
  seedOrg(meta: OrgMeta): void {
    this.#orgMeta = meta;
  }

  /** Read the current agent map (for assertion). */
  agentCount(): number {
    return this.#agents.size;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(id: string, overrides: Partial<SharedAgentEntry> = {}): SharedAgentEntry {
  return {
    schemaVersion: 1,
    id,
    name: `Agent ${id}`,
    version: "1.0.0",
    description: "Test agent",
    model: "anthropic/claude-sonnet-4-6",
    target: "fly",
    url: `https://example.fly.dev/${id}`,
    sharedBy: "alice",
    sharedAt: new Date().toISOString(),
    config: { envVarNames: ["ANTHROPIC_API_KEY"] },
    ...overrides,
  };
}

// ── Level 1: FakeRegistry interface contract ────────────────────────────────

async function testFakeRegistryContract(): Promise<void> {
  console.log("\n[1] FakeRegistry interface contract …");

  const fake = new FakeRegistry("alice");

  // whoami
  const login = await fake.whoami();
  assert(login === "alice", "whoami returns the constructor login");

  // createOrg returns OrgMeta with correct shape
  const meta = await fake.createOrg("alice/fleet-org", "My Org");
  assert(meta.schemaVersion === 1, "createOrg: schemaVersion is 1");
  assert(typeof meta.orgId === "string" && meta.orgId.length > 0, "createOrg: orgId is a non-empty string");
  assert(meta.owner === "alice", "createOrg: owner equals the authenticated login");
  assert(meta.name === "My Org", "createOrg: name matches the argument");
  assert(typeof meta.createdAt === "string", "createOrg: createdAt is a string (ISO 8601)");

  // bindOrg returns the same org
  const bound = await fake.bindOrg("alice/fleet-org");
  assert(bound.orgId === meta.orgId, "bindOrg returns the seeded org");

  // pullDirectory returns empty initially
  const empty = await fake.pullDirectory();
  assert(Array.isArray(empty) && empty.length === 0, "pullDirectory returns empty array before any shares");

  // shareAgent then pullDirectory
  const entry = makeEntry("agent-1");
  await fake.shareAgent(entry);
  const pulled = await fake.pullDirectory();
  assert(pulled.length === 1, "pullDirectory returns 1 entry after shareAgent");
  assert(pulled[0].id === "agent-1", "pulled entry id matches");

  // unshareAgent
  await fake.unshareAgent("agent-1");
  const afterUnshare = await fake.pullDirectory();
  assert(afterUnshare.length === 0, "pullDirectory is empty after unshareAgent");

  // listMembers
  const members = await fake.listMembers();
  assert(Array.isArray(members), "listMembers returns an array");
  assert(members.length === 1 && members[0].login === "alice", "listMembers includes the owner");

  // inviteMember (optional method, present on FakeRegistry)
  await fake.inviteMember("bob");
  const afterInvite = await fake.listMembers();
  assert(afterInvite.length === 2, "listMembers grows after inviteMember");
  assert(afterInvite.find((m) => m.login === "bob") !== undefined, "bob is in members after invite");

  // getOrgMeta
  const orgMeta = await fake.getOrgMeta();
  assert(orgMeta.orgId === meta.orgId, "getOrgMeta returns the current org meta");
  assert(orgMeta.name === "My Org", "getOrgMeta: name matches");
}

// ── Level 2: SharedAgentEntry type-shape — no secrets (ORG-14) ─────────────

function testSharedAgentEntryNoSecrets(): void {
  console.log("\n[2] SharedAgentEntry type-shape — no secret fields (ORG-14) …");

  const entry = makeEntry("agent-sec", {
    config: { envVarNames: ["ANTHROPIC_API_KEY", "FLY_API_TOKEN"] },
  });

  // These fields MUST be present
  assert("schemaVersion" in entry, "entry has schemaVersion");
  assert("id" in entry, "entry has id");
  assert("name" in entry, "entry has name");
  assert("version" in entry, "entry has version");
  assert("description" in entry, "entry has description");
  assert("model" in entry, "entry has model");
  assert("target" in entry, "entry has target");
  assert("url" in entry, "entry has url");
  assert("sharedBy" in entry, "entry has sharedBy");
  assert("sharedAt" in entry, "entry has sharedAt");
  assert(Array.isArray(entry.config.envVarNames), "config.envVarNames is an array");

  // Verify envVarNames carries only names — values are callers' responsibility,
  // but the type enforces it is a string[] (names, not key=value pairs).
  assert(
    entry.config.envVarNames.every((n) => !n.includes("=")),
    "envVarNames entries must not be key=value pairs (names only, rule #8)",
  );

  // These fields MUST NOT be present (no secrets, no token, no credential).
  const dangerous = ["apiKey", "token", "secret", "password", "credential", "key"];
  for (const field of dangerous) {
    assert(!(field in entry), `entry must not carry field "${field}"`);
  }

  // target is one of the routable values
  const routable: Array<SharedAgentEntry["target"]> = ["fly", "cloudflare", "dokploy", "github"];
  assert(routable.includes(entry.target), "entry.target is a routable deployment target");
}

// ── Level 3: OrgStore write + read + clear round-trip ──────────────────────

function testOrgStoreRoundTrip(): void {
  console.log("\n[3] OrgStore write + read + clear round-trip …");

  const storePath = join(DATA_DIR, "org-binding.json");
  const store = new OrgStore(storePath);

  // Initially unbound
  assert(store.load() === null, "load() returns null when no binding file exists");
  assert(store.isBound() === false, "isBound() is false initially");

  const binding: OrgBinding = {
    schemaVersion: 1,
    repo: "alice/fleet-org",
    orgId: "org_test_123",
    orgName: "My Org",
    myLogin: "alice",
    role: "owner",
    lastSyncedAt: null,
  };

  // save
  store.save(binding);
  assert(store.isBound() === true, "isBound() is true after save");

  // load round-trip
  const loaded = store.load();
  assert(loaded !== null, "load() returns non-null after save");
  assert(loaded!.repo === binding.repo, "load: repo matches");
  assert(loaded!.orgId === binding.orgId, "load: orgId matches");
  assert(loaded!.orgName === binding.orgName, "load: orgName matches");
  assert(loaded!.myLogin === binding.myLogin, "load: myLogin matches");
  assert(loaded!.role === "owner", "load: role is owner");
  assert(loaded!.lastSyncedAt === null, "load: lastSyncedAt is null before first sync");
  assert(loaded!.schemaVersion === 1, "load: schemaVersion is 1");

  // touchSyncedAt
  const syncTime = "2026-06-11T12:00:00.000Z";
  store.touchSyncedAt(syncTime);
  const afterSync = store.load();
  assert(afterSync?.lastSyncedAt === syncTime, "touchSyncedAt updates lastSyncedAt");
  assert(afterSync?.orgId === binding.orgId, "touchSyncedAt preserves orgId");

  // clear (ORG-03)
  store.clear();
  assert(store.load() === null, "load() returns null after clear");
  assert(store.isBound() === false, "isBound() is false after clear");
}

// ── Level 4: OrgStore persistence across instances ─────────────────────────

function testOrgStorePersistence(): void {
  console.log("\n[4] OrgStore persistence across instances …");

  const storePath = join(DATA_DIR, "org-binding-persist.json");

  const store1 = new OrgStore(storePath);
  store1.save({
    schemaVersion: 1,
    repo: "bob/fleet-org",
    orgId: "org_persist_456",
    orgName: "Bob Org",
    myLogin: "bob",
    role: "member",
    lastSyncedAt: "2026-06-11T10:00:00.000Z",
  });

  const store2 = new OrgStore(storePath);
  const loaded = store2.load();
  assert(loaded?.orgId === "org_persist_456", "binding persists across OrgStore instances");
  assert(loaded?.role === "member", "role persists correctly");
  assert(loaded?.lastSyncedAt === "2026-06-11T10:00:00.000Z", "lastSyncedAt persists");
}

// ── Level 5: Role derivation — owner vs member (ADR-3b) ────────────────────

async function testRoleDerivation(): Promise<void> {
  console.log("\n[5] Role derivation: owner when org.json.owner === whoami …");

  const aliceFake = new FakeRegistry("alice");
  const bobFake = new FakeRegistry("bob");

  // Alice creates the org — she becomes owner
  const meta = await aliceFake.createOrg("alice/fleet-org", "My Org");
  assert(meta.owner === "alice", "org.json.owner is alice");

  // Alice's login === org.owner → owner role
  const aliceLogin = await aliceFake.whoami();
  const aliceRole: OrgRole = aliceLogin === meta.owner ? "owner" : "member";
  assert(aliceRole === "owner", "alice derives role=owner because whoami===owner");

  // Seed the same org into bobFake and bind
  bobFake.seedOrg(meta);
  const boundMeta = await bobFake.bindOrg("alice/fleet-org");
  const bobLogin = await bobFake.whoami();
  const bobRole: OrgRole = bobLogin === boundMeta.owner ? "owner" : "member";
  assert(bobRole === "member", "bob derives role=member because whoami!==owner");
}

// ── Level 6: OrgStore ignores unknown schemaVersion ────────────────────────

function testSchemaVersionForwardCompat(): void {
  console.log("\n[6] OrgStore: forward-compat — unknown schemaVersion is skipped …");

  const storePath = join(DATA_DIR, "org-binding-future.json");
  const store = new OrgStore(storePath);

  // Save a binding with a future schemaVersion
  const futureBinding = {
    schemaVersion: 99,
    repo: "future/org",
    orgId: "org_future",
    orgName: "Future Org",
    myLogin: "alice",
    role: "owner" as OrgRole,
    lastSyncedAt: null,
  };
  store.save(futureBinding as OrgBinding);

  // Should return null (silently skipped, not thrown)
  const result = store.load();
  assert(result === null, "load() returns null for unknown schemaVersion (forward compat)");
  assert(store.isBound() === false, "isBound() is false for unreadable future binding");
}

// ── Level 7: OrgStore — corrupt JSON file returns null (W5) ────────────────

function testCorruptFileReturnsNull(): void {
  console.log("\n[7] OrgStore: corrupt JSON file → load() returns null …");

  const storePath = join(DATA_DIR, "org-binding-corrupt.json");
  writeFileSync(storePath, "not valid json{{", "utf8");
  const store = new OrgStore(storePath);
  assert(store.load() === null, "load() returns null for corrupt JSON file");
  assert(store.isBound() === false, "isBound() is false for corrupt JSON file");
}

// ── Level 8: OrgStore — nested non-existent directory (W6) ─────────────────

function testNestedPathSave(): void {
  console.log("\n[8] OrgStore: nested non-existent subdirectory → save succeeds …");

  const storePath = join(DATA_DIR, "nested", "deep", "org-binding.json");
  const store = new OrgStore(storePath);
  const binding: OrgBinding = {
    schemaVersion: 1,
    repo: "alice/fleet-org",
    orgId: "org_nested",
    orgName: "Nested Org",
    myLogin: "alice",
    role: "owner",
    lastSyncedAt: null,
  };
  store.save(binding);
  const loaded = store.load();
  assert(loaded !== null, "save() succeeds in nested non-existent directory");
  assert(loaded?.orgId === "org_nested", "loaded orgId matches after nested-path save");
}

// ── Level 9: OrgStore — overwrite without clear() (W7) ─────────────────────

function testOverwrite(): void {
  console.log("\n[9] OrgStore: save overwrite — second save wins …");

  const storePath = join(DATA_DIR, "org-binding-overwrite.json");
  const store = new OrgStore(storePath);

  const binding1: OrgBinding = {
    schemaVersion: 1,
    repo: "alice/fleet-org",
    orgId: "org_first",
    orgName: "First Org",
    myLogin: "alice",
    role: "owner",
    lastSyncedAt: null,
  };
  const binding2: OrgBinding = {
    schemaVersion: 1,
    repo: "bob/fleet-org",
    orgId: "org_second",
    orgName: "Second Org",
    myLogin: "bob",
    role: "member",
    lastSyncedAt: null,
  };

  store.save(binding1);
  store.save(binding2);
  const loaded = store.load();
  assert(loaded?.orgId === "org_second", "load() returns binding2 after overwrite");
  assert(loaded?.myLogin === "bob", "load: myLogin reflects binding2 after overwrite");
}

// ── Level 10: OrgError typed error codes ───────────────────────────────────

async function testOrgErrorCodes(): Promise<void> {
  console.log("\n[10] OrgError: typed error codes …");

  // bindOrg on unknown org → OrgError('notFound')
  const fake = new FakeRegistry("alice");
  try {
    await fake.bindOrg("unknown/org");
    assert(false, "bindOrg on unknown org should throw OrgError");
  } catch (err) {
    assert(err instanceof OrgError, "bindOrg throws OrgError on missing org");
    assert((err as OrgError).code === "notFound", "OrgError.code is notFound for missing org");
    assert((err as OrgError).name === "OrgError", "OrgError.name is 'OrgError'");
  }

  // createOrg twice → OrgError('alreadyExists')
  await fake.createOrg("alice/fleet-org", "My Org");
  try {
    await fake.createOrg("alice/fleet-org", "My Org Again");
    assert(false, "createOrg on existing org should throw OrgError");
  } catch (err) {
    assert(err instanceof OrgError, "createOrg throws OrgError when org already exists");
    assert((err as OrgError).code === "alreadyExists", "OrgError.code is alreadyExists for duplicate org");
  }

  // getOrgMeta on fresh registry (no org) → OrgError('notFound')
  const fresh = new FakeRegistry("bob");
  try {
    await fresh.getOrgMeta();
    assert(false, "getOrgMeta on unbound registry should throw OrgError");
  } catch (err) {
    assert(err instanceof OrgError, "getOrgMeta throws OrgError when no org is set");
    assert((err as OrgError).code === "notFound", "OrgError.code is notFound for getOrgMeta with no org");
  }
}

// ── Level 11: GitHubRegistry exec-seam unit tests (no network) ──────────────
//
// Each sub-test injects a GhExecFn that returns mocked gh responses. The tests
// verify that GitHubRegistry correctly: maps exec results to OrgErrors, decodes
// base64 content, respects schemaVersion guards, and passes the right sha for
// PUT/DELETE operations.

/** Build a mock GhExecFn from a sequence of (predicate → result) pairs. */
function makeExec(
  cases: Array<{
    match: (args: string[]) => boolean;
    result: { status: number; stdout: string; stderr: string };
  }>,
): GhExecFn {
  return (args) => {
    const found = cases.find((c) => c.match(args));
    return found
      ? found.result
      : { status: 1, stdout: "", stderr: `MOCK: unexpected call: gh ${args.join(" ")}` };
  };
}

async function testGitHubRegistryExecSeam(): Promise<void> {
  console.log("\n[11] GitHubRegistry: exec-seam unit tests …");

  // ── 11v: constructor rejects malformed repo slugs before any gh call ─────
  // (Live finding: a pasted trailing ")" made gh "create" report already-exists
  // after GitHub normalized the name, then the Contents write 404'd.)

  for (const bad of ["Intelliaa/fleet-org)", "no-slash", "owner/na me", "owner/", "/name"]) {
    let threw = false;
    try {
      new GitHubRegistry(bad, makeExec([]));
    } catch (err) {
      threw = err instanceof OrgError && err.message.includes("Invalid registry repo");
    }
    assert(threw, `11v: constructor rejects malformed slug "${bad}"`);
  }
  {
    let ok = true;
    try {
      new GitHubRegistry("Intelliaa/fleet-org", makeExec([]));
      new GitHubRegistry("user.name/repo_1.x-y", makeExec([]));
    } catch {
      ok = false;
    }
    assert(ok, "11v: valid owner/name slugs are accepted");
  }

  // ── 11a: classifyGhError — error code mapping ───────────────────────────

  const err404 = classifyGhError({ status: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: "gh: Not Found (HTTP 404)" });
  assert(err404 instanceof OrgError, "classifyGhError: returns OrgError instance");
  assert(err404.code === "notFound", "classifyGhError: 404 output → notFound");

  const err401 = classifyGhError({ status: 1, stdout: '{"message":"Bad credentials","status":"401"}', stderr: "gh: Bad credentials (HTTP 401)" });
  assert(err401.code === "unauthorized", "classifyGhError: 401 output → unauthorized");

  const err403 = classifyGhError({ status: 1, stdout: '{"message":"Must have push access","status":"403"}', stderr: "gh: Must have push access (HTTP 403)" });
  assert(err403.code === "unauthorized", "classifyGhError: 403 output → unauthorized");

  const err422 = classifyGhError({ status: 1, stdout: '{"message":"sha is required","status":"422"}', stderr: "gh: Unprocessable Entity (HTTP 422)" });
  assert(err422.code === "conflict", "classifyGhError: 422 sha-required → conflict");

  // 422 + sha reference (narrowed sha-semantic conflict — C1)
  const err422sha = classifyGhError({ status: 1, stdout: '{"message":"Reference update requires sha","status":"422"}', stderr: "gh: Unprocessable Entity (HTTP 422)" });
  assert(err422sha.code === "conflict", "classifyGhError: 422 with sha reference → conflict (C1)");

  // bare 422 without sha — must NOT map to conflict (C1)
  const err422bare = classifyGhError({ status: 1, stdout: '{"message":"Validation Failed","status":"422"}', stderr: "gh: Unprocessable Entity (HTTP 422)" });
  assert(err422bare.code === "networkError", "classifyGhError: bare 422 without sha → networkError (C1)");

  // 422 + must be an organization member → unauthorized (C1)
  const err422org = classifyGhError({ status: 1, stdout: '{"message":"Must be an organization member","status":"422"}', stderr: "gh: Unprocessable Entity (HTTP 422)" });
  assert(err422org.code === "unauthorized", "classifyGhError: 422 must-be-org-member → unauthorized (C1)");

  // 422 + must have admin → unauthorized (C1)
  const err422admin = classifyGhError({ status: 1, stdout: '{"message":"Must have admin access","status":"422"}', stderr: "gh: Unprocessable Entity (HTTP 422)" });
  assert(err422admin.code === "unauthorized", "classifyGhError: 422 must-have-admin → unauthorized (C1)");

  const errNet = classifyGhError({ status: null, stdout: "", stderr: "Could not resolve host: api.github.com" });
  assert(errNet.code === "networkError", "classifyGhError: null status → networkError");

  // ── 11b: base64 encode / decode round-trip ──────────────────────────────

  const payload = JSON.stringify({ schemaVersion: 1, id: "agent-b64-test", name: "Test" });
  const encoded = encodeBase64Content(payload);
  const decoded = decodeBase64Content(encoded);
  assert(decoded === payload, "encodeBase64Content → decodeBase64Content round-trip is lossless");

  // Simulate GitHub's line-wrapped base64 (newlines every 60 chars).
  const wrapped = encoded.match(/.{1,60}/g)?.join("\n") ?? encoded;
  const decodedWrapped = decodeBase64Content(wrapped);
  assert(decodedWrapped === payload, "decodeBase64Content handles GitHub's line-wrapped base64");

  // ── 11c: whoami — exec returns login ───────────────────────────────────

  const whoamiExec = makeExec([
    {
      match: (a) => a.includes("user") && a.includes("--jq"),
      result: { status: 0, stdout: "testuser\n", stderr: "" },
    },
  ]);
  const registry = new GitHubRegistry("testuser/fleet-org", whoamiExec);
  const login = await registry.whoami();
  assert(login === "testuser", "whoami: returns trimmed login from exec result");

  // ── 11d: whoami — exec fails → OrgError unauthorized ────────────────────

  const whoamiFail = makeExec([
    {
      match: (a) => a.includes("user") && a.includes("--jq"),
      result: { status: 1, stdout: "", stderr: 'gh: HTTP 401 unauthorized' },
    },
  ]);
  const registryFail = new GitHubRegistry("owner/repo", whoamiFail);
  try {
    await registryFail.whoami();
    assert(false, "whoami: should throw when exec fails");
  } catch (err) {
    assert(err instanceof OrgError, "whoami: throws OrgError on exec failure");
    assert((err as OrgError).code === "unauthorized", "whoami: OrgError.code is unauthorized on 401");
  }

  // ── 11e: pullDirectory — happy path with 2 entries ──────────────────────
  // NOTE: Array.includes() does exact element matching. For URL substring
  // matching, use a.some(s => s.includes("...")).

  const entry1 = makeEntry("pull-1");
  const entry2 = makeEntry("pull-2");
  const enc1 = encodeBase64Content(JSON.stringify(entry1));
  const enc2 = encodeBase64Content(JSON.stringify(entry2));

  const pullExec = makeExec([
    {
      // Directory listing: exact URL element match (ends with /agents, no filename).
      match: (a) => a.some(s => s === "repos/owner/fleet-org/contents/agents"),
      result: {
        status: 0,
        stdout: JSON.stringify([
          { name: "pull-1.json", sha: "sha1", type: "file" },
          { name: "pull-2.json", sha: "sha2", type: "file" },
          { name: "subdir", sha: "sha3", type: "dir" }, // dir — should be ignored
        ]),
        stderr: "",
      },
    },
    {
      match: (a) => a.some(s => s.includes("agents/pull-1.json")),
      result: { status: 0, stdout: JSON.stringify({ content: enc1, sha: "sha1" }), stderr: "" },
    },
    {
      match: (a) => a.some(s => s.includes("agents/pull-2.json")),
      result: { status: 0, stdout: JSON.stringify({ content: enc2, sha: "sha2" }), stderr: "" },
    },
  ]);
  const pullRegistry = new GitHubRegistry("owner/fleet-org", pullExec);
  const pulled = await pullRegistry.pullDirectory();
  assert(pulled.length === 2, "pullDirectory: returns 2 entries from directory listing");
  assert(pulled[0].id === "pull-1", "pullDirectory: first entry id is pull-1");
  assert(pulled[1].id === "pull-2", "pullDirectory: second entry id is pull-2");

  // ── 11f: pullDirectory — skips entry with bad schemaVersion ─────────────

  const entryBad = { ...makeEntry("bad-schema"), schemaVersion: 99 };
  const entryGood = makeEntry("good-schema");
  const encBad = encodeBase64Content(JSON.stringify(entryBad));
  const encGood = encodeBase64Content(JSON.stringify(entryGood));

  const skipExec = makeExec([
    {
      match: (a) => a.some(s => s === "repos/owner/fleet-org/contents/agents"),
      result: {
        status: 0,
        stdout: JSON.stringify([
          { name: "bad-schema.json", sha: "sha-bad", type: "file" },
          { name: "good-schema.json", sha: "sha-good", type: "file" },
        ]),
        stderr: "",
      },
    },
    {
      match: (a) => a.some(s => s.includes("agents/bad-schema.json")),
      result: { status: 0, stdout: JSON.stringify({ content: encBad, sha: "sha-bad" }), stderr: "" },
    },
    {
      match: (a) => a.some(s => s.includes("agents/good-schema.json")),
      result: { status: 0, stdout: JSON.stringify({ content: encGood, sha: "sha-good" }), stderr: "" },
    },
  ]);
  const skipRegistry = new GitHubRegistry("owner/fleet-org", skipExec);
  const skipped = await skipRegistry.pullDirectory();
  assert(skipped.length === 1, "pullDirectory: skips entry with schemaVersion=99 (forward compat)");
  assert(skipped[0].id === "good-schema", "pullDirectory: only good-schema entry is returned");

  // ── 11g: pullDirectory — agents/ directory not found → empty array ───────

  const noAgentsExec = makeExec([
    {
      match: (a) => a.some(s => s.includes("contents/agents")),
      result: {
        status: 1,
        stdout: '{"message":"Not Found","status":"404"}',
        stderr: "gh: Not Found (HTTP 404)",
      },
    },
  ]);
  const noAgentsRegistry = new GitHubRegistry("owner/fleet-org", noAgentsExec);
  const emptyResult = await noAgentsRegistry.pullDirectory();
  assert(Array.isArray(emptyResult) && emptyResult.length === 0, "pullDirectory: returns [] when agents/ directory does not exist (404)");

  // ── 11h: pullDirectory — auth failure → throws OrgError unauthorized ──────

  const authFailExec = makeExec([
    {
      match: (a) => a.some(s => s.includes("contents/agents")),
      result: {
        status: 1,
        stdout: '{"message":"Bad credentials","status":"401"}',
        stderr: "gh: Bad credentials (HTTP 401)",
      },
    },
  ]);
  const authFailRegistry = new GitHubRegistry("owner/fleet-org", authFailExec);
  try {
    await authFailRegistry.pullDirectory();
    assert(false, "pullDirectory: should throw on auth failure");
  } catch (err) {
    assert(err instanceof OrgError, "pullDirectory: throws OrgError on auth failure");
    assert((err as OrgError).code === "unauthorized", "pullDirectory: OrgError.code is unauthorized on 401");
  }

  // ── 11i: createOrg — org.json absent → success ───────────────────────────

  let createOrgCalls: string[][] = [];
  const createExec: GhExecFn = (args) => {
    createOrgCalls.push(args);
    // 1st call: GET org.json to check existence → 404 (not yet created)
    if (args.some(s => s.includes("org.json")) && !args.includes("--method")) {
      return { status: 1, stdout: '{"status":"404"}', stderr: "gh: Not Found (HTTP 404)" };
    }
    // 2nd call: whoami
    if (args.includes("user") && args.includes("--jq")) {
      return { status: 0, stdout: "owner\n", stderr: "" };
    }
    // 3rd call: repo create
    if (args.includes("repo") && args.includes("create")) {
      return { status: 0, stdout: "", stderr: "" };
    }
    // 4th call: PUT org.json
    if (args.includes("--method") && args.includes("PUT") && args.some(s => s.includes("org.json"))) {
      return { status: 0, stdout: "{}", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
  };
  const createRegistry = new GitHubRegistry("owner/new-org", createExec);
  const meta = await createRegistry.createOrg("owner/new-org", "My New Org");
  assert(meta.schemaVersion === 1, "createOrg: returns OrgMeta with schemaVersion 1");
  assert(meta.name === "My New Org", "createOrg: returns OrgMeta with correct name");
  assert(meta.owner === "owner", "createOrg: OrgMeta.owner matches whoami");
  assert(typeof meta.orgId === "string" && meta.orgId.startsWith("org_"), "createOrg: OrgMeta.orgId has org_ prefix");
  assert(typeof meta.createdAt === "string", "createOrg: OrgMeta.createdAt is a string");

  // ── 11j: createOrg — org.json present → throws alreadyExists ─────────────

  const alreadyExistsExec = makeExec([
    {
      match: (a) => a.some(s => s.includes("org.json")) && !a.includes("--method"),
      result: { status: 0, stdout: JSON.stringify({ content: encodeBase64Content("{}"), sha: "abc" }), stderr: "" },
    },
  ]);
  const dupRegistry = new GitHubRegistry("owner/existing-org", alreadyExistsExec);
  try {
    await dupRegistry.createOrg("owner/existing-org", "Dup Org");
    assert(false, "createOrg: should throw alreadyExists when org.json present");
  } catch (err) {
    assert(err instanceof OrgError, "createOrg: throws OrgError when org.json exists");
    assert((err as OrgError).code === "alreadyExists", "createOrg: OrgError.code is alreadyExists");
  }

  // ── 11k: bindOrg — happy path ─────────────────────────────────────────────

  const orgMeta: OrgMeta = {
    schemaVersion: 1,
    orgId: "org_123",
    name: "Bound Org",
    owner: "alice",
    createdAt: "2026-06-11T00:00:00.000Z",
  };
  const bindExec = makeExec([
    {
      match: (a) => a.some(s => s.includes("org.json")),
      result: {
        status: 0,
        stdout: JSON.stringify({ content: encodeBase64Content(JSON.stringify(orgMeta)), sha: "sha-meta" }),
        stderr: "",
      },
    },
  ]);
  const bindRegistry = new GitHubRegistry("alice/fleet-org", bindExec);
  const boundMeta = await bindRegistry.bindOrg("alice/fleet-org");
  assert(boundMeta.orgId === "org_123", "bindOrg: OrgMeta.orgId matches");
  assert(boundMeta.owner === "alice", "bindOrg: OrgMeta.owner matches");
  assert(boundMeta.name === "Bound Org", "bindOrg: OrgMeta.name matches");

  // ── 11l: shareAgent — includes sha when file exists ──────────────────────

  let shareArgs: string[] = [];
  const shareExec: GhExecFn = (args) => {
    if (!args.includes("--method") && args.some((a) => a.includes("agents/share-me.json"))) {
      // GET for existing sha
      return { status: 0, stdout: JSON.stringify({ sha: "existingsha", content: "e30=" }), stderr: "" };
    }
    if (args.includes("--method") && args.includes("PUT")) {
      shareArgs = args;
      return { status: 0, stdout: "{}", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  const shareRegistry = new GitHubRegistry("owner/fleet-org", shareExec);
  await shareRegistry.shareAgent(makeEntry("share-me"));
  assert(shareArgs.includes("sha=existingsha"), "shareAgent: PUT args include the exact sha=existingsha element (N2)");
  assert(shareArgs.some((a) => a.startsWith("content=")), "shareAgent: PUT args include base64 content");

  // ── 11m: shareAgent — no sha when file does not exist ────────────────────

  let shareArgsNew: string[] = [];
  const shareNewExec: GhExecFn = (args) => {
    if (!args.includes("--method") && args.some((a) => a.includes("agents/new-agent.json"))) {
      // GET returns 404 (file does not exist yet)
      return { status: 1, stdout: '{"status":"404"}', stderr: "gh: Not Found (HTTP 404)" };
    }
    if (args.includes("--method") && args.includes("PUT")) {
      shareArgsNew = args;
      return { status: 0, stdout: "{}", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  const shareNewRegistry = new GitHubRegistry("owner/fleet-org", shareNewExec);
  await shareNewRegistry.shareAgent(makeEntry("new-agent"));
  assert(!shareArgsNew.includes("sha="), "shareAgent: PUT args do NOT include sha for new file");

  // ── 11n: unshareAgent — fetches sha then deletes ─────────────────────────

  let deleteArgs: string[] = [];
  const unshareExec: GhExecFn = (args) => {
    if (!args.includes("--method") && args.some((a) => a.includes("agents/del-me.json"))) {
      return { status: 0, stdout: JSON.stringify({ sha: "deletesha", content: "e30=" }), stderr: "" };
    }
    if (args.includes("--method") && args.includes("DELETE")) {
      deleteArgs = args;
      return { status: 0, stdout: "{}", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  const unshareRegistry = new GitHubRegistry("owner/fleet-org", unshareExec);
  await unshareRegistry.unshareAgent("del-me");
  assert(deleteArgs.includes("--method"), "unshareAgent: DELETE is called");
  assert(deleteArgs.includes("sha=deletesha"), "unshareAgent: DELETE args include the exact sha=deletesha element (N2)");

  // ── 11o: getOrgMeta — happy path ─────────────────────────────────────────

  const getMetaExec = makeExec([
    {
      match: (a) => a.some(s => s.includes("org.json")),
      result: {
        status: 0,
        stdout: JSON.stringify({ content: encodeBase64Content(JSON.stringify(orgMeta)), sha: "sha-m" }),
        stderr: "",
      },
    },
  ]);
  const getMetaRegistry = new GitHubRegistry("alice/fleet-org", getMetaExec);
  const fetchedMeta = await getMetaRegistry.getOrgMeta();
  assert(fetchedMeta.orgId === "org_123", "getOrgMeta: returns correct orgId");
  assert(fetchedMeta.name === "Bound Org", "getOrgMeta: returns correct name");

  // ── 11p: getOrgMeta — not found → OrgError notFound ──────────────────────

  const notFoundExec = makeExec([
    {
      match: (a) => a.some(s => s.includes("org.json")),
      result: { status: 1, stdout: '{"status":"404"}', stderr: "gh: Not Found (HTTP 404)" },
    },
  ]);
  const notFoundRegistry = new GitHubRegistry("nobody/repo", notFoundExec);
  try {
    await notFoundRegistry.getOrgMeta();
    assert(false, "getOrgMeta: should throw on 404");
  } catch (err) {
    assert(err instanceof OrgError, "getOrgMeta: throws OrgError on not found");
    assert((err as OrgError).code === "notFound", "getOrgMeta: OrgError.code is notFound on 404");
  }

  // ── 11q: listMembers — maps role_name correctly ───────────────────────────

  const membersExec = makeExec([
    {
      match: (a) => a.some(s => s.includes("collaborators")),
      result: {
        status: 0,
        stdout: JSON.stringify([
          { login: "alice", role_name: "admin" },
          { login: "bob", role_name: "write" },
          { login: "carol", role_name: "read" },
        ]),
        stderr: "",
      },
    },
  ]);
  const membersRegistry = new GitHubRegistry("alice/fleet-org", membersExec);
  const members = await membersRegistry.listMembers();
  assert(members.length === 3, "listMembers: returns all 3 collaborators");
  assert(members[0].login === "alice" && members[0].role === "owner", "listMembers: admin → role=owner");
  assert(members[1].login === "bob" && members[1].role === "member", "listMembers: write → role=member");
  assert(members[2].login === "carol" && members[2].role === "member", "listMembers: read → role=member");

  // ── 11r: inviteMember — happy path (W5) ──────────────────────────────────

  const inviteHappyExec = makeExec([
    {
      match: (a) => a.includes("--method") && a.includes("PUT") && a.some((s) => s.includes("collaborators/newmember")),
      result: { status: 0, stdout: "{}", stderr: "" },
    },
  ]);
  const inviteRegistry = new GitHubRegistry("owner/fleet-org", inviteHappyExec);
  let inviteThrew = false;
  try {
    await inviteRegistry.inviteMember("newmember");
  } catch {
    inviteThrew = true;
  }
  assert(!inviteThrew, "inviteMember: happy path resolves without throwing");

  // ── 11s: inviteMember — 422 must-be-org-member → OrgError unauthorized (W5, pins C1) ─

  const invite422Exec = makeExec([
    {
      match: (a) => a.includes("--method") && a.includes("PUT") && a.some((s) => s.includes("collaborators/")),
      result: {
        status: 1,
        stdout: '{"message":"Must be an organization member","status":"422"}',
        stderr: "gh: Unprocessable Entity (HTTP 422)",
      },
    },
  ]);
  const invite422Registry = new GitHubRegistry("owner/fleet-org", invite422Exec);
  try {
    await invite422Registry.inviteMember("someuser");
    assert(false, "inviteMember: should throw on 422 must-be-org-member");
  } catch (err) {
    assert(err instanceof OrgError, "inviteMember: throws OrgError on 422 membership error");
    assert((err as OrgError).code === "unauthorized", "inviteMember: OrgError.code is unauthorized on 422 must-be-org-member (C1)");
  }

  // ── 11t: unshareAgent — traversal input → throws OrgError notFound (W2, W5) ─

  const traversalRegistry = new GitHubRegistry("owner/fleet-org", makeExec([]));
  try {
    await traversalRegistry.unshareAgent("../org.json");
    assert(false, "unshareAgent: should throw on traversal path segment");
  } catch (err) {
    assert(err instanceof OrgError, "unshareAgent: throws OrgError on invalid agent id (W2)");
    assert((err as OrgError).code === "notFound", "unshareAgent: OrgError.code is notFound for traversal id (W2)");
  }

  // ── 11u: listMembers — args include --paginate (W1, W5) ──────────────────

  let listMembersArgs: string[] = [];
  const paginateExec: GhExecFn = (args) => {
    if (args.some((s) => s.includes("collaborators"))) {
      listMembersArgs = args;
      return { status: 0, stdout: "[]", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  const paginateRegistry = new GitHubRegistry("owner/fleet-org", paginateExec);
  await paginateRegistry.listMembers();
  assert(listMembersArgs.includes("--paginate"), "listMembers: args include --paginate (W1)");
  assert(listMembersArgs.includes("-F"), "listMembers: args include -F flag for per_page");
  assert(listMembersArgs.some((s) => s.includes("per_page=100")), "listMembers: args include per_page=100");
}

// ── Level 12: OrgManager + DB — reconcile, prune, guards, cascade (T10, PR1b) ─
//
// Uses FakeRegistry (in-memory) + GatewayState(":memory:") so no gh process
// or disk DB is needed. Covers: reconcile upsert, prune, pull-failure no-prune,
// ORG-06 guard, ORG-12 isOrgAgent, DB cascade, getOrgAgent summary fields,
// and the createOrg/bindOrg state machine binding persistence.

async function testOrgManagerAndDb(): Promise<void> {
  console.log("\n[12] OrgManager + DB: reconcile / prune / guards / cascade …");

  const orgId = "org_test_mgr";
  const STORE_PATH = join(DATA_DIR, "org-manager-test.json");

  // Helper: fresh manager per sub-test to avoid state leakage.
  function makeManager(login: string): { manager: OrgManager; fake: FakeRegistry; state: GatewayState; store: OrgStore } {
    const fake = new FakeRegistry(login);
    const state = new GatewayState(":memory:");
    const store = new OrgStore(join(DATA_DIR, `mgr-${login}-${Date.now()}.json`));
    const manager = new OrgManager(fake, store, state);
    return { manager, fake, state, store };
  }

  // ── 12a: reconcile upsert — agents + org_agents rows created correctly ────

  {
    const { manager, fake, state, store } = makeManager("alice");
    fake.seedOrg({ schemaVersion: 1, orgId, name: "Mgr Org", owner: "alice", createdAt: new Date().toISOString() });
    store.save({ schemaVersion: 1, repo: "alice/fleet-org", orgId, orgName: "Mgr Org", myLogin: "alice", role: "owner", lastSyncedAt: null });

    const e1 = makeEntry("mgr-agent-1", { sharedBy: "alice", target: "fly" });
    const e2 = makeEntry("mgr-agent-2", { sharedBy: "alice", target: "cloudflare" });
    await fake.shareAgent(e1);
    await fake.shareAgent(e2);

    const result: ReconcileResult = await manager.reconcile();
    assert(result.count === 2, "reconcile: count is 2");
    assert(result.orgId === orgId, "reconcile: orgId matches binding");
    assert(typeof result.at === "string" && result.at.length > 0, "reconcile: at is a non-empty ISO string");

    // agents row exists with correct sourceRef
    const agent = state.getAgent("mgr-agent-1");
    assert(agent !== null, "reconcile: agents row created");
    assert(agent!.name === `Agent mgr-agent-1`, "reconcile: agent name matches entry");
    assert(agent!.sourceRef === e1.url, "reconcile: sourceRef = entry.url");

    // no deploys row → redeployable:false by convention
    assert(state.hasDeploy("mgr-agent-1") === false, "reconcile: no deploys row (redeployable:false)");

    // org_agents row created with correct provenance
    const orgAgent = state.getOrgAgent("mgr-agent-1");
    assert(orgAgent !== null, "reconcile: org_agents row created");
    assert(orgAgent!.orgId === orgId, "reconcile: orgAgent.orgId matches");
    assert(orgAgent!.sharedBy === "alice", "reconcile: orgAgent.sharedBy is alice");
    assert(orgAgent!.target === "fly", "reconcile: orgAgent.target is fly");
    assert(orgAgent!.sharedAt === e1.sharedAt, "reconcile: orgAgent.sharedAt matches entry");

    // isOrgAgent returns true for org agent
    assert(state.isOrgAgent("mgr-agent-1") === true, "reconcile: isOrgAgent returns true for org agent");

    // lastSyncedAt was touched
    const binding = store.load();
    assert(binding !== null, "reconcile: binding still exists after reconcile");
    assert(binding!.lastSyncedAt !== null, "reconcile: lastSyncedAt updated after reconcile");
  }

  // ── 12b: prune — removes vanished org rows; LOCAL agents intact ───────────

  {
    const { manager, fake, state, store } = makeManager("alice");
    fake.seedOrg({ schemaVersion: 1, orgId, name: "Mgr Org", owner: "alice", createdAt: new Date().toISOString() });
    store.save({ schemaVersion: 1, repo: "alice/fleet-org", orgId, orgName: "Mgr Org", myLogin: "alice", role: "owner", lastSyncedAt: null });

    // Seed a local agent (no org_agents row) — must survive prune.
    state.upsertAgent(
      { id: "local-agent", name: "Local", version: "1.0.0", description: "", model: "" },
      "flue",
      "https://local.fly.dev",
    );

    // First reconcile: 2 org agents.
    await fake.shareAgent(makeEntry("prune-keep"));
    await fake.shareAgent(makeEntry("prune-gone"));
    await manager.reconcile();

    // Remove prune-gone from registry then reconcile again.
    await fake.unshareAgent("prune-gone");
    await manager.reconcile();

    assert(state.getAgent("prune-keep") !== null, "prune: kept agent still exists");
    assert(state.getOrgAgent("prune-keep") !== null, "prune: org_agents row for kept agent still exists");
    assert(state.getAgent("prune-gone") === null, "prune: vanished agent removed from agents");
    assert(state.getOrgAgent("prune-gone") === null, "prune: org_agents row for vanished agent removed");

    // Local agent is NEVER touched by prune (no org_agents row).
    assert(state.getAgent("local-agent") !== null, "prune: local agent NOT removed by org prune");
    assert(state.isOrgAgent("local-agent") === false, "prune: local agent isOrgAgent is false");
  }

  // ── 12c: pull-failure path — prune NOT called; existing rows survive ───────

  {
    const { manager, fake, state, store } = makeManager("alice");
    fake.seedOrg({ schemaVersion: 1, orgId, name: "Mgr Org", owner: "alice", createdAt: new Date().toISOString() });
    store.save({ schemaVersion: 1, repo: "alice/fleet-org", orgId, orgName: "Mgr Org", myLogin: "alice", role: "owner", lastSyncedAt: null });

    await fake.shareAgent(makeEntry("survive-agent"));
    await manager.reconcile();
    assert(state.getAgent("survive-agent") !== null, "pull-failure setup: survive-agent in DB");

    // Simulate next pull failing.
    fake.simulatePullFailure();
    let threw = false;
    try {
      await manager.reconcile();
    } catch (err) {
      assert(err instanceof OrgError, "pull-failure: reconcile throws OrgError on pull failure");
      assert((err as OrgError).code === "networkError", "pull-failure: OrgError.code is networkError");
      threw = true;
    }
    assert(threw, "pull-failure: reconcile threw on simulated pull failure");

    // Existing org row MUST still be present (prune hard rule).
    assert(state.getAgent("survive-agent") !== null, "pull-failure: existing org agent row survives (no prune)");
    assert(state.isOrgAgent("survive-agent") === true, "pull-failure: isOrgAgent still true after failed pull");
  }

  // ── 12d: ORG-06 guard — shareAgent rejects non-routable target + empty url ─

  {
    const { manager } = makeManager("alice");

    // docker-local target (type-cast for runtime guard test)
    const dockerEntry = { ...makeEntry("docker-agent"), target: "docker-local" } as unknown as SharedAgentEntry;
    let dockerThrew = false;
    try {
      await manager.shareAgent(dockerEntry);
    } catch (err) {
      assert(err instanceof OrgError, "ORG-06: throws OrgError for docker-local target");
      assert((err as OrgError).code === "conflict", "ORG-06: OrgError.code is conflict for docker-local target");
      dockerThrew = true;
    }
    assert(dockerThrew, "ORG-06: docker-local share was rejected");

    // Empty url
    const emptyUrlEntry = { ...makeEntry("empty-url-agent"), url: "" };
    let emptyUrlThrew = false;
    try {
      await manager.shareAgent(emptyUrlEntry);
    } catch (err) {
      assert(err instanceof OrgError, "ORG-06: throws OrgError for empty url");
      assert((err as OrgError).code === "conflict", "ORG-06: OrgError.code is conflict for empty url");
      emptyUrlThrew = true;
    }
    assert(emptyUrlThrew, "ORG-06: empty-url share was rejected");
  }

  // ── 12e: DB cascade — deleteOrgAgent removes agents + org_agents rows ──────

  {
    const state = new GatewayState(":memory:");
    const entry = makeEntry("cascade-agent");
    state.upsertOrgAgent(entry, orgId);
    assert(state.getAgent("cascade-agent") !== null, "cascade: agents row created");
    assert(state.getOrgAgent("cascade-agent") !== null, "cascade: org_agents row created");

    state.deleteOrgAgent("cascade-agent");
    assert(state.getAgent("cascade-agent") === null, "cascade: agents row deleted");
    assert(state.getOrgAgent("cascade-agent") === null, "cascade: org_agents row cascade-deleted");
  }

  // ── 12f: isOrgAgent — correct values for org vs local vs unknown ───────────

  {
    const state = new GatewayState(":memory:");
    const entry = makeEntry("org-is-agent");
    state.upsertOrgAgent(entry, orgId);

    state.upsertAgent({ id: "local-is-agent", name: "Local", version: "1.0.0", description: "", model: "" }, "flue", "https://local.fly.dev");

    assert(state.isOrgAgent("org-is-agent") === true, "isOrgAgent: true for org agent");
    assert(state.isOrgAgent("local-is-agent") === false, "isOrgAgent: false for local agent");
    assert(state.isOrgAgent("unknown-id") === false, "isOrgAgent: false for unknown id");
  }

  // ── 12g: getOrgAgent — summary fields (origin/sharedBy/target, ADR-2) ──────

  {
    const state = new GatewayState(":memory:");
    const entry = makeEntry("summary-agent", { sharedBy: "carol", target: "dokploy" });
    state.upsertOrgAgent(entry, orgId);

    const orgAgent = state.getOrgAgent("summary-agent");
    assert(orgAgent !== null, "getOrgAgent: returns non-null for org agent");
    assert(orgAgent!.sharedBy === "carol", "getOrgAgent: sharedBy matches entry");
    assert(orgAgent!.target === "dokploy", "getOrgAgent: target matches entry");
    assert(orgAgent!.orgId === orgId, "getOrgAgent: orgId matches");

    // origin is derived: org if row exists, local if absent.
    const origin = orgAgent ? "org" : "local";
    assert(origin === "org", "origin is 'org' when org_agents row exists (ADR-2)");

    // A plain upsertAgent with no org row → origin:local
    state.upsertAgent({ id: "plain-agent", name: "Plain", version: "1.0.0", description: "", model: "" }, "flue", "https://plain.fly.dev");
    const plainOrgRow = state.getOrgAgent("plain-agent");
    assert(plainOrgRow === null, "getOrgAgent: null for plain agent (local origin)");
    const localOrigin = plainOrgRow ? "org" : "local";
    assert(localOrigin === "local", "origin is 'local' when no org_agents row (ADR-2)");
  }

  // ── 12h: listOrgAgents + listOrgAgentIds — scoped to orgId ───────────────

  {
    const state = new GatewayState(":memory:");
    state.upsertOrgAgent(makeEntry("list-1"), "org_a");
    state.upsertOrgAgent(makeEntry("list-2"), "org_a");
    state.upsertOrgAgent(makeEntry("list-3"), "org_b");

    const agentsA = state.listOrgAgents("org_a");
    assert(agentsA.length === 2, "listOrgAgents: returns 2 entries for org_a");
    assert(agentsA.every((a) => a.orgId === "org_a"), "listOrgAgents: all entries have orgId=org_a");

    const idsA = state.listOrgAgentIds("org_a");
    assert(idsA.length === 2, "listOrgAgentIds: returns 2 ids for org_a");
    assert(idsA.includes("list-1") && idsA.includes("list-2"), "listOrgAgentIds: includes list-1 and list-2");

    const idsB = state.listOrgAgentIds("org_b");
    assert(idsB.length === 1 && idsB[0] === "list-3", "listOrgAgentIds: org_b has only list-3");
  }

  // ── 12i: createOrg state machine — binding persisted with role=owner ───────

  {
    const fake = new FakeRegistry("dave");
    const state = new GatewayState(":memory:");
    const store = new OrgStore(join(DATA_DIR, `mgr-dave-${Date.now()}.json`));
    const manager = new OrgManager(fake, store, state);

    const meta = await manager.createOrg("dave/my-org", "Dave Org");
    assert(meta.owner === "dave", "createOrg: OrgMeta.owner is dave");

    const binding = store.load();
    assert(binding !== null, "createOrg: binding persisted");
    assert(binding!.role === "owner", "createOrg: binding.role is owner");
    assert(binding!.myLogin === "dave", "createOrg: binding.myLogin is dave");
    assert(binding!.orgId === meta.orgId, "createOrg: binding.orgId matches OrgMeta.orgId");
    assert(manager.isBound() === true, "createOrg: isBound() is true after createOrg");
  }

  // ── 12j: bindOrg state machine — role derived from owner comparison ────────

  {
    const aliceFake = new FakeRegistry("alice");
    const bobFake = new FakeRegistry("bob");
    const meta = await aliceFake.createOrg("alice/shared-org", "Shared Org");

    // alice binds → owner (whoami === meta.owner)
    const aliceState = new GatewayState(":memory:");
    const aliceStore = new OrgStore(join(DATA_DIR, `mgr-alice-bind-${Date.now()}.json`));
    const aliceManager = new OrgManager(aliceFake, aliceStore, aliceState);
    await aliceManager.bindOrg("alice/shared-org");
    assert(aliceStore.load()?.role === "owner", "bindOrg: alice derives role=owner (whoami===owner)");

    // bob binds → member (whoami !== meta.owner)
    bobFake.seedOrg(meta);
    const bobState = new GatewayState(":memory:");
    const bobStore = new OrgStore(join(DATA_DIR, `mgr-bob-bind-${Date.now()}.json`));
    const bobManager = new OrgManager(bobFake, bobStore, bobState);
    await bobManager.bindOrg("alice/shared-org");
    assert(bobStore.load()?.role === "member", "bindOrg: bob derives role=member (whoami!==owner)");
  }

  // ── 12k: leave — clears binding and prunes all org rows ──────────────────

  {
    const { manager, fake, state, store } = makeManager("alice");
    fake.seedOrg({ schemaVersion: 1, orgId, name: "Mgr Org", owner: "alice", createdAt: new Date().toISOString() });
    store.save({ schemaVersion: 1, repo: "alice/fleet-org", orgId, orgName: "Mgr Org", myLogin: "alice", role: "owner", lastSyncedAt: null });
    await fake.shareAgent(makeEntry("leave-agent-1"));
    await fake.shareAgent(makeEntry("leave-agent-2"));
    await manager.reconcile();
    assert(state.listOrgAgentIds(orgId).length === 2, "leave setup: 2 org agents in DB");

    await manager.leave();

    assert(manager.isBound() === false, "leave: isBound() is false after leave");
    assert(manager.getBinding() === null, "leave: getBinding() is null after leave");
    assert(state.getAgent("leave-agent-1") === null, "leave: org agent 1 removed from DB");
    assert(state.getAgent("leave-agent-2") === null, "leave: org agent 2 removed from DB");
    assert(state.listOrgAgentIds(orgId).length === 0, "leave: no org_agents rows remain after leave");
  }

  // ── 12l: C1 — local-agent collision guard ────────────────────────────────
  // A shared entry whose id matches a LOCAL agent must be SKIPPED (warn, no throw).
  // The local agent row is preserved intact; no org_agents row is created.
  // The rest of the directory still reconciles normally.

  {
    const { manager, fake, state, store } = makeManager("alice");
    fake.seedOrg({ schemaVersion: 1, orgId, name: "Mgr Org", owner: "alice", createdAt: new Date().toISOString() });
    store.save({ schemaVersion: 1, repo: "alice/fleet-org", orgId, orgName: "Mgr Org", myLogin: "alice", role: "owner", lastSyncedAt: null });

    // Seed a local agent (no org_agents row) with id "collision-agent".
    state.upsertAgent(
      { id: "collision-agent", name: "My Local Agent", version: "2.0.0", description: "local", model: "claude-3-opus" },
      "flue",
      "https://my-local.fly.dev",
    );

    // Registry contains the same id "collision-agent" plus a safe entry.
    await fake.shareAgent(makeEntry("collision-agent", { name: "Remote Agent", url: "https://org.fly.dev/collision-agent" }));
    await fake.shareAgent(makeEntry("other-org-agent"));

    await manager.reconcile();

    // Local agent row UNCHANGED — name/sourceRef intact.
    const localAgent = state.getAgent("collision-agent");
    assert(localAgent !== null, "C1: local agent row still exists after collision reconcile");
    assert(localAgent!.name === "My Local Agent", "C1: local agent name NOT overwritten by shared entry");
    assert(localAgent!.sourceRef === "https://my-local.fly.dev", "C1: local agent sourceRef NOT overwritten");

    // NO org_agents satellite row created for the collision id.
    assert(state.getOrgAgent("collision-agent") === null, "C1: no org_agents row created for collision id");
    assert(state.isOrgAgent("collision-agent") === false, "C1: collision-agent remains a local agent");

    // The rest of the directory still reconciled normally.
    assert(state.getAgent("other-org-agent") !== null, "C1: non-colliding entry reconciled normally");
    assert(state.getOrgAgent("other-org-agent") !== null, "C1: org_agents row created for non-colliding entry");
  }

  // ── 12m: W1 — double-bind conflict guard ─────────────────────────────────
  // bindOrg to a DIFFERENT org when already bound → OrgError('conflict').
  // createOrg when already bound → OrgError('conflict').
  // bindOrg to the SAME org id when already bound → allowed (refresh binding).

  {
    // Seed an initial binding (alice is already bound to orgId).
    const existingBinding = { schemaVersion: 1 as const, repo: "alice/org-1", orgId: "org_already_bound", orgName: "Existing Org", myLogin: "alice", role: "owner" as const, lastSyncedAt: null };
    const boundStore = new OrgStore(join(DATA_DIR, `mgr-doublebind-${Date.now()}.json`));
    const boundState = new GatewayState(":memory:");
    boundStore.save(existingBinding);

    // bindOrg to a DIFFERENT org id → throws conflict.
    const fakeOther = new FakeRegistry("alice");
    fakeOther.seedOrg({ schemaVersion: 1, orgId: "org_different_456", name: "Other Org", owner: "alice", createdAt: new Date().toISOString() });
    const managerOther = new OrgManager(fakeOther, boundStore, boundState);
    let differentOrgThrew = false;
    try {
      await managerOther.bindOrg("alice/org-2");
    } catch (err) {
      assert(err instanceof OrgError, "W1: bindOrg to different org throws OrgError");
      assert((err as OrgError).code === "conflict", "W1: OrgError.code is conflict for different org bind");
      differentOrgThrew = true;
    }
    assert(differentOrgThrew, "W1: bindOrg to different org was rejected");
    // Binding is unchanged (the throw prevented the re-save).
    assert(boundStore.load()?.orgId === "org_already_bound", "W1: original binding preserved after rejected rebind");

    // createOrg when already bound → throws conflict.
    const fakeCreate = new FakeRegistry("alice");
    const managerCreate = new OrgManager(fakeCreate, boundStore, boundState);
    let createBoundThrew = false;
    try {
      await managerCreate.createOrg("alice/org-new", "New Org");
    } catch (err) {
      assert(err instanceof OrgError, "W1: createOrg when already bound throws OrgError");
      assert((err as OrgError).code === "conflict", "W1: OrgError.code is conflict for createOrg when already bound");
      createBoundThrew = true;
    }
    assert(createBoundThrew, "W1: createOrg when already bound was rejected");

    // bindOrg to the SAME org id → allowed (refresh binding).
    const fakeSame = new FakeRegistry("alice");
    fakeSame.seedOrg({ schemaVersion: 1, orgId: "org_already_bound", name: "Existing Org", owner: "alice", createdAt: new Date().toISOString() });
    const managerSame = new OrgManager(fakeSame, boundStore, boundState);
    let sameOrgThrew = false;
    try {
      await managerSame.bindOrg("alice/org-1");
    } catch {
      sameOrgThrew = true;
    }
    assert(!sameOrgThrew, "W1: bindOrg to SAME org id is allowed (refresh binding)");
    assert(boundStore.load()?.orgId === "org_already_bound", "W1: binding orgId unchanged after same-org rebind");
  }

  // ── 12n: W4 — empty successful pull prunes all org agents ─────────────────
  // INTENTIONAL per the partial-results ADR: an empty successful pullDirectory()
  // means the org owner unshared all agents. This is distinct from a pull failure
  // (which must NOT prune — see 12c). An empty org → prune all rows.

  {
    const { manager, fake, state, store } = makeManager("alice");
    fake.seedOrg({ schemaVersion: 1, orgId, name: "Mgr Org", owner: "alice", createdAt: new Date().toISOString() });
    store.save({ schemaVersion: 1, repo: "alice/fleet-org", orgId, orgName: "Mgr Org", myLogin: "alice", role: "owner", lastSyncedAt: null });

    // Seed and reconcile 2 org agents.
    await fake.shareAgent(makeEntry("empty-pull-1"));
    await fake.shareAgent(makeEntry("empty-pull-2"));
    await manager.reconcile();
    assert(state.listOrgAgentIds(orgId).length === 2, "empty-pull setup: 2 org agents in DB");

    // Clear the FakeRegistry directory (successful pull returning []).
    await fake.unshareAgent("empty-pull-1");
    await fake.unshareAgent("empty-pull-2");
    await manager.reconcile();

    // Both org agents pruned — INTENTIONAL: empty org = empty directory.
    assert(state.getAgent("empty-pull-1") === null, "empty-pull: agent-1 pruned after empty directory");
    assert(state.getAgent("empty-pull-2") === null, "empty-pull: agent-2 pruned after empty directory");
    assert(state.listOrgAgentIds(orgId).length === 0, "empty-pull: no org_agents rows remain after empty directory reconcile");
  }

  // ── 12o: getOwnSharedAgentIds — collision in reconcile populates the set ────
  // Two registry entries: one whose id collides with a LOCAL agent (owner's own
  // share), one that doesn't. Only the collision id appears in
  // getOwnSharedAgentIds(); the non-colliding entry reconciles normally.

  {
    const { manager, fake, state, store } = makeManager("alice");
    fake.seedOrg({ schemaVersion: 1, orgId, name: "Mgr Org", owner: "alice", createdAt: new Date().toISOString() });
    store.save({ schemaVersion: 1, repo: "alice/fleet-org", orgId, orgName: "Mgr Org", myLogin: "alice", role: "owner", lastSyncedAt: null });

    // Seed a local (non-org) agent — simulates the owner's own deployed agent.
    state.upsertAgent(
      { id: "own-share-local", name: "My Shared Agent", version: "1.0.0", description: "owner's", model: "claude" },
      "flue",
      "https://owner.fly.dev/own-share-local",
    );

    // Registry has two entries: the collision (owner's own share) + one from a member.
    await fake.shareAgent(makeEntry("own-share-local", { sharedBy: "alice", target: "fly" }));
    await fake.shareAgent(makeEntry("other-member-agent", { sharedBy: "bob", target: "cloudflare" }));

    await manager.reconcile();

    // Only the collision id is in getOwnSharedAgentIds().
    const ownIds = manager.getOwnSharedAgentIds();
    assert(ownIds.includes("own-share-local"), "12o: getOwnSharedAgentIds contains the collision id");
    assert(!ownIds.includes("other-member-agent"), "12o: getOwnSharedAgentIds does NOT contain non-colliding entry");
    assert(ownIds.length === 1, "12o: getOwnSharedAgentIds has exactly 1 entry");

    // Non-colliding entry is in the DB as an org agent.
    assert(state.getOrgAgent("other-member-agent") !== null, "12o: non-colliding entry reconciled normally");
    // Collision entry is NOT in org_agents (local row preserved).
    assert(state.getOrgAgent("own-share-local") === null, "12o: no org_agents row for collision id");
  }

  // ── 12p: shareAgent → adds to ownSharedAgentIds; unshareAgent → removes it ──

  {
    const { manager, fake, store } = makeManager("alice");
    fake.seedOrg({ schemaVersion: 1, orgId, name: "Mgr Org", owner: "alice", createdAt: new Date().toISOString() });
    store.save({ schemaVersion: 1, repo: "alice/fleet-org", orgId, orgName: "Mgr Org", myLogin: "alice", role: "owner", lastSyncedAt: null });

    // Initially empty.
    assert(manager.getOwnSharedAgentIds().length === 0, "12p: ownSharedAgentIds empty before share");

    const entry = makeEntry("share-track-agent", { target: "fly" });
    await manager.shareAgent(entry);
    assert(manager.getOwnSharedAgentIds().includes("share-track-agent"), "12p: ownSharedAgentIds contains id after shareAgent");

    await manager.unshareAgent("share-track-agent");
    assert(!manager.getOwnSharedAgentIds().includes("share-track-agent"), "12p: ownSharedAgentIds no longer contains id after unshareAgent");
    assert(manager.getOwnSharedAgentIds().length === 0, "12p: ownSharedAgentIds is empty after unshareAgent");
  }

  // ── 12q: leave → clears ownSharedAgentIds ────────────────────────────────

  {
    const { manager, fake, state, store } = makeManager("alice");
    fake.seedOrg({ schemaVersion: 1, orgId, name: "Mgr Org", owner: "alice", createdAt: new Date().toISOString() });
    store.save({ schemaVersion: 1, repo: "alice/fleet-org", orgId, orgName: "Mgr Org", myLogin: "alice", role: "owner", lastSyncedAt: null });

    // Seed a local agent so reconcile detects a collision.
    state.upsertAgent(
      { id: "leave-own-share", name: "Leave Agent", version: "1.0.0", description: "", model: "" },
      "flue",
      "https://leave.fly.dev",
    );
    await fake.shareAgent(makeEntry("leave-own-share", { target: "fly" }));
    await manager.reconcile();
    assert(manager.getOwnSharedAgentIds().includes("leave-own-share"), "12q: ownSharedAgentIds populated before leave");

    await manager.leave();

    assert(manager.getOwnSharedAgentIds().length === 0, "12q: ownSharedAgentIds cleared after leave");
    assert(manager.isBound() === false, "12q: manager unbound after leave");
  }

  // ── 12r: reconcile rebuild — ownSharedAgentIds cleared each run ──────────
  // After unshare from registry, next reconcile removes the id from the set.

  {
    const { manager, fake, state, store } = makeManager("alice");
    fake.seedOrg({ schemaVersion: 1, orgId, name: "Mgr Org", owner: "alice", createdAt: new Date().toISOString() });
    store.save({ schemaVersion: 1, repo: "alice/fleet-org", orgId, orgName: "Mgr Org", myLogin: "alice", role: "owner", lastSyncedAt: null });

    state.upsertAgent(
      { id: "rebuild-own-share", name: "Rebuild Agent", version: "1.0.0", description: "", model: "" },
      "flue",
      "https://rebuild.fly.dev",
    );
    await fake.shareAgent(makeEntry("rebuild-own-share", { target: "fly" }));
    await manager.reconcile();
    assert(manager.getOwnSharedAgentIds().includes("rebuild-own-share"), "12r: ownSharedAgentIds populated after first reconcile");

    // Remove from registry (owner unshared it externally).
    await fake.unshareAgent("rebuild-own-share");
    await manager.reconcile();

    assert(!manager.getOwnSharedAgentIds().includes("rebuild-own-share"), "12r: ownSharedAgentIds cleared after entry removed from registry");
    assert(manager.getOwnSharedAgentIds().length === 0, "12r: ownSharedAgentIds empty after registry clear");
  }
}

// ── Level 13: Core API handlers — org.* wire via GatewayCore (T15, PR2) ─────
//
// Uses GatewayCore with dbPath:":memory:" and orgRegistry:FakeRegistry so no
// gh process, no disk DB, no network. Covers: org.status none→bound, org.create,
// org.join, org.leave, org.sync, org.share guards (local target + token-protected
// + org-agent source), org.unshare, org.members, ORG-12 agent.stop/delete/
// redeploy/config.set on org agents, and AgentSummary origin/sharedBy.

import { GatewayCore } from "../src/core.js";
import type { ClientRequest, ServerEvent, AgentSummary } from "../src/api.js";

/** Send one request to a GatewayCore instance and collect all emitted events. */
async function coreHandle(core: GatewayCore, req: ClientRequest): Promise<ServerEvent[]> {
  const events: ServerEvent[] = [];
  await core.handle(req, (e) => events.push(e));
  return events;
}

/** Find the first event of a given type in an array. */
function findEvent<T extends ServerEvent["type"]>(
  events: ServerEvent[],
  type: T,
): Extract<ServerEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as Extract<ServerEvent, { type: T }> | undefined;
}

/**
 * Remove the org-binding.json written by OrgStore to DATA_DIR so each
 * Level-13 sub-test starts with a clean state. GatewayCore instances share
 * the same DATA_DIR (GATEWAY_DATA_DIR env var), so test isolation requires
 * explicit cleanup between sub-tests.
 */
function clearOrgBindingFile(): void {
  const bindingPath = join(DATA_DIR, "org-binding.json");
  rmSync(bindingPath, { force: true });
}

async function testCoreOrgHandlers(): Promise<void> {
  console.log("\n[13] Core API handlers: org.* wire …");

  // ── 13a: org.status when not bound ────────────────────────────────────────

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    const events = await coreHandle(core, { type: "org.status" });
    const status = findEvent(events, "org.status");
    assert(status !== undefined, "13a: org.status emitted when not bound");
    assert(status?.bound === false, "13a: bound is false when not bound");
    await core.shutdown();
  }

  // ── 13b: org.create — creates binding, emits org.status bound=true ────────

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    const events = await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Test Org" });
    const status = findEvent(events, "org.status");
    assert(status !== undefined, "13b: org.create emits org.status");
    assert(status?.bound === true, "13b: bound is true after org.create");
    assert(status?.role === "owner", "13b: role is owner after org.create");
    assert(status?.orgName === "Test Org", "13b: orgName matches");
    assert(status?.myLogin === "alice", "13b: myLogin is alice");
    const errors = events.filter((e) => e.type === "org.error");
    assert(errors.length === 0, "13b: no org.error on successful create");
    await core.shutdown();
  }

  // ── 13c: org.join — binds as member, emits org.status ────────────────────

  {
    clearOrgBindingFile();
    // Seed a fake registry that already has an org (simulates the member scenario)
    const fake = new FakeRegistry("bob");
    await fake.createOrg("alice/fleet-org", "Team Org");
    // Override owner so bob is a member
    const ownerFake = new FakeRegistry("alice");
    await ownerFake.createOrg("alice/fleet-org", "Team Org");
    // bob uses a registry that serves alice's org meta
    const aliceMeta: OrgMeta = { schemaVersion: 1, orgId: "org_team", name: "Team Org", owner: "alice", createdAt: new Date().toISOString() };
    const memberFake = new FakeRegistry("bob");
    memberFake.seedOrg(aliceMeta);

    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: memberFake, healthIntervalMs: 60_000 });
    const events = await coreHandle(core, { type: "org.join", repo: "alice/fleet-org" });
    const status = findEvent(events, "org.status");
    assert(status !== undefined, "13c: org.join emits org.status");
    assert(status?.bound === true, "13c: bound is true after org.join");
    assert(status?.role === "member", "13c: role is member when whoami !== owner");
    await core.shutdown();
  }

  // ── 13d: org.leave — clears binding, emits org.status bound=false ─────────

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Leave Org" });
    // Confirm bound
    const beforeLeave = await coreHandle(core, { type: "org.status" });
    assert(findEvent(beforeLeave, "org.status")?.bound === true, "13d: bound before leave");
    // Leave
    const leaveEvents = await coreHandle(core, { type: "org.leave" });
    const status = findEvent(leaveEvents, "org.status");
    assert(status !== undefined, "13d: org.leave emits org.status");
    assert(status?.bound === false, "13d: bound is false after leave");
    // Confirm no longer bound
    const afterLeave = await coreHandle(core, { type: "org.status" });
    assert(findEvent(afterLeave, "org.status")?.bound === false, "13d: still unbound after leave");
    await core.shutdown();
  }

  // ── 13e: org.sync — reconciles and emits org.synced + agents + org.status ─

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Sync Org" });
    // Share an entry directly into fake registry to test sync pull
    await fake.shareAgent(makeEntry("sync-agent-1", { target: "fly" }));
    const syncEvents = await coreHandle(core, { type: "org.sync" });
    const synced = findEvent(syncEvents, "org.synced");
    assert(synced !== undefined, "13e: org.sync emits org.synced");
    assert(synced?.count === 1, "13e: org.synced count is 1");
    assert(typeof synced?.at === "string" && synced.at.length > 0, "13e: org.synced.at is an ISO string");
    const agentsEvt = findEvent(syncEvents, "agents");
    assert(agentsEvt !== undefined, "13e: org.sync emits agents list");
    await core.shutdown();
  }

  // ── 13f: org.sync when not bound — emits org.error ────────────────────────

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    const events = await coreHandle(core, { type: "org.sync" });
    const err = findEvent(events, "org.error");
    assert(err !== undefined, "13f: org.sync when not bound emits org.error");
    await core.shutdown();
  }

  // ── 13g: org.share — rejects org-sourced agent ────────────────────────────

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    // Setup: create org, sync one shared agent from the registry
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Share Org" });
    await fake.shareAgent(makeEntry("org-agent-share-test", { target: "fly" }));
    await coreHandle(core, { type: "org.sync" });
    // Attempt to share an org-sourced agent
    const events = await coreHandle(core, { type: "org.share", agentId: "org-agent-share-test" });
    const err = findEvent(events, "org.error");
    assert(err !== undefined, "13g: org.share on org agent emits org.error");
    assert(
      err!.message.toLowerCase().includes("org-sourced") || err!.message.toLowerCase().includes("locally owned"),
      "13g: org.error message explains org-sourced restriction",
    );
    await core.shutdown();
  }

  // ── 13h: org.share — rejects non-existent agent ───────────────────────────

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Share Org" });
    const events = await coreHandle(core, { type: "org.share", agentId: "nonexistent-id" });
    const err = findEvent(events, "org.error");
    assert(err !== undefined, "13h: org.share on nonexistent agent emits org.error");
    await core.shutdown();
  }

  // ── 13p: org.share — rejects token-protected agent (ORG-07) ───────────────
  // agent.connectFlue registers even unreachable agents (FlueAdapter.connect
  // swallows the admin probe), so a fake URL + token yields hasToken=true
  // without a live Flue server. The token guard runs before the target guard.

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Token Org" });
    const connectEvents = await coreHandle(core, {
      type: "agent.connectFlue",
      baseUrl: "http://127.0.0.1:1",
      agentName: "token-agent",
      token: "s3cret",
    });
    const registered = findEvent(connectEvents, "agent.registered");
    assert(registered !== undefined, "13p: token agent registers (unreachable URL is fine)");
    const events = await coreHandle(core, { type: "org.share", agentId: "token-agent" });
    const err = findEvent(events, "org.error");
    assert(err !== undefined, "13p: org.share on token-protected agent emits org.error");
    assert(
      err!.message.toLowerCase().includes("token-protected"),
      "13p: org.error message explains the token-protected restriction",
    );
    assert(err!.requestType === "org.share", "13p: org.error carries requestType org.share");
    await core.shutdown();
  }

  // ── 13i: org.members — emits org.members when bound ──────────────────────

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Members Org" });
    await fake.inviteMember("bob");
    const events = await coreHandle(core, { type: "org.members" });
    const membersEvt = findEvent(events, "org.members");
    assert(membersEvt !== undefined, "13i: org.members emits org.members event");
    assert(Array.isArray(membersEvt?.members), "13i: org.members.members is an array");
    assert(membersEvt!.members.some((m) => m.login === "alice"), "13i: alice is in members");
    await core.shutdown();
  }

  // ── 13j: org.members when not bound — emits org.error ────────────────────

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    const events = await coreHandle(core, { type: "org.members" });
    const err = findEvent(events, "org.error");
    assert(err !== undefined, "13j: org.members when not bound emits org.error");
    await core.shutdown();
  }

  // ── 13k: AgentSummary origin/sharedBy after org.sync ─────────────────────

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Origin Org" });
    const entry = makeEntry("origin-test-agent", { sharedBy: "bob", target: "cloudflare" });
    await fake.shareAgent(entry);
    await coreHandle(core, { type: "org.sync" });
    // Get agents list
    const listEvents = await coreHandle(core, { type: "agents.list" });
    const agentsEvt = findEvent(listEvents, "agents");
    assert(agentsEvt !== undefined, "13k: agents.list emits agents event");
    const orgAgent = agentsEvt!.agents.find((a: AgentSummary) => a.id === "origin-test-agent");
    assert(orgAgent !== undefined, "13k: org agent appears in agents list");
    assert(orgAgent!.origin === "org", "13k: org agent has origin='org'");
    assert(orgAgent!.sharedBy === "bob", "13k: org agent has correct sharedBy");
    assert(orgAgent!.target === "cloudflare", "13k: org agent has correct target from org_agents");
    assert(orgAgent!.redeployable === false, "13k: org agent is not redeployable");
    await core.shutdown();
  }

  // ── 13l: ORG-12 — agent.stop rejected for org agent ──────────────────────

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Stop Guard Org" });
    await fake.shareAgent(makeEntry("stop-guard-agent", { target: "fly" }));
    await coreHandle(core, { type: "org.sync" });
    const events = await coreHandle(core, { type: "agent.stop", agentId: "stop-guard-agent" });
    const err = findEvent(events, "error");
    assert(err !== undefined, "13l: agent.stop on org agent emits error");
    assert(
      err!.message.toLowerCase().includes("org") || err!.message.toLowerCase().includes("connect-only"),
      "13l: error message references org/connect-only",
    );
    await core.shutdown();
  }

  // ── 13m: ORG-12 — agent.delete rejected for org agent ────────────────────

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Delete Guard Org" });
    await fake.shareAgent(makeEntry("delete-guard-agent", { target: "fly" }));
    await coreHandle(core, { type: "org.sync" });
    const events = await coreHandle(core, { type: "agent.delete", agentId: "delete-guard-agent" });
    const err = findEvent(events, "error");
    assert(err !== undefined, "13m: agent.delete on org agent emits error");
    assert(
      err!.message.toLowerCase().includes("org") || err!.message.toLowerCase().includes("connect-only"),
      "13m: error message references org/connect-only",
    );
    await core.shutdown();
  }

  // ── 13n: ORG-12 — config.set rejected for org agent ──────────────────────

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Config Guard Org" });
    await fake.shareAgent(makeEntry("config-guard-agent", { target: "fly" }));
    await coreHandle(core, { type: "org.sync" });
    const events = await coreHandle(core, { type: "config.set", agentId: "config-guard-agent", modelSpecifier: "anthropic/claude-haiku-4-6" });
    const err = findEvent(events, "error");
    assert(err !== undefined, "13n: config.set on org agent emits error");
    assert(
      err!.message.toLowerCase().includes("org") || err!.message.toLowerCase().includes("connect-only"),
      "13n: error message references org/connect-only",
    );
    await core.shutdown();
  }

  // ── 13o: ORG-12 — agent.redeploy rejected for org agent (emits deploy.error) ─

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Redeploy Guard Org" });
    await fake.shareAgent(makeEntry("redeploy-guard-agent", { target: "fly" }));
    await coreHandle(core, { type: "org.sync" });
    const events = await coreHandle(core, { type: "agent.redeploy", agentId: "redeploy-guard-agent" });
    const err = findEvent(events, "deploy.error");
    assert(err !== undefined, "13o: agent.redeploy on org agent emits deploy.error");
    assert(
      err!.message.toLowerCase().includes("org") || err!.message.toLowerCase().includes("connect-only"),
      "13o: deploy.error message references org/connect-only",
    );
    await core.shutdown();
  }

  // ── 13r: ownSharedAgentIds after org.sync with collision ─────────────────
  // Connect a local agent, seed the SAME id into the FakeRegistry directory,
  // then sync. reconcile() detects the collision → ownSharedAgentIds is
  // populated → org.status.ownSharedAgentIds includes the id.

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Own Shares Org" });

    // Connect a local agent (even an unreachable URL works — FlueAdapter.connect
    // swallows the admin probe and still registers the agent row).
    const connectEvents = await coreHandle(core, {
      type: "agent.connectFlue",
      baseUrl: "http://127.0.0.1:1",
      agentName: "own-share-agent",
    });
    const registered = findEvent(connectEvents, "agent.registered");
    assert(registered !== undefined, "13r setup: local agent registered");
    const localAgentId = registered!.agent.id;

    // Seed the registry with this id (simulates the owner having shared it
    // in a previous session — it now lives in agents/<id>.json on GitHub).
    await fake.shareAgent(makeEntry(localAgentId, { sharedBy: "alice", target: "fly" }));

    // Sync: reconcile detects the C1 collision → ownSharedAgentIds populated.
    const syncEvents = await coreHandle(core, { type: "org.sync" });
    const statusAfterSync = findEvent(syncEvents, "org.status");
    assert(statusAfterSync !== undefined, "13r: org.sync emits org.status");
    assert(
      Array.isArray(statusAfterSync!.ownSharedAgentIds),
      "13r: org.status.ownSharedAgentIds is an array after sync",
    );
    assert(
      statusAfterSync!.ownSharedAgentIds!.includes(localAgentId),
      "13r: org.status.ownSharedAgentIds includes the owner's own share id after collision",
    );

    // Verify the local agent is NOT treated as an org agent (C1 guard preserved).
    const listEvents = await coreHandle(core, { type: "agents.list" });
    const agentsEvt = findEvent(listEvents, "agents");
    const localAgent = agentsEvt!.agents.find((a) => a.id === localAgentId);
    assert(localAgent?.origin === "local", "13r: collision id remains a local agent (origin=local)");

    await core.shutdown();
  }

  // ── 13s: org.unshare → ownSharedAgentIds updated in emitted org.status ────
  // After populating ownSharedAgentIds via collision (13r scenario), org.unshare
  // removes the id and the resulting org.status reflects the change.

  {
    clearOrgBindingFile();
    const fake = new FakeRegistry("alice");
    const core = new GatewayCore({ dbPath: ":memory:", orgRegistry: fake, healthIntervalMs: 60_000 });
    await coreHandle(core, { type: "org.create", repo: "alice/fleet-org", name: "Unshare Own Org" });

    // Connect a local agent and seed its id in the registry.
    const connectEvents = await coreHandle(core, {
      type: "agent.connectFlue",
      baseUrl: "http://127.0.0.1:1",
      agentName: "unshare-own-agent",
    });
    const localAgentId = findEvent(connectEvents, "agent.registered")!.agent.id;
    await fake.shareAgent(makeEntry(localAgentId, { sharedBy: "alice", target: "fly" }));

    // Populate ownSharedAgentIds via sync.
    const syncEvents = await coreHandle(core, { type: "org.sync" });
    const statusBeforeUnshare = findEvent(syncEvents, "org.status");
    assert(
      statusBeforeUnshare!.ownSharedAgentIds!.includes(localAgentId),
      "13s setup: ownSharedAgentIds populated before unshare",
    );

    // Unshare via Core handler.
    const unshareEvents = await coreHandle(core, { type: "org.unshare", agentId: localAgentId });
    const statusAfterUnshare = findEvent(unshareEvents, "org.status");
    assert(statusAfterUnshare !== undefined, "13s: org.unshare emits org.status");
    assert(
      Array.isArray(statusAfterUnshare!.ownSharedAgentIds),
      "13s: org.status.ownSharedAgentIds is an array after unshare",
    );
    assert(
      !statusAfterUnshare!.ownSharedAgentIds!.includes(localAgentId),
      "13s: org.status.ownSharedAgentIds does NOT include id after org.unshare",
    );

    await core.shutdown();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  try {
    await testFakeRegistryContract();
    testSharedAgentEntryNoSecrets();
    testOrgStoreRoundTrip();
    testOrgStorePersistence();
    await testRoleDerivation();
    testSchemaVersionForwardCompat();
    testCorruptFileReturnsNull();
    testNestedPathSave();
    testOverwrite();
    await testOrgErrorCodes();
    await testGitHubRegistryExecSeam();
    await testOrgManagerAndDb();
    await testCoreOrgHandlers();
  } finally {
    rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
