/**
 * Emitter — turn a `ClaudeProject` + `ConvertOptions` into a deterministic,
 * deployable Flue project (a sorted set of files). No LLM, no IO; same input +
 * same options ⇒ byte-identical output.
 *
 * The generated agent module always exports `route` + `websocket` middleware —
 * without them a built Flue agent is not routable (WS0 finding). MCP servers are
 * wired only when HTTP (Flue's connectMcpServer is HTTP-only); stdio servers are
 * reported as unmapped.
 */

import { resolveModel } from "./providers.js";
import type { ClaudeProject, ConvertOptions, FlueFile, FlueProject } from "./types.js";

const FLUE_VERSION = "0.10.1";
// Cloudflare Agents SDK — a PEER dependency of `flue build --target cloudflare`
// (the generated Worker entry does `import { Agent, getAgentByName } from "agents"`).
// Without it the Cloudflare build fails to resolve "agents". Harmless on the node
// target. Verified against @flue/cli 0.10.1.
const AGENTS_VERSION = "0.15.0";
// Cloudflare requires this minimum for SQLite-backed Durable Objects, nodejs_compat
// v2, and AsyncLocalStorage. A fixed constant (not "today") keeps output deterministic.
const CF_COMPAT_DATE = "2026-04-01";

export function emitFlueProject(project: ClaudeProject, opts: ConvertOptions = {}): FlueProject {
  const { specifier, provider } = resolveModel(project.sourceModel, opts);
  const swapped = !!opts.provider && opts.provider !== "anthropic";
  const unmapped = [...project.unmapped];

  const files: FlueFile[] = [];
  const httpMcp = project.mcpServers.filter((m): m is Extract<typeof m, { kind: "http" }> => m.kind === "http");

  // ── the agent module ──
  files.push({
    path: `src/agents/${project.name}.ts`,
    content: emitAgentModule(project, specifier, swapped, httpMcp, unmapped),
  });

  // ── skills (copied verbatim under src/skills/<name>/) ──
  for (const skill of project.skills) {
    for (const file of skill.files) {
      files.push({ path: `src/skills/${skill.name}/${file.relPath}`, content: file.content });
    }
  }

  // ── project scaffold ──
  files.push({ path: "flue.config.ts", content: FLUE_CONFIG });
  files.push({ path: "package.json", content: emitPackageJson() });
  files.push({ path: "Dockerfile", content: DOCKERFILE });
  files.push({ path: "wrangler.jsonc", content: emitWrangler(project.name) });
  files.push({ path: ".github/workflows/deploy.yml", content: DEPLOY_WORKFLOW });
  files.push({ path: ".env.example", content: emitEnvExample(provider.apiKeyEnv, httpMcp) });
  files.push({ path: ".gitignore", content: "dist/\ndata/\nnode_modules/\n.env\n" });
  files.push({
    path: "README.md",
    content: emitReadme(project, specifier, provider.apiKeyEnv, httpMcp, unmapped),
  });

  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    files,
    report: {
      agentName: project.name,
      modelSpecifier: specifier,
      apiKeyEnv: provider.apiKeyEnv,
      subagents: project.subagents.map((s) => s.name),
      skills: project.skills.map((s) => s.name),
      mcpHttp: httpMcp.map((m) => m.name),
      unmapped,
    },
  };
}

// ── agent module codegen ──────────────────────────────────────────────────────

