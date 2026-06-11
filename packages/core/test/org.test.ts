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
  SharedAgentEntry,
} from "../src/org/index.js";
import { GitHubRegistry, OrgError, OrgStore, classifyGhError, decodeBase64Content, encodeBase64Content } from "../src/org/index.js";

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
    return Array.from(this.#agents.values());
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
