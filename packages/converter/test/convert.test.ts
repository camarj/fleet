/**
 * Converter smoke test — converts a fixture Claude Code project and asserts the
 * emitted Flue project: report contents, generated agent code, skill copy,
 * deterministic output, and the provider/model swap (the central feature).
 *
 * No network, no LLM. Run: pnpm --filter @inteliside/gateway-converter test
 */

import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convert, ConvertError, type FlueProject } from "../src/index.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(DIR, "fixtures", "claude-project");

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

function fileContent(p: FlueProject, path: string): string {
  const f = p.files.find((x) => x.path === path);
  if (!f) throw new Error(`expected emitted file "${path}" — got: ${p.files.map((x) => x.path).join(", ")}`);
  return f.content;
}

function main(): void {
  // ── default convert (keep source Anthropic model) ──
  const out = convert(FIXTURE);
  const r = out.report;

  assert(r.agentName === "claude-project", "agent name = slug of project dir");
  assert(r.modelSpecifier === "anthropic/claude-sonnet-4-6", "default model = source model under anthropic");
  assert(r.apiKeyEnv === "ANTHROPIC_API_KEY", "apiKeyEnv = ANTHROPIC_API_KEY");
  assert(r.subagents.includes("issue-classifier"), "subagent issue-classifier read");
  assert(r.skills.includes("refund-policy"), "skill refund-policy read");
  assert(r.mcpHttp.includes("inventory"), "http MCP inventory wired");
  // filesystem is now bridged in-container on node targets — NOT unmapped.
  assert(r.mcpStdioBridged.includes("filesystem"), "stdio MCP filesystem bridged in-container (node target)");
  assert(
    !r.unmapped.some((u) => u.kind === "mcp-stdio"),
    "no mcp-stdio unmapped items on node target (all bridgeable servers are bridged)",
  );
  assert(r.unmapped.some((u) => u.kind === "hooks"), "hooks reported as unmapped (structured)");
  assert(r.unmapped.some((u) => u.kind === "permissions"), "permissions reported as unmapped (structured)");
  assert(
    r.unmapped.every((u) => typeof u.kind === "string" && typeof u.name === "string" && typeof u.reason === "string"),
    "every unmapped item has kind/name/reason",
  );

  const agent = fileContent(out, "src/agents/claude-project.ts");
  assert(agent.includes("export default createAgent(() => ({"), "agent uses createAgent");
  assert(agent.includes("model: \"anthropic/claude-sonnet-4-6\""), "agent model specifier emitted");
  assert(agent.includes("export const route: AgentRouteHandler"), "agent exports route (required to be routable)");
  assert(agent.includes("export const websocket: AgentWebSocketHandler"), "agent exports websocket (required to be routable)");
  assert(agent.includes("defineAgentProfile({"), "subagent emitted as defineAgentProfile");
  assert(agent.includes('name: "issue-classifier"'), "subagent name emitted");
  assert(agent.includes('model: "anthropic/claude-haiku-4-5"'), "subagent model preserved (no provider swap)");
  assert(agent.includes('connectMcpServer("inventory"'), "http MCP wired via connectMcpServer");
  assert(agent.includes("INVENTORY_MCP_URL"), "MCP url overridable via env");
  // bridged stdio server
  assert(agent.includes('tryConnectMcpServer("filesystem"'), "bridged stdio MCP uses tryConnectMcpServer");
  assert(agent.includes("http://127.0.0.1:3100/mcp"), "bridged stdio MCP reaches the bridge at the expected localhost URL");
  assert(/import \w+ from "\.\.\/skills\/refund-policy\/SKILL\.md" with \{ type: "skill" \}/.test(agent), "skill imported with import attribute");
  assert(agent.includes("subagents: ["), "subagents wired into config");
  assert(agent.includes(".tools]"), "MCP tools spread into config");
  assert(agent.includes('import { local } from "@flue/runtime/node";'), "node target imports local() sandbox");
  assert(agent.includes("sandbox: local({ env: { ...process.env } }),"), "node target emits real sandbox");

  // skill body copied; frontmatter normalized to a flat string→string map (Flue requirement)
  const skill = fileContent(out, "src/skills/refund-policy/SKILL.md");
  assert(skill.includes("Refund policy"), "skill SKILL.md body preserved");
  {
    const fm = skill.slice(0, skill.indexOf("\n---", 3));
    // Flue contract: allowed-tools is a space-separated STRING; metadata is an
    // OBJECT whose values are all strings (numbers like version: 1.0 coerced).
    assert(/allowed-tools:\s*"?read grep"?/.test(fm), "allowed-tools flattened to a space-separated string");
    assert(/metadata:\s*\r?\n/.test(fm), "metadata stays a nested mapping (not a JSON string)");
    assert(/version:\s*["']1(\.0)?["']/.test(fm), "metadata.version coerced to a string");
    assert(/author:\s*"?store-team"?/.test(fm), "metadata string values preserved");
    assert(/updated:\s*["']?2026-03-10["']?/.test(fm) && !/updated:\s*2026-03-10T/.test(fm), "metadata YAML date coerced to a date string");
  }

  // scaffold present
  for (const f of ["flue.config.ts", "package.json", "Dockerfile", ".env.example", "README.md", "wrangler.jsonc", ".github/workflows/deploy.yml"]) {
    assert(out.files.some((x) => x.path === f), `scaffold file ${f} emitted`);
  }
  // start.mjs — emitted when bridges are present
  assert(out.files.some((x) => x.path === "start.mjs"), "start.mjs emitted when stdio bridges are present");
  const startMjs = fileContent(out, "start.mjs");
  assert(startMjs.includes("--outputTransport"), "start.mjs passes --outputTransport to supergateway");
  assert(startMjs.includes("streamableHttp"), "start.mjs uses streamableHttp transport");
  assert(startMjs.includes("npx -y @modelcontextprotocol/server-filesystem /data"), "start.mjs contains the joined stdio command");

  // package.json — supergateway dep and start script updated for bridged agents
  const pkg = JSON.parse(fileContent(out, "package.json"));
  assert(pkg.dependencies["supergateway"] === "3.4.3", "package.json includes supergateway 3.4.3 when bridges present");
  assert(pkg.scripts["start"] === "node start.mjs", "package.json start script uses start.mjs when bridges present");

  // Dockerfile — CMD updated for bridged agents
  const dockerfile = fileContent(out, "Dockerfile");
  assert(dockerfile.includes('CMD ["node", "start.mjs"]'), "Dockerfile CMD uses start.mjs when bridges present");

  const envExample = fileContent(out, ".env.example");
  assert(envExample.includes("ANTHROPIC_API_KEY="), ".env.example has the provider key var");
  // stdio server env vars (from fixture .mcp.json env block — names only, no values)
  assert(envExample.includes("FS_TOKEN="), ".env.example surfaces stdio MCP server env var FS_TOKEN");
  // settings.json env block → names surfaced into .env.example (WU-11)
  assert(envExample.includes("STORE_API_BASE="), ".env.example surfaces settings.json env var STORE_API_BASE");
  assert(envExample.includes("FEATURE_FLAG_X="), ".env.example surfaces settings.json env var FEATURE_FLAG_X");
  assert(!envExample.includes("https://api.example.com"), ".env.example carries env NAMES only, never the values (no secret leak)");

  // ── settings.local.json layering (read.ts:73 shallow-merge path) ──
  // settings.local.json is globally gitignored so it can never be committed as a fixture;
  // we create it at runtime and always delete it in the finally block.
  {
    const localSettingsPath = join(FIXTURE, ".claude", "settings.local.json");
    try {
      writeFileSync(localSettingsPath, JSON.stringify({ env: { LOCAL_ONLY_TOKEN: "placeholder" } }), "utf8");
      const withLocal = convert(FIXTURE);
      const localEnv = fileContent(withLocal, ".env.example");
      assert(localEnv.includes("LOCAL_ONLY_TOKEN="), ".env.example surfaces settings.local.json env var LOCAL_ONLY_TOKEN");
      // Shallow merge: local `env` REPLACES base `env` entirely (read.ts:73 `{ ...base, ...local }`),
      // so base-settings vars are absent when local overrides the env key — documents known behavior.
      assert(!localEnv.includes("STORE_API_BASE="), "shallow merge: base env var STORE_API_BASE absent when local overrides the env key");
    } finally {
      rmSync(localSettingsPath, { force: true });
    }
  }

  // package.json carries the Cloudflare peer dep + build/deploy scripts
  assert(typeof pkg.dependencies.agents === "string", "package.json includes the 'agents' CF peer dependency");
  assert(pkg.scripts["build:cloudflare"] === "flue build --target cloudflare", "package.json has build:cloudflare script");
  assert(pkg.scripts["deploy:cloudflare"] === "wrangler deploy", "package.json has deploy:cloudflare script");

  // ── Cloudflare wrangler config (real, not a stub) ──
  const wrangler = fileContent(out, "wrangler.jsonc");
  const wjson = JSON.parse(wrangler.replace(/^\/\/.*$/gm, "")); // strip jsonc comments
  assert(wjson.name === "claude-project", "wrangler name = CF-valid worker name");
  assert(wjson.compatibility_date >= "2026-04-01", "wrangler compatibility_date >= 2026-04-01 (SQLite DO)");
  assert(wjson.compatibility_flags.includes("nodejs_compat"), "wrangler enables nodejs_compat");
  const classes = wjson.migrations[0].new_sqlite_classes;
  assert(classes.includes("FlueClaudeProjectAgent"), "migrations declare the derived DO class name (matches Flue)");
  assert(classes.includes("FlueRegistry"), "migrations declare the FlueRegistry DO class");

  // ── GitHub Actions deploy workflow ──
  const wf = fileContent(out, ".github/workflows/deploy.yml");
  assert(wf.includes("ghcr.io/${{ github.repository }}"), "deploy workflow pushes the image to GHCR");
  assert(wf.includes("build-push-action"), "deploy workflow builds + pushes the Docker image");

  // ── determinism ──
  const a = JSON.stringify(convert(FIXTURE).files);
  const b = JSON.stringify(convert(FIXTURE).files);
  assert(a === b, "same input + options ⇒ byte-identical output");

  // ── provider/model swap (the central feature) ──
  const swapped = convert(FIXTURE, { provider: "openai", model: "gpt-5.5" });
  assert(swapped.report.modelSpecifier === "openai/gpt-5.5", "swap → openai/gpt-5.5");
  assert(swapped.report.apiKeyEnv === "OPENAI_API_KEY", "swap → OPENAI_API_KEY");
  const swappedAgent = fileContent(swapped, "src/agents/claude-project.ts");
  assert(swappedAgent.includes('model: "openai/gpt-5.5"'), "swapped main model emitted");
  assert(!swappedAgent.includes("anthropic/claude-haiku"), "subagent anthropic model dropped on swap");
  assert(
    swapped.report.unmapped.some((u) => u.kind === "subagent-model"),
    "swap reports dropped subagent model overrides",
  );

  // ── extended provider catalog (pi-ai) ──
  const gemini = convert(FIXTURE, { provider: "google", model: "gemini-2.5-pro" });
  assert(gemini.report.modelSpecifier === "google/gemini-2.5-pro", "google provider accepted (pi-ai catalog)");
  assert(gemini.report.apiKeyEnv === "GEMINI_API_KEY", "google → GEMINI_API_KEY env");
  const grok = convert(FIXTURE, { provider: "xai" });
  assert(grok.report.apiKeyEnv === "XAI_API_KEY", "xai → XAI_API_KEY env (default model applied)");

  // ── truly unknown provider rejected ──
  let threw = false;
  try {
    convert(FIXTURE, { provider: "totally-not-a-provider" });
  } catch (e) {
    threw = e instanceof ConvertError;
  }
  assert(threw, "unknown provider → ConvertError");

  // ── cloudflare target: the node sandbox must NOT be emitted ──
  const cfOut = convert(FIXTURE, { target: "cloudflare" });
  const cfAgent = fileContent(cfOut, "src/agents/claude-project.ts");
  assert(!cfAgent.includes("@flue/runtime/node"), "cloudflare target omits the node-only import");
  assert(!cfAgent.includes("sandbox:"), "cloudflare target omits the sandbox field");
  assert(cfAgent.includes("export default createAgent(() => ({"), "cloudflare agent still emits createAgent");
  // cloudflare: stdio bridge is unavailable (no subprocesses) → filesystem is unmapped, not bridged
  assert(
    cfOut.report.mcpStdioBridged.length === 0,
    "cloudflare target: mcpStdioBridged is empty (no in-container bridges on CF)",
  );
  assert(
    cfOut.report.unmapped.some((u) => u.kind === "mcp-stdio" && u.name === "filesystem"),
    "cloudflare target: filesystem stdio MCP reported as unmapped",
  );
  assert(
    cfOut.report.unmapped.some((u) => u.kind === "mcp-stdio" && u.reason.includes("Cloudflare")),
    "cloudflare target: unmapped reason mentions Cloudflare",
  );
  assert(
    !cfOut.files.some((x) => x.path === "start.mjs"),
    "cloudflare target: no start.mjs emitted",
  );
  const cfPkg = JSON.parse(fileContent(cfOut, "package.json"));
  assert(
    !("supergateway" in (cfPkg.dependencies ?? {})),
    "cloudflare target: no supergateway in package.json dependencies",
  );
  assert(cfPkg.scripts["start"] === "node dist/server.mjs", "cloudflare target: start script is node dist/server.mjs (no bridge)");
  const cfDockerfile = fileContent(cfOut, "Dockerfile");
  assert(cfDockerfile.includes('CMD ["node", "dist/server.mjs"]'), "cloudflare target: Dockerfile CMD is node dist/server.mjs");

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
}

main();
