/**
 * Intermediate representation for the Claude Code → Flue converter.
 *
 * The reader (`read.ts`) parses a Claude Code project into a `ClaudeProject`.
 * The emitter (`emit.ts`) turns that — plus `ConvertOptions` (the choosable
 * provider/model) — into a deterministic `FlueProject` (a set of files).
 */

/** A Claude Code project parsed into a neutral, engine-agnostic shape. */
export interface ClaudeProject {
  /** Agent name — the project directory's basename, slugified. */
  name: string;
  /** CLAUDE.md content → the main agent's instructions. */
  instructions: string;
  /** Model from `.claude/settings.json` (Claude Code id/alias), if any. */
  sourceModel?: string;
  /** `.claude/agents/*.md` → reusable subagent profiles. */
  subagents: ClaudeSubagent[];
  /** `.claude/skills/<name>/` → skills (SKILL.md + sibling files). */
  skills: ClaudeSkill[];
  /** MCP servers from `.mcp.json` / settings — only HTTP ones map to Flue. */
  mcpServers: McpServerSpec[];
  /** `env` block from settings(.local).json — surfaced into the emitted `.env.example`. */
  env: Record<string, string>;
  /** Structured notes about anything that did NOT map (see emit report). */
  unmapped: UnmappedItem[];
}

/** One feature that did not convert to Flue, surfaced to the user. */
export interface UnmappedItem {
  /** Category, e.g. "mcp-stdio" | "hooks" | "permissions" | "subagent-model". */
  kind: string;
  /** The specific thing — an MCP server name, or the settings key. */
  name: string;
  /** Why it didn't map and, where useful, what to do about it. */
  reason: string;
}

export interface ClaudeSubagent {
  name: string;
  description: string;
  /** The markdown body — becomes the profile's instructions. */
  instructions: string;
  /** Optional model override declared in the subagent's frontmatter. */
  model?: string;
}

export interface ClaudeSkill {
  /** Skill directory name. */
  name: string;
  /** Every file under the skill dir, path relative to the skill dir. */
  files: SkillFile[];
}

export interface SkillFile {
  relPath: string;
  content: string;
}

/** An MCP server. Only `http` servers map to Flue's `connectMcpServer` (HTTP-only). */
export type McpServerSpec =
  | {
      name: string;
      kind: "http";
      url: string;
      headers?: Record<string, string>;
      transport?: "streamable-http" | "sse";
    }
  | {
      name: string;
      kind: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

/** The choosable provider/model — the converter's central feature. */
export interface ConvertOptions {
  /** Target provider id (e.g. "anthropic", "openai", "openrouter", "cloudflare"). */
  provider?: string;
  /** Target model id under that provider. */
  model?: string;
  /**
   * Deploy target the emitted project is destined for. Node targets (the
   * default) get `sandbox: local()` — real shell + filesystem inside the
   * container. "cloudflare" omits it: Workers have no subprocesses or fs,
   * and the `@flue/runtime/node` import would break `flue build --target
   * cloudflare`. Verified against @flue/runtime 0.10.1.
   */
  target?: "node" | "cloudflare";
  /**
   * Shared memory via Engram cloud (J4). When `enabled` AND the target is a Node
   * target, the converter brings the pinned `engram` binary into the image,
   * bridges `engram mcp --tools=agent` as an in-container sidecar, and emits a
   * tolerant cloud-setup phase in `start.mjs`. Disabled by default → output is
   * byte-identical to today. On Cloudflare it is reported as `unmapped` (Workers
   * cannot spawn subprocesses — no `engram mcp`). Secrets travel by NAME only.
   */
  sharedMemory?: {
    /** Turn on the Engram shared-memory wiring. Default: disabled. */
    enabled?: boolean;
    /**
     * Deterministic Engram project key the agent enrolls into (scoping, MEM-11).
     * Defaults to the agent slug. The deployer MAY pass an org-scoped key (DA-06).
     */
    projectKey?: string;
  };
}

/** The emitted, deployable Flue project — a deterministic set of files. */
export interface FlueProject {
  /** Output files, each path relative to the output root. Sorted by path. */
  files: FlueFile[];
  report: ConvertReport;
}

export interface FlueFile {
  path: string;
  content: string;
}

export interface ConvertReport {
  agentName: string;
  /** Final Flue model specifier, e.g. "anthropic/claude-sonnet-4-6". */
  modelSpecifier: string;
  /** Env var the chosen provider reads its key from. */
  apiKeyEnv: string;
  subagents: string[];
  skills: string[];
  /** HTTP MCP servers that were wired. */
  mcpHttp: string[];
  /** Stdio MCP servers wired in-container via the supergateway bridge (node targets). */
  mcpStdioBridged: string[];
  /** Things that did not map (stdio MCP, hooks, permissions, …). */
  unmapped: UnmappedItem[];
}
