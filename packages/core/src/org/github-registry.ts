/**
 * GitHubRegistry — OrgRegistry backed by `gh api` (GitHub Contents REST).
 *
 * One file per agent in `agents/<id>.json`; per-file `sha` provides safe
 * last-write-wins (ADR-3a). Exec seam is injectable for tests. Never write secrets (rule #8).
 */

import { spawnSync } from "node:child_process";
import type { OrgMember, OrgMeta, OrgRegistry, SharedAgentEntry } from "./registry.js";
import { OrgError } from "./registry.js";

// ── Schema versioning ────────────────────────────────────────────────────────

/** Highest schemaVersion this build understands (forward-compat guard). */
const SCHEMA_VERSION_MAX = 1;

// ── Exec seam ────────────────────────────────────────────────────────────────

/**
 * Injectable `gh` executor.
 *
 * Returns the process exit status, stdout, and stderr. Tests swap the default
 * spawnSync implementation for a pure function to exercise GitHubRegistry logic
 * without any network access.
 */
export type GhExecFn = (args: string[]) => { status: number | null; stdout: string; stderr: string };

function defaultExec(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("gh", args, { stdio: "pipe", encoding: "utf8", timeout: 30_000 });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// ── Error classification ─────────────────────────────────────────────────────

/**
 * Map a failed gh invocation result to an OrgError with the appropriate code.
 *
 * Parses HTTP status codes from two gh output formats:
 *   - Inline text:  "HTTP 404"
 *   - JSON payload: `"status":"404"`
 *
 * 422 handling: sha-semantic errors (sha is required, provided sha, or 422+sha) → conflict;
 * admin/membership errors (422+must be an organization member/must have admin) → unauthorized;
 * other 422s fall through to the generic networkError fallback.
 */
export function classifyGhError(
  result: { status: number | null; stdout: string; stderr: string },
  contextMsg?: string,
): OrgError {
  const combined = `${result.stdout} ${result.stderr}`.toLowerCase();
  const prefix = contextMsg ? `${contextMsg}: ` : "";

  if (
    combined.includes("http 404") ||
    combined.includes('"status":"404"') ||
    combined.includes("not found")
  ) {
    return new OrgError("notFound", `${prefix}Resource not found in the registry repo.`);
  }

  if (
    combined.includes("http 401") ||
    combined.includes('"status":"401"') ||
    combined.includes("bad credentials") ||
    combined.includes("requires authentication") ||
    combined.includes("http 403") ||
    combined.includes('"status":"403"') ||
    combined.includes("must have push access") ||
    combined.includes("must be a collaborator") ||
    ((combined.includes("http 422") || combined.includes('"status":"422"')) &&
      (combined.includes("must be an organization member") || combined.includes("must have admin")))
  ) {
    return new OrgError(
      "unauthorized",
      `${prefix}GitHub authentication or authorization failed. Run: gh auth login`,
    );
  }

  if (
    combined.includes("http 409") ||
    combined.includes('"status":"409"') ||
    combined.includes("sha is required") ||
    combined.includes("provided sha") ||
    ((combined.includes("http 422") || combined.includes('"status":"422"')) &&
      combined.includes("sha"))
  ) {
    return new OrgError(
      "conflict",
      `${prefix}GitHub conflict — possible sha mismatch. Retry the operation.`,
    );
  }

  if (
    combined.includes("could not resolve host") ||
    combined.includes("connection refused") ||
    combined.includes("timed out") ||
    combined.includes("network") ||
    result.status === null
  ) {
    return new OrgError(
      "networkError",
      `${prefix}Registry repo unreachable. Check your network and gh authentication.`,
    );
  }

  return new OrgError(
    "networkError",
    `${prefix}gh command failed (exit ${result.status}): ${(result.stderr || result.stdout).trim()}`,
  );
}

// ── Encoding helpers ─────────────────────────────────────────────────────────

/**
 * Decode base64 content as returned by the GitHub Contents API.
 * GitHub wraps base64 at 60 chars with newlines — Buffer handles that automatically.
 */
export function decodeBase64Content(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf8");
}

/** Encode a UTF-8 string to base64 for writing via the GitHub Contents API. */
export function encodeBase64Content(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

// ── Internal validators ──────────────────────────────────────────────────────

function isValidSchemaVersion(v: unknown): v is number {
  return (
    typeof v === "number" &&
    !Number.isNaN(v) &&
    v >= 1 &&
    v <= SCHEMA_VERSION_MAX
  );
}

/** Allowlist regex for caller-controlled path segments (agent ids, GitHub logins). */
const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Throw OrgError('notFound') when a caller-controlled path segment contains
 * characters outside the allowlist, preventing path traversal.
 */
function validatePathSegment(value: string, label: string): void {
  if (!PATH_SEGMENT_RE.test(value)) {
    throw new OrgError("notFound", `Invalid ${label} "${value}" — only [a-zA-Z0-9_-] allowed.`);
  }
}

/** Safe filename allowlist for agents/ directory entries (traversal guard). */
const SAFE_AGENT_NAME_RE = /^[a-zA-Z0-9_-]+\.json$/;

// ── GitHubRegistry ────────────────────────────────────────────────────────────

/**
 * OrgRegistry backed by the GitHub Contents REST API via the `gh` CLI.
 *
 * Each instance is bound to one registry repo (`owner/repo`). The exec seam
 * defaults to a real spawnSync call; inject a GhExecFn in tests.
 */
export class GitHubRegistry implements OrgRegistry {
  readonly #repo: string;
  readonly #exec: GhExecFn;

  constructor(repo: string, exec: GhExecFn = defaultExec) {
    this.#repo = repo;
    this.#exec = exec;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Decode, parse, and validate org.json content from a GitHub Contents API response. */
  #decodeOrgMeta(raw: string, repo: string): OrgMeta {
    let meta: OrgMeta;
    try {
      const fileInfo = JSON.parse(raw) as { content: string };
      const json = decodeBase64Content(fileInfo.content);
      meta = JSON.parse(json) as OrgMeta;
    } catch {
      throw new OrgError(
        "conflict",
        `org.json in ${repo} is not valid JSON. The registry may be corrupted.`,
      );
    }
    if (!isValidSchemaVersion(meta.schemaVersion)) {
      throw new OrgError(
        "conflict",
        `org.json in ${repo} has unsupported schemaVersion ${meta.schemaVersion} (max known: ${SCHEMA_VERSION_MAX}).`,
      );
    }
    return meta;
  }

  // ── Identity ───────────────────────────────────────────────────────────────

  /**
   * Resolve the authenticated GitHub user identity.
   * Mirrors the pattern at core.ts:370 (`gh api user --jq .login`).
   */
  async whoami(): Promise<string> {
    const res = this.#exec(["api", "user", "--jq", ".login"]);
    if (res.status !== 0) {
      throw classifyGhError(
        res,
        "Could not resolve GitHub login — ensure gh is installed and authenticated (gh auth login)",
      );
    }
    const login = res.stdout.trim();
    if (!login) {
      throw new OrgError(
        "unauthorized",
        "Could not resolve GitHub login. Run: gh auth login",
      );
    }
    return login;
  }

  // ── Org lifecycle ──────────────────────────────────────────────────────────

  /**
   * MUST throw OrgError('alreadyExists') when org.json is already present.
   * The CALLER is responsible for persisting the local binding (OrgStore).
   */
  async createOrg(repo: string, name: string): Promise<OrgMeta> {
    // Guard: throw alreadyExists when org.json is already present.
    const checkRes = this.#exec(["api", `repos/${repo}/contents/org.json`]);
    if (checkRes.status === 0) {
      throw new OrgError(
        "alreadyExists",
        `org.json already present in ${repo} — org is already initialized.`,
      );
    }

    // Resolve the authenticated user login.
    const login = await this.whoami();

    // Create the private repo. Tolerate "already exists" — the org.json check above
    // already confirmed it is uninitialized, so it is safe to write org.json.
    const createRes = this.#exec(["repo", "create", repo, "--private"]);
    if (createRes.status !== 0) {
      const combined = `${createRes.stdout} ${createRes.stderr}`.toLowerCase();
      if (!combined.includes("already exists") && !combined.includes("name already exists")) {
        throw classifyGhError(createRes, `Could not create repository ${repo}`);
      }
      // Repo exists but has no org.json — proceed.
    }

    const meta: OrgMeta = {
      schemaVersion: 1,
      orgId: `org_${Date.now()}`,
      name,
      owner: login,
      createdAt: new Date().toISOString(),
    };

    const content = encodeBase64Content(JSON.stringify(meta, null, 2));
    const putRes = this.#exec([
      "api", "--method", "PUT",
      `repos/${repo}/contents/org.json`,
      "-f", `message=chore: initialize Fleet org registry`,
      "-f", `content=${content}`,
    ]);
    if (putRes.status !== 0) {
      throw classifyGhError(putRes, `Failed to write org.json to ${repo}`);
    }

    return meta;
  }

  /**
   * Join an existing org: read org.json from the given repo to verify access and
   * return the org metadata. The CALLER is responsible for persisting the local binding.
   *
   * Transitions local state: none → member (or owner if login === org.json.owner).
   */
  async bindOrg(repo: string): Promise<OrgMeta> {
    const res = this.#exec(["api", `repos/${repo}/contents/org.json`]);
    if (res.status !== 0) {
      throw classifyGhError(
        res,
        `Could not read org.json from ${repo}. Verify repo access and gh authentication.`,
      );
    }
    return this.#decodeOrgMeta(res.stdout, repo);
  }

  // ── Directory sync ─────────────────────────────────────────────────────────

  /**
   * Pull the full shared-agent directory.
   *
   * Algorithm:
   * 1. List agents/ — if 404, return [] (no agents shared yet, not an error).
   * 2. For each .json file whose name matches the safe allowlist, fetch and decode.
   * 3. Skip entries with unknown schemaVersion (forward compat) with console.warn.
   * 4. Skip entries that fail to parse (corrupt file) with console.warn.
   *
   * Throws OrgError on auth/network failures. Partial results are acceptable.
   */
  async pullDirectory(): Promise<SharedAgentEntry[]> {
    const listRes = this.#exec(["api", `repos/${this.#repo}/contents/agents`]);

    if (listRes.status !== 0) {
      const combined = `${listRes.stdout} ${listRes.stderr}`.toLowerCase();
      // agents/ not found = no agents shared yet → return empty (not an error).
      if (
        combined.includes("not found") ||
        combined.includes('"status":"404"') ||
        combined.includes("http 404")
      ) {
        return [];
      }
      throw classifyGhError(listRes, `Failed to list agents directory in ${this.#repo}`);
    }

    let entries: Array<{ name: string; sha: string; type: string }>;
    try {
      const parsed = JSON.parse(listRes.stdout) as unknown;
      // Empty directory returns [] — treat as valid.
      entries = Array.isArray(parsed) ? (parsed as Array<{ name: string; sha: string; type: string }>) : [];
    } catch {
      throw new OrgError(
        "conflict",
        `agents/ directory listing from ${this.#repo} returned invalid JSON.`,
      );
    }

    const jsonFiles = entries.filter((e) => {
      if (e.type !== "file") return false;
      if (!SAFE_AGENT_NAME_RE.test(e.name)) {
        console.warn(`[GitHubRegistry] pullDirectory: skipping entry "${e.name}" — name does not match safe allowlist.`);
        return false;
      }
      return true;
    });
    const results: SharedAgentEntry[] = [];

    for (const file of jsonFiles) {
      const fileRes = this.#exec(["api", `repos/${this.#repo}/contents/agents/${file.name}`]);
      if (fileRes.status !== 0) {
        console.warn(`[GitHubRegistry] pullDirectory: failed to fetch ${file.name} — skipping.`);
        continue;
      }

      try {
        const fileInfo = JSON.parse(fileRes.stdout) as { content: string; sha: string };
        const json = decodeBase64Content(fileInfo.content);
        const entry = JSON.parse(json) as SharedAgentEntry;

        if (!isValidSchemaVersion(entry.schemaVersion)) {
          console.warn(
            `[GitHubRegistry] pullDirectory: skipping ${file.name} — unsupported schemaVersion ${entry.schemaVersion}.`,
          );
          continue;
        }

        results.push(entry);
      } catch (err) {
        console.warn(`[GitHubRegistry] pullDirectory: failed to parse ${file.name} — skipping. Error: ${err}`);
      }
    }

    return results;
  }

  // ── Agent share/unshare ────────────────────────────────────────────────────

  /**
   * Write agents/<entry.id>.json to the registry repo.
   *
   * Fetches the current sha first (if the file exists) to enable safe last-write-wins
   * (GitHub Contents API requires sha for updates). On a fresh create, no sha is sent.
   *
   * Entry MUST NOT contain secrets (rule #8, ORG-14).
   */
  async shareAgent(entry: SharedAgentEntry): Promise<void> {
    validatePathSegment(entry.id, "agent id");
    const path = `agents/${entry.id}.json`;
    const content = encodeBase64Content(JSON.stringify(entry, null, 2));

    const args: string[] = [
      "api", "--method", "PUT",
      `repos/${this.#repo}/contents/${path}`,
      "-f", `message=feat: share agent ${entry.id}`,
      "-f", `content=${content}`,
    ];

    // Fetch existing sha for safe upsert — required by the Contents API for updates.
    const existingRes = this.#exec(["api", `repos/${this.#repo}/contents/${path}`]);
    if (existingRes.status === 0) {
      try {
        const fileInfo = JSON.parse(existingRes.stdout) as { sha: string };
        if (fileInfo.sha) {
          args.push("-f", `sha=${fileInfo.sha}`);
        }
      } catch {
        // gh returned malformed output for an existing file; the PUT below will fail with 422 and surface as OrgError.
      }
    }

    const putRes = this.#exec(args);
    if (putRes.status !== 0) {
      throw classifyGhError(putRes, `Failed to share agent ${entry.id} in ${this.#repo}`);
    }
  }

  /**
   * Delete agents/<agentId>.json from the registry repo.
   *
   * Fetches the current sha first — the GitHub Contents API DELETE endpoint
   * requires the file sha in the request body.
   */
  async unshareAgent(agentId: string): Promise<void> {
    validatePathSegment(agentId, "agent id");
    const path = `agents/${agentId}.json`;

    const getRes = this.#exec(["api", `repos/${this.#repo}/contents/${path}`]);
    if (getRes.status !== 0) {
      throw classifyGhError(getRes, `Agent ${agentId} not found in ${this.#repo}`);
    }

    let sha: string;
    try {
      const fileInfo = JSON.parse(getRes.stdout) as { sha: string };
      sha = fileInfo.sha;
    } catch {
      throw new OrgError(
        "conflict",
        `Could not parse sha for agent ${agentId} in ${this.#repo}.`,
      );
    }

    const deleteRes = this.#exec([
      "api", "--method", "DELETE",
      `repos/${this.#repo}/contents/${path}`,
      "-f", `message=chore: unshare agent ${agentId}`,
      "-f", `sha=${sha}`,
    ]);
    if (deleteRes.status !== 0) {
      throw classifyGhError(deleteRes, `Failed to delete agent ${agentId} from ${this.#repo}`);
    }
  }

  // ── Members ────────────────────────────────────────────────────────────────

  /**
   * List live collaborators from the GitHub repo via the Collaborators API.
   *
   * Maps GitHub `role_name` to OrgRole:
   *   "admin"  → "owner"  (the repo owner / admin)
   *   anything → "member"
   *
   * Note: requires push access to the repo (GitHub API constraint).
   * ADR-4: no members.json — authoritative membership is always live collaborators.
   */
  async listMembers(): Promise<OrgMember[]> {
    const res = this.#exec(["api", `repos/${this.#repo}/collaborators`, "-F", "per_page=100", "--paginate"]);
    if (res.status !== 0) {
      throw classifyGhError(res, `Failed to list collaborators for ${this.#repo}`);
    }

    let collaborators: Array<{ login: string; role_name: string }>;
    try {
      collaborators = JSON.parse(res.stdout) as Array<{ login: string; role_name: string }>;
    } catch {
      throw new OrgError(
        "conflict",
        `Collaborators response from ${this.#repo} is not valid JSON.`,
      );
    }

    return collaborators.map((c) => ({
      login: c.login,
      role: c.role_name === "admin" ? "owner" : "member",
    }));
  }

  // ── Meta ───────────────────────────────────────────────────────────────────

  /**
   * Read org.json from the registry repo without side effects.
   * Used by sync loops that need the current remote state.
   */
  async getOrgMeta(): Promise<OrgMeta> {
    const res = this.#exec(["api", `repos/${this.#repo}/contents/org.json`]);
    if (res.status !== 0) {
      throw classifyGhError(res, `Could not read org.json from ${this.#repo}`);
    }
    return this.#decodeOrgMeta(res.stdout, this.#repo);
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  /**
   * Add a collaborator via the GitHub API.
   * Optional: omit this method when the GitHub token lacks admin scope.
   * When absent, the Core instructs the user to invite via GitHub directly.
   */
  async inviteMember(login: string): Promise<void> {
    validatePathSegment(login, "login");
    const res = this.#exec([
      "api", "--method", "PUT",
      `repos/${this.#repo}/collaborators/${login}`,
      "-f", "permission=push",
    ]);
    if (res.status !== 0) {
      throw classifyGhError(res, `Failed to invite ${login} to ${this.#repo}`);
    }
  }
}
