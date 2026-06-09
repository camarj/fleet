/**
 * Reader — parse a Claude Code project directory into the neutral `ClaudeProject`
 * IR. Pure filesystem reads, deterministic (everything is sorted by name).
 *
 * Source layout it understands:
 *   CLAUDE.md                      → instructions
 *   .claude/agents/<name>.md       → subagent profiles (yaml frontmatter + body)
 *   .claude/skills/<name>/**       → skills (SKILL.md + sibling files)
 *   .mcp.json / .claude/settings.json mcpServers → MCP servers
 *   .claude/settings.json model    → source model
 *   .claude/settings.json hooks/permissions → recorded as unmapped
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ConvertError } from "./providers.js";
import type { ClaudeProject, ClaudeSkill, ClaudeSubagent, McpServerSpec, SkillFile } from "./types.js";

export function readClaudeProject(dir: string): ClaudeProject {
  const claudeMd = join(dir, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    throw new ConvertError(`No CLAUDE.md found in "${dir}". A Claude Code project must have one.`);
  }
  const instructions = readFileSync(claudeMd, "utf8").trim();

  const settings = readSettings(dir);
  const unmapped: string[] = [];

  const subagents = readSubagents(join(dir, ".claude", "agents"));
  const skills = readSkills(join(dir, ".claude", "skills"));
  const mcpServers = readMcpServers(dir, settings);

  for (const s of mcpServers) {
    if (s.kind === "stdio") {
      unmapped.push(
        `MCP server "${s.name}" is stdio (command: ${s.command}) — Flue's connectMcpServer is HTTP-only, so it was NOT wired. Expose it over HTTP/SSE to use it.`,
      );
    }
  }
  if (settings && typeof settings === "object") {
    if ("hooks" in settings) unmapped.push("Claude Code hooks have no Flue equivalent and were not mapped.");
    if ("permissions" in settings) unmapped.push("Claude Code permissions have no Flue equivalent and were not mapped.");
  }

  return {
    name: slugify(basename(dir)),
    instructions,
    sourceModel: typeof settings?.["model"] === "string" ? (settings["model"] as string) : undefined,
    subagents,
    skills,
    mcpServers,
    unmapped,
  };
}

function readSettings(dir: string): Record<string, unknown> | undefined {
  const path = join(dir, ".claude", "settings.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readSubagents(agentsDir: string): ClaudeSubagent[] {
  if (!existsSync(agentsDir)) return [];
  const out: ClaudeSubagent[] = [];
  for (const file of readdirSync(agentsDir).sort()) {
    if (!file.endsWith(".md")) continue;
    const { data, body } = parseFrontmatter(readFileSync(join(agentsDir, file), "utf8"));
    const name = slugify(typeof data["name"] === "string" ? (data["name"] as string) : file.replace(/\.md$/, ""));
    out.push({
      name,
      description: typeof data["description"] === "string" ? (data["description"] as string) : "",
      instructions: body.trim(),
      model: typeof data["model"] === "string" ? (data["model"] as string) : undefined,
    });
  }
  return out;
}

function readSkills(skillsDir: string): ClaudeSkill[] {
  if (!existsSync(skillsDir)) return [];
  const out: ClaudeSkill[] = [];
  for (const entry of readdirSync(skillsDir).sort()) {
    const skillPath = join(skillsDir, entry);
    if (!statSync(skillPath).isDirectory()) continue;
    const files: SkillFile[] = walkFiles(skillPath)
      .map((abs) => {
        const relPath = relative(skillPath, abs);
        const content = readFileSync(abs, "utf8");
        // Flue requires SKILL.md frontmatter to be a flat string→string map;
        // Claude Code skills often carry numbers/arrays/nested maps (version: 1.0,
        // allowed-tools: [...], metadata: {...}). Normalize so the Flue build passes.
        return { relPath, content: relPath === "SKILL.md" ? normalizeSkillFrontmatter(content) : content };
      })
      .sort((a, b) => a.relPath.localeCompare(b.relPath));
    if (files.some((f) => f.relPath === "SKILL.md")) out.push({ name: slugify(entry), files });
  }
  return out;
}

function readMcpServers(dir: string, settings: Record<string, unknown> | undefined): McpServerSpec[] {
  const raw: Record<string, unknown> = {};
  const dotMcp = join(dir, ".mcp.json");
  if (existsSync(dotMcp)) {
    try {
      const parsed = JSON.parse(readFileSync(dotMcp, "utf8")) as { mcpServers?: Record<string, unknown> };
      Object.assign(raw, parsed.mcpServers ?? {});
    } catch {
      /* ignore malformed */
    }
  }
  if (settings && typeof settings["mcpServers"] === "object" && settings["mcpServers"]) {
    Object.assign(raw, settings["mcpServers"] as Record<string, unknown>);
  }

  const out: McpServerSpec[] = [];
  for (const name of Object.keys(raw).sort()) {
    const cfg = raw[name] as Record<string, unknown>;
    const url = typeof cfg["url"] === "string" ? (cfg["url"] as string) : undefined;
    if (url) {
      out.push({
        name,
        kind: "http",
        url,
        headers: isStringRecord(cfg["headers"]) ? (cfg["headers"] as Record<string, string>) : undefined,
        transport: cfg["type"] === "sse" ? "sse" : "streamable-http",
      });
    } else if (typeof cfg["command"] === "string") {
      out.push({
        name,
        kind: "stdio",
        command: cfg["command"] as string,
        args: Array.isArray(cfg["args"]) ? (cfg["args"] as string[]) : undefined,
        env: isStringRecord(cfg["env"]) ? (cfg["env"] as Record<string, string>) : undefined,
      });
    }
  }
  return out;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Rewrite a SKILL.md's frontmatter to satisfy Flue's skill parser:
 *  - `metadata` must be an OBJECT whose values are all strings (Claude Code often
 *    nests numbers/booleans here, e.g. `version: 1.0`),
 *  - `allowed-tools` must be a single space-separated STRING (not a YAML array),
 *  - other scalar values are coerced to strings; remaining non-scalars are
 *    JSON-stringified (Flue ignores unknown keys anyway).
 * Files with no frontmatter are returned unchanged.
 */
