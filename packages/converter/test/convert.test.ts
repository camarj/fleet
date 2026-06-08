/**
 * Converter smoke test — converts a fixture Claude Code project and asserts the
 * emitted Flue project: report contents, generated agent code, skill copy,
 * deterministic output, and the provider/model swap (the central feature).
 *
 * No network, no LLM. Run: pnpm --filter @inteliside/gateway-converter test
 */

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
  assert(
    r.unmapped.some((u) => u.includes("filesystem") && u.includes("stdio")),
    "stdio MCP filesystem reported as unmapped",
  );
  assert(r.unmapped.some((u) => u.toLowerCase().includes("hooks")), "hooks reported as unmapped");
  assert(r.unmapped.some((u) => u.toLowerCase().includes("permissions")), "permissions reported as unmapped");

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
  assert(/import \w+ from "\.\.\/skills\/refund-policy\/SKILL\.md" with \{ type: "skill" \}/.test(agent), "skill imported with import attribute");
  assert(agent.includes("subagents: ["), "subagents wired into config");
  assert(agent.includes(".tools]"), "MCP tools spread into config");

  // skill files copied verbatim
  const skill = fileContent(out, "src/skills/refund-policy/SKILL.md");
  assert(skill.includes("Refund policy"), "skill SKILL.md copied verbatim");

  // scaffold present
  for (const f of ["flue.config.ts", "package.json", "Dockerfile", ".env.example", "README.md", "wrangler.jsonc", ".github/workflows/deploy.yml"]) {
    assert(out.files.some((x) => x.path === f), `scaffold file ${f} emitted`);
  }
  assert(fileContent(out, ".env.example").includes("ANTHROPIC_API_KEY="), ".env.example has the provider key var");

  // package.json carries the Cloudflare peer dep + build/deploy scripts
  const pkg = JSON.parse(fileContent(out, "package.json"));
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
    swapped.report.unmapped.some((u) => u.toLowerCase().includes("subagent model")),
    "swap reports dropped subagent model overrides",
  );

  // ── unknown provider rejected ──
  let threw = false;
  try {
    convert(FIXTURE, { provider: "google" });
  } catch (e) {
    threw = e instanceof ConvertError;
  }
  assert(threw, "unknown provider (google) → ConvertError");

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
}

main();
