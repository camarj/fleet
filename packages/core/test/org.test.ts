/**
 * PR1a-i — OrgRegistry interface contract + OrgStore round-trip tests.
 *
 * Level 1: FakeRegistry interface contract — all methods callable, return
 *          correct shapes, no secret fields in SharedAgentEntry (ORG-14).
 * Level 2: OrgStore write + read + clear binding round-trip (ORG-01, ORG-03).
 * Level 3: Role derivation — owner when org.json.owner === whoami, member
 *          otherwise (ADR-3b).
 *
 * Note: T10 (PR1b) will append reconcile + DB + guard tests to this file.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/org.test.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".org-test");
process.env.GATEWAY_DATA_DIR = DATA_DIR;

import type {
  OrgBinding,
  OrgMember,
  OrgMeta,
  OrgRegistry,
  OrgRole,
  SharedAgentEntry,
} from "../src/org/index.js";
import { OrgStore } from "../src/org/index.js";

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
  // Simulate pull failure for the pull-failure prune path test.
  simulatePullFailure = false;

  constructor(login: string) {
    this.#login = login;
  }

  async whoami(): Promise<string> {
    return this.#login;
  }

  async createOrg(repo: string, name: string): Promise<OrgMeta> {
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
    if (!this.#orgMeta) throw new Error(`Fake: no org at ${repo}`);
    return this.#orgMeta;
  }

  async pullDirectory(): Promise<SharedAgentEntry[]> {
    if (this.simulatePullFailure) throw new Error("Fake: pull failure");
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  await testFakeRegistryContract();
  testSharedAgentEntryNoSecrets();
  testOrgStoreRoundTrip();
  testOrgStorePersistence();
  await testRoleDerivation();
  testSchemaVersionForwardCompat();

  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE ERROR:", err);
  process.exit(1);
});