function emitAgentModule(
  project: ClaudeProject,
  specifier: string,
  swapped: boolean,
  httpMcp: Array<{ name: string; url: string; headers?: Record<string, string>; transport?: string }>,
  unmapped: string[],
): string {
  const used = new Set<string>();
  const imports = new Set<string>(["createAgent"]);
  const typeImports = new Set<string>(["AgentRouteHandler", "AgentWebSocketHandler"]);

  // subagent profiles
  const profileIdents: string[] = [];
  const profileBlocks: string[] = [];
  let droppedSubagentModel = false;
  for (const sub of project.subagents) {
    imports.add("defineAgentProfile");
    const id = uniqueIdent(sub.name + "Profile", used);
    profileIdents.push(id);
    const lines = [`const ${id} = defineAgentProfile({`, `  name: ${q(sub.name)},`];
    if (sub.description) lines.push(`  description: ${q(sub.description)},`);
    lines.push(`  instructions: ${tpl(sub.instructions)},`);
    if (sub.model && !swapped) {
      lines.push(`  model: ${q(`anthropic/${bareModel(sub.model)}`)},`);
    } else if (sub.model && swapped) {
      droppedSubagentModel = true;
    }
    lines.push(`});`);
    profileBlocks.push(lines.join("\n"));
  }
  if (droppedSubagentModel) {
    unmapped.push("Subagent model overrides were dropped because the main provider was swapped; subagents inherit the main model.");
  }

  // skills
  const skillIdents: string[] = [];
  const skillImports: string[] = [];
  for (const skill of project.skills) {
    const id = uniqueIdent(skill.name + "Skill", used);
    skillIdents.push(id);
    skillImports.push(`import ${id} from "../skills/${skill.name}/SKILL.md" with { type: "skill" };`);
  }

  // MCP (http only) — top-level await
  const mcpIdents: string[] = [];
  const mcpBlocks: string[] = [];
  for (const mcp of httpMcp) {
    imports.add("connectMcpServer");
    const id = uniqueIdent(mcp.name + "Mcp", used);
    mcpIdents.push(id);
    const env = `${upperSnake(mcp.name)}_MCP_URL`;
    const opts: string[] = [`  url: process.env.${env} ?? ${q(mcp.url)},`];
    if (mcp.transport === "sse") opts.push(`  transport: "sse",`);
    if (mcp.headers && Object.keys(mcp.headers).length > 0) opts.push(`  headers: ${json(mcp.headers)},`);
    mcpBlocks.push(`const ${id} = await connectMcpServer(${q(mcp.name)}, {\n${opts.join("\n")}\n});`);
  }

  // createAgent config
  const cfg: string[] = [`  model: ${q(specifier)},`, `  instructions: ${tpl(project.instructions)},`];
  if (skillIdents.length) cfg.push(`  skills: [${skillIdents.join(", ")}],`);
  if (profileIdents.length) cfg.push(`  subagents: [${profileIdents.join(", ")}],`);
  if (mcpIdents.length) cfg.push(`  tools: [${mcpIdents.map((i) => `...${i}.tools`).join(", ")}],`);

  // assemble
  const out: string[] = [];
  out.push(`/**`);
  out.push(` * ${project.name} — generated from a Claude Code project by @inteliside/gateway-converter.`);
  out.push(` * Edit the source project and re-convert rather than editing this file by hand.`);
  out.push(` */`);
  out.push("");
  const typeList = [...typeImports].sort().map((t) => `type ${t}`);
  out.push(`import { ${[...imports].sort().join(", ")}, ${typeList.join(", ")} } from "@flue/runtime";`);
  if (skillImports.length) out.push(...skillImports);
  out.push("");
  if (profileBlocks.length) out.push(profileBlocks.join("\n\n"), "");
  if (mcpBlocks.length) out.push(mcpBlocks.join("\n\n"), "");
  out.push(`export default createAgent(() => ({`);
  out.push(...cfg);
  out.push(`}));`);
  out.push("");
  out.push(`// Required for the agent to be reachable over HTTP/WebSocket (Fleet connects here).`);
  out.push(`export const route: AgentRouteHandler = async (_c, next) => {`);
  out.push(`  await next();`);
  out.push(`};`);
  out.push(`export const websocket: AgentWebSocketHandler = async (_c, next) => {`);
  out.push(`  await next();`);
  out.push(`};`);
  out.push("");
  return out.join("\n");
}

// ── scaffold files ────────────────────────────────────────────────────────────

const FLUE_CONFIG = `import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
});
`;

// A CONSTANT package.json name (not the agent name) so the manifest is
// byte-identical across every converted agent. That lets Docker's layer cache
// SHARE the heavy `npm install` layer across all agents — it is built once and
// reused, instead of re-running per agent. The agent's identity comes from the
// src/agents/<name>.ts filename, not this field.
function emitPackageJson(): string {
  return (
    JSON.stringify(
      {
        name: "flue-agent",
        version: "0.1.0",
        private: true,
        type: "module",
        engines: { node: ">=22.18" },
        scripts: {
          dev: "flue dev --target node",
          build: "flue build --target node",
          start: "node dist/server.mjs",
          "build:cloudflare": "flue build --target cloudflare",
          "deploy:cloudflare": "wrangler deploy",
        },
        dependencies: {
          "@flue/runtime": FLUE_VERSION,
          agents: AGENTS_VERSION,
        },
        devDependencies: {
          "@flue/cli": FLUE_VERSION,
        },
      },
      null,
      2,
    ) + "\n"
  );
}

const DOCKERFILE = `# Deployable Flue agent (Node target). Built by @inteliside/gateway-converter.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npx flue build --target node
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.mjs"]
`;

/**
 * Cloudflare Workers config for `flue build --target cloudflare`.
 *
 * Flue's build MERGES this file with auto-generated `durable_objects.bindings` (one
 * per agent + a `FlueRegistry`). It does NOT generate the matching `migrations`, so
 * we must — and the class names here must EXACTLY match Flue's derivation
 * (`agentClassName`/`FlueRegistry`) or the build fails. Names + compat-date verified
 * against @flue/cli 0.10.1.
 */
function emitWrangler(name: string): string {
  const body = JSON.stringify(
    {
      $schema: "https://workers.cloudflare.com/schema/wrangler.json",
      name: cfWorkerName(name),
      main: "dist/cloudflare.js",
      compatibility_date: CF_COMPAT_DATE,
      compatibility_flags: ["nodejs_compat"],
      migrations: [{ tag: "v1", new_sqlite_classes: [agentClassName(name), "FlueRegistry"] }],
    },
    null,
    2,
  );
  return (
    `// Cloudflare Workers config. Flue merges in durable_objects bindings at build time;\n` +
    `// keep migrations.new_sqlite_classes in sync with the agent name (Flue derives the class names).\n` +
    body +
    "\n"
  );
}