export function normalizeSkillFrontmatter(content: string): string {
  const { data, body } = parseFrontmatter(content);
  const keys = Object.keys(data);
  if (keys.length === 0) return content; // nothing to normalize

  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const v = data[key];
    if (v === null || v === undefined) continue;

    if (key === "metadata") {
      out.metadata = isStringRecord(v) || (typeof v === "object" && !Array.isArray(v))
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([, val]) => val !== null && val !== undefined)
              .map(([k, val]) => [k, scalarToString(val)]),
          )
        : { value: scalarToString(v) };
    } else if (key === "allowed-tools" || key === "allowed_tools") {
      out[key] = Array.isArray(v) ? v.map((t) => scalarToString(t)).join(" ") : scalarToString(v);
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[key] = scalarToString(v);
    } else {
      out[key] = JSON.stringify(v);
    }
  }
  // Force double-quoting on every string value: an unquoted "2026-03-10" or "1.0"
  // would round-trip back to a Date/number when Flue re-parses the YAML, which it
  // rejects. Quoting keeps them strings. lineWidth:0 avoids folding long values.
  const yaml = stringifyYaml(out, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN", lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body ? `\n${body}` : ""}`;
}

/** Stringify a value for skill frontmatter (YAML can parse dates/numbers, which Flue rejects). */
function scalarToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) {
    // Date-only (midnight UTC) → "YYYY-MM-DD"; otherwise full ISO timestamp.
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  return JSON.stringify(v);
}

export function parseFrontmatter(md: string): { data: Record<string, unknown>; body: string } {
  if (md.startsWith("---")) {
    const end = md.indexOf("\n---", 3);
    if (end !== -1) {
      const yamlText = md.slice(3, end).replace(/^\r?\n/, "");
      const body = md.slice(end + 4).replace(/^\r?\n/, "");
      const data = (parseYaml(yamlText) ?? {}) as Record<string, unknown>;
      return { data, body };
    }
  }
  return { data: {}, body: md };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walkFiles(abs));
    else out.push(abs);
  }
  return out;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** kebab/space → safe lower-case slug used for names and identifiers. */
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}