/**
 * CI deploy workflow: build the Docker image and push it to GHCR on every push to
 * the default branch. Self-contained (no agent-name interpolation) so it is
 * byte-identical across converted agents. The image lands at
 * `ghcr.io/<owner>/<repo>` — run it on any container host and connect Fleet by URL.
 */
const DEPLOY_WORKFLOW = `# Build the agent image and publish it to GitHub Container Registry (GHCR).
# Generated by @inteliside/gateway-converter. Deploy the published image on any
# container host (Fly, Cloud Run, a VM…) and connect Fleet to its URL.
name: deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/\${{ github.repository }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: \${{ steps.meta.outputs.tags }}
          labels: \${{ steps.meta.outputs.labels }}
`;

function emitEnvExample(apiKeyEnv: string, httpMcp: Array<{ name: string; url: string }>): string {
  const lines = [`# Model provider key (the agent reads this at runtime).`, `${apiKeyEnv}=`];
  for (const mcp of httpMcp) {
    lines.push("", `# Optional override for the "${mcp.name}" MCP server URL.`, `${upperSnake(mcp.name)}_MCP_URL=`);
  }
  return lines.join("\n") + "\n";
}

function emitReadme(
  project: ClaudeProject,
  specifier: string,
  apiKeyEnv: string,
  httpMcp: Array<{ name: string }>,
  unmapped: string[],
): string {
  const lines: string[] = [];
  lines.push(`# ${project.name}`, "");
  lines.push(`Deployable **Flue** agent generated from a Claude Code project by`, `\`@inteliside/gateway-converter\`. Re-convert the source rather than editing here.`, "");
  lines.push(`## Model`, "");
  lines.push(`- Specifier: \`${specifier}\``);
  lines.push(`- Set \`${apiKeyEnv}\` in the environment (see \`.env.example\`).`, "");
  lines.push(`## Run`, "", "```bash", "npm install", `export ${apiKeyEnv}=...`, "npm run dev      # local dev server", "npm run build && npm start   # production (node dist/server.mjs)", "```", "");
  lines.push(`## Deploy`, "");
  lines.push("- **Docker**: `docker build -t " + project.name + " . && docker run -p 8080:8080 -e " + apiKeyEnv + "=... " + project.name + "`");
  lines.push("- **GitHub / cloud**: push this repo — `.github/workflows/deploy.yml` builds the image and publishes it to `ghcr.io/<owner>/<repo>`. Run that image on any container host and connect Fleet to its URL.");
  lines.push(
    "- **Cloudflare**: `npm run build:cloudflare && npx wrangler secret put " +
      apiKeyEnv +
      " && npm run deploy:cloudflare` (needs `CLOUDFLARE_API_TOKEN`). `wrangler.jsonc` is ready — Flue fills the Durable Object bindings at build time.",
    "",
  );
  lines.push(`## What this agent has`, "");
  lines.push(`- ${project.subagents.length} subagent(s), ${project.skills.length} skill(s), ${httpMcp.length} HTTP MCP server(s).`);
  if (unmapped.length) {
    lines.push("", `## Not mapped`, "");
    for (const u of unmapped) lines.push(`- ${u}`);
  }
  return lines.join("\n") + "\n";
}

// ── string helpers (deterministic) ────────────────────────────────────────────

/** JSON string literal. */
function q(s: string): string {
  return JSON.stringify(s);
}

/** Pretty JSON for an object literal embedded in TS. */
function json(v: unknown): string {
  return JSON.stringify(v, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : "  " + line))
    .join("\n");
}

/** Multi-line value as an escaped template literal. */
function tpl(s: string): string {
  return "`" + s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
}

function bareModel(model: string): string {
  const i = model.indexOf("/");
  return i === -1 ? model : model.slice(i + 1);
}

// ── Cloudflare Durable Object naming (must match @flue/cli 0.10.1 EXACTLY) ─────
// Copied verbatim from the Flue CLI's Cloudflare codegen. If these drift from
// Flue's derivation, the emitted wrangler `migrations` won't match the bindings
// Flue auto-generates and `flue build --target cloudflare` fails.

/** Durable Object class name for an agent, e.g. "claude-project" → "FlueClaudeProjectAgent". */
function agentClassName(name: string): string {
  return `Flue${pascalCaseName(name)}Agent`;
}

function pascalCaseName(name: string): string {
  return name
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** A Cloudflare-valid Worker name: lowercase, alphanumeric and dashes only. */
function cfWorkerName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "flue-agent";
}

function upperSnake(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function uniqueIdent(name: string, taken: Set<string>): string {
  let base = name.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""));
  if (!/^[a-zA-Z_]/.test(base)) base = "_" + base;
  if (!base) base = "_x";
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}${n++}`;
  taken.add(id);
  return id;
}
