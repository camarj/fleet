/**
 * Emitter — turn a `ClaudeProject` + `ConvertOptions` into a deterministic,
 * deployable Flue project (a sorted set of files). No LLM, no IO; same input +
 * same options ⇒ byte-identical output.
 *
 * The generated agent module always exports `route` + `websocket` middleware —
 * without them a built Flue agent is not routable (WS0 finding). MCP servers are
 * wired when HTTP (Flue's connectMcpServer is HTTP-only). For node targets, stdio
 * servers with safe arguments are bridged in-container via supergateway (verified
 * against supergateway 3.4.3); the rest are reported as unmapped.
 */

import { buildAgentCard } from "./agent-card.js";
import { resolveModel } from "./providers.js";
import type { ClaudeProject, ConvertOptions, FlueFile, FlueProject, McpServerSpec, UnmappedItem } from "./types.js";

const FLUE_VERSION = "0.10.1";
// Cloudflare Agents SDK — a PEER dependency of `flue build --target cloudflare`
// (the generated Worker entry does `import { Agent, getAgentByName } from "agents"`).
// Without it the Cloudflare build fails to resolve "agents". Harmless on the node
// target. Verified against @flue/cli 0.10.1.
const AGENTS_VERSION = "0.15.0";
// Cloudflare requires this minimum for SQLite-backed Durable Objects, nodejs_compat
// v2, and AsyncLocalStorage. A fixed constant (not "today") keeps output deterministic.
const CF_COMPAT_DATE = "2026-04-01";
// stdio→HTTP bridge: "Run MCP stdio servers over SSE, Streamable HTTP or vice versa".
// CLI: npx supergateway --stdio "<cmd>" --outputTransport streamableHttp --port <n>
// Verified against npm registry, supergateway 3.4.3, 2026-06-12.
const SUPERGATEWAY_VERSION = "3.4.3";
// First bridge port (inclusive). Each stdio MCP server gets the next integer in sorted name order.
const BRIDGE_BASE_PORT = 3100;

// ── Engram shared memory (J4) ─────────────────────────────────────────────────
// The official multi-arch image carries the `engram` Go binary at this path
// (verified live 2026-06-13, TASK-01: `command -v engram` → /usr/local/bin/engram).
// The tag is PINNED to the SAME tag the org server runs (DA-02 == DA-04) so client
// and server are bit-identical — the binary reports `engram dev` (not a semver), so
// the anti-skew guarantee (R1) is the exact tag, not a runtime version check. Bump
// this tag and the server's together.
const ENGRAM_IMAGE = "ghcr.io/gentleman-programming/engram:1.16.3";
const ENGRAM_BIN_PATH = "/usr/local/bin/engram";
// The stdio MCP server bridged into the agent: `engram mcp --tools=agent` (the
// agent memory profile, ~15 tools). Modeled as a normal stdio server so it rides
// the generic bridge machinery (sorting, port assignment, start.mjs BRIDGES) with
// no engram special-casing in emitStartMjs. command/args are quoting-safe.
//
// `--project <key>` is REQUIRED: without it, `engram mcp` detects the project from
// cwd (the container's /app → project "app"). The agent's memory tools would then
// write to "app", but the cloud setup enrolls (and the server allowlists) the
// shared `engramProjectKey`. The mismatch makes autosync block every mutation
// ("non_enrolled_pending_mutations") and the server reject the push (403 "project
// is not allowed") — so shared memory silently never shares. Pinning the MCP's
// default project to the enrolled key is what makes A's writes visible to B.
const engramMcpServer = (projectKey: string): Extract<McpServerSpec, { kind: "stdio" }> => ({
  name: "engram",
  kind: "stdio",
  command: "engram",
  args: ["mcp", "--tools=agent", "--project", projectKey],
});

/** A stdio MCP server that has been assigned an in-container bridge port. */
type BridgedStdioServer = Extract<McpServerSpec, { kind: "stdio" }> & { port: number };

export function emitFlueProject(project: ClaudeProject, opts: ConvertOptions = {}): FlueProject {
  const { specifier, provider } = resolveModel(project.sourceModel, opts);
  const swapped = !!opts.provider && opts.provider !== "anthropic";
  const unmapped: UnmappedItem[] = [...project.unmapped];
  // Real shell + filesystem for Node targets: without `sandbox: local()` the
  // agent runs Flue's in-memory just-bash emulator and CLAUDE.md instructions
  // that invoke git/npm/scripts silently can't execute. Cloudflare Workers
  // have no subprocesses, so the import is omitted there (it would break the
  // CF build). Verified against @flue/runtime 0.10.1.
  const nodeSandbox = opts.target !== "cloudflare";

  // Shared memory (J4) is gated by the opt-in flag AND a Node target. On Cloudflare
  // it is reported as unmapped (Workers have no subprocesses → no `engram mcp`).
  const sharedMemoryRequested = opts.sharedMemory?.enabled === true;
  const sharedMemoryEnabled = sharedMemoryRequested && nodeSandbox;
  // Deterministic Engram project key the agent enrolls into; defaults to the slug.
  const engramProjectKey = opts.sharedMemory?.projectKey?.trim() || project.name;

  const files: FlueFile[] = [];
  const httpMcp = project.mcpServers.filter((m): m is Extract<McpServerSpec, { kind: "http" }> => m.kind === "http");

  // Stdio MCP servers, sorted by name so port assignment is deterministic. When
  // shared memory is on (Node only), `engram mcp` joins the list as one more stdio
  // server and rides the same bridge machinery (sorted → deterministic ports).
  const stdioServers = project.mcpServers.filter((m): m is Extract<McpServerSpec, { kind: "stdio" }> => m.kind === "stdio");
  if (sharedMemoryEnabled) stdioServers.push(engramMcpServer(engramProjectKey));
  const stdioMcp = stdioServers.sort((a, b) => a.name.localeCompare(b.name));

  // Cloudflare + shared memory requested: honest `unmapped` (MEM-09). No binary,
  // no bridge, no autosync vars are emitted; the rest of the conversion is unchanged.
  if (sharedMemoryRequested && !nodeSandbox) {
    unmapped.push({
      kind: "shared-memory",
      name: "engram",
      reason:
        "Shared memory (Engram) needs to run `engram mcp` as a subprocess. Cloudflare Workers cannot spawn subprocesses, so shared memory is unavailable on this target — the agent uses no shared memory. The rest of the conversion is unaffected.",
    });
  }

  // A server is bridgeable when args contain no whitespace or quote chars (supergateway
  // receives the whole stdio command as one argv string — arg-level quoting bypasses the
  // shell, so an arg with embedded spaces or quotes would silently misparse). The command
  // itself may contain spaces (supergateway shells the --stdio value) but must not contain
  // quotes, which would break the surrounding shell quoting.
  type StdioServer = Extract<McpServerSpec, { kind: "stdio" }>;
  const isBridgeable = (m: StdioServer): boolean =>
    !/["']/.test(m.command) && (m.args ?? []).every((a: string) => !/[\s"']/.test(a));

  const bridged: BridgedStdioServer[] = [];
  for (const m of stdioMcp) {
    if (nodeSandbox) {
      if (isBridgeable(m)) {
        bridged.push({ ...m, port: BRIDGE_BASE_PORT + bridged.length });
      } else {
        unmapped.push({
          kind: "mcp-stdio",
          name: m.name,
          reason: `Flue's connectMcpServer is HTTP-only; supergateway cannot bridge this stdio server (command: ${m.command}) because its args contain quoting-unsafe characters. Expose it over HTTP/SSE manually to use it.`,
        });
      }
    } else {
      // Cloudflare Workers cannot spawn subprocesses, so the in-container bridge is
      // unavailable on this target. Report honestly so the operator can act.
      unmapped.push({
        kind: "mcp-stdio",
        name: m.name,
        reason: `Flue's connectMcpServer is HTTP-only, so this stdio server (command: ${m.command}) was NOT wired. Cloudflare Workers cannot run subprocesses, so the in-container bridge is unavailable on this target. Expose it over HTTP/SSE to use it.`,
      });
    }
  }

  // ── the agent module ──
  files.push({
    path: `src/agents/${project.name}.ts`,
    content: emitAgentModule(project, specifier, swapped, httpMcp, bridged, unmapped, nodeSandbox),
  });

  // ── skills (copied verbatim under src/skills/<name>/) ──
  for (const skill of project.skills) {
    for (const file of skill.files) {
      files.push({ path: `src/skills/${skill.name}/${file.relPath}`, content: file.content });
    }
  }

  // ── project scaffold ──
  files.push({ path: "flue.config.ts", content: FLUE_CONFIG });
  files.push({ path: "package.json", content: emitPackageJson(bridged.length > 0) });
  files.push({ path: "Dockerfile", content: emitDockerfile(bridged.length > 0, sharedMemoryEnabled) });
  files.push({ path: "wrangler.jsonc", content: emitWrangler(project.name) });
  files.push({ path: ".github/workflows/deploy.yml", content: DEPLOY_WORKFLOW });
  files.push({ path: ".env.example", content: emitEnvExample(provider.apiKeyEnv, httpMcp, stdioMcp, project.env, sharedMemoryEnabled) });
  files.push({ path: ".gitignore", content: "dist/\ndata/\nnode_modules/\n.env\n" });
  // ── A2A Agent Card (capability descriptor for the Baton Orchestrator, ADR-13) ──
  // Tools = wired MCP only (httpMcp + bridged); unmapped servers are not advertised.
  const agentCard = buildAgentCard(project, {
    modelSpecifier: specifier,
    httpMcp: httpMcp.map((m) => m.name),
    bridgedMcp: bridged.map((m) => m.name),
  });
  files.push({ path: "agent-card.json", content: `${JSON.stringify(agentCard, null, 2)}\n` });
  files.push({
    path: "README.md",
    content: emitReadme(project, specifier, provider.apiKeyEnv, httpMcp, bridged, unmapped, nodeSandbox),
  });

  // ── start.mjs (only when there are bridged stdio servers) ──
  // When shared memory is on, the engram bridge guarantees bridged.length > 0, so a
  // start.mjs is always emitted and carries the tolerant Engram cloud setup phase.
  if (bridged.length > 0) {
    files.push({ path: "start.mjs", content: emitStartMjs(bridged, sharedMemoryEnabled ? engramProjectKey : undefined) });
  }

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
      mcpStdioBridged: bridged.map((m) => m.name),
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
  bridgedMcp: BridgedStdioServer[],
  unmapped: UnmappedItem[],
  nodeSandbox: boolean,
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
    unmapped.push({
      kind: "subagent-model",
      name: "subagents",
      reason: "Subagent model overrides were dropped because the main provider was swapped; subagents inherit the main model.",
    });
  }

  // skills
  const skillIdents: string[] = [];
  const skillImports: string[] = [];
  for (const skill of project.skills) {
    const id = uniqueIdent(skill.name + "Skill", used);
    skillIdents.push(id);
    skillImports.push(`import ${id} from "../skills/${skill.name}/SKILL.md" with { type: "skill" };`);
  }

  // MCP — top-level await for both HTTP and bridged-stdio servers.
  // connectMcpServer is imported whenever there are HTTP or bridged servers.
  const mcpIdents: string[] = [];
  const mcpBlocks: string[] = [];
  if (httpMcp.length > 0 || bridgedMcp.length > 0) {
    imports.add("connectMcpServer");
  }
  for (const mcp of httpMcp) {
    const id = uniqueIdent(mcp.name + "Mcp", used);
    mcpIdents.push(id);
    const env = `${upperSnake(mcp.name)}_MCP_URL`;
    const opts: string[] = [`  url: process.env.${env} ?? ${q(mcp.url)},`];
    if (mcp.transport === "sse") opts.push(`  transport: "sse",`);
    if (mcp.headers && Object.keys(mcp.headers).length > 0) opts.push(`  headers: ${json(mcp.headers)},`);
    // I9: route http servers through the tolerant helper so a DNS failure or
    // downed server does not prevent the agent from booting.
    mcpBlocks.push(`const ${id} = await tryConnectMcpServer(${q(mcp.name)}, {\n${opts.join("\n")}\n});`);
  }
  // Bridged stdio servers run as sidecars started by start.mjs. They are reached
  // over localhost — no env-override URL because the port is internal and fixed at
  // emit time. connectMcpServer defaults to streamable-http, which matches
  // supergateway's --outputTransport streamableHttp. No `transport` field needed.
  // Emit the tolerant connect helper whenever any MCP server is configured
  // (http or bridged). One unreachable server must not crash the whole agent
  // at boot (Fleet backlog I9).
  const tryHelperLines: string[] = [];
  if (httpMcp.length > 0 || bridgedMcp.length > 0) {
    tryHelperLines.push(
      `/**`,
      ` * Connect an MCP server tolerantly: if it is unreachable at boot (bridged`,
      ` * sidecar not started, remote http server down or DNS-unresolvable), boot`,
      ` * WITHOUT that server's tools instead of crashing the agent. One missing`,
      ` * integration must not take the whole agent down (Fleet backlog I9).`,
      ` */`,
      `async function tryConnectMcpServer(name: string, options: Parameters<typeof connectMcpServer>[1]) {`,
      `  try {`,
      `    return await connectMcpServer(name, options);`,
      `  } catch (err) {`,
      `    console.warn(\`[fleet] MCP "\${name}" unavailable: \${err instanceof Error ? err.message : String(err)}\`);`,
      `    return { tools: [] as never[] };`,
      `  }`,
      `}`,
    );
  }
  if (bridgedMcp.length > 0) {
    for (const mcp of bridgedMcp) {
      const id = uniqueIdent(mcp.name + "Mcp", used);
      mcpIdents.push(id);
      mcpBlocks.push(`const ${id} = await tryConnectMcpServer(${q(mcp.name)}, {\n  url: "http://127.0.0.1:${mcp.port}/mcp",\n});`);
    }
  }

  // createAgent config
  const cfg: string[] = [`  model: ${q(specifier)},`, `  instructions: ${tpl(project.instructions)},`];
  // Real shell + filesystem for Node targets: without `sandbox: local()` the
  // agent runs Flue's in-memory just-bash emulator and CLAUDE.md instructions
  // that invoke git/npm/scripts silently can't execute. Cloudflare Workers
  // have no subprocesses, so the import is omitted there (it would break the
  // CF build). Verified against @flue/runtime 0.10.1.
  if (nodeSandbox) cfg.push(`  sandbox: local({ env: { ...process.env } }),`);
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
  if (nodeSandbox) out.push(`import { local } from "@flue/runtime/node";`);
  if (skillImports.length) out.push(...skillImports);
  out.push("");
  if (profileBlocks.length) out.push(profileBlocks.join("\n\n"), "");
  if (tryHelperLines.length) out.push(tryHelperLines.join("\n"), "");
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

// ── start.mjs codegen ────────────────────────────────────────────────────────

/**
 * Emit the container entrypoint that starts one supergateway bridge per bridged
 * stdio MCP server, waits for each port to accept connections, then starts the
 * Flue server. Only emitted when `bridged.length > 0`.
 *
 * Bridge facts verified against supergateway 3.4.3 (--stdio + --outputTransport
 * streamableHttp, default path /mcp).
 *
 * `engramProjectKey` (J4): when set, a tolerant Engram cloud setup phase runs
 * BEFORE the bridges and the server (config + enroll), gated on the presence of
 * `ENGRAM_CLOUD_SERVER` + `ENGRAM_CLOUD_TOKEN`. The bridge machinery stays generic
 * (engram is just another entry in BRIDGES); only this setup phase is engram-aware.
 */
function emitStartMjs(bridged: BridgedStdioServer[], engramProjectKey?: string): string {
  const bridgesLiteral = bridged
    .map((m) => {
      const cmd = [m.command, ...(m.args ?? [])].join(" ");
      return `  { name: ${q(m.name)}, port: ${m.port}, command: ${q(cmd)} },`;
    })
    .join("\n");

  // Tolerant, idempotent Engram cloud setup (J4 / DA-05). Runs config + enroll
  // before anything else; any failure only warns so the agent still boots with
  // LOCAL memory (MEM-04/MEM-06). Skipped entirely when the cloud vars are absent.
  const engramSetup =
    engramProjectKey === undefined
      ? ""
      : `// ── Engram cloud setup (shared memory) — tolerant + idempotent ──\n` +
        `async function setupEngramCloud() {\n` +
        `  const server = process.env.ENGRAM_CLOUD_SERVER;\n` +
        `  const token = process.env.ENGRAM_CLOUD_TOKEN;\n` +
        `  // No server/token ⇒ shared memory not configured; run with LOCAL memory only.\n` +
        `  if (!server || !token) return;\n` +
        `  const run = (args) =>\n` +
        `    new Promise((resolve, reject) => {\n` +
        `      const c = spawn("engram", args, { stdio: "inherit" });\n` +
        `      c.on("error", reject);\n` +
        `      c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(\`engram \${args.join(" ")} exited \${code}\`))));\n` +
        `    });\n` +
        `  try {\n` +
        `    // Idempotent: re-running config/enroll for an already-enrolled agent is a no-op.\n` +
        `    await run(["cloud", "config", "--server", server]);\n` +
        `    await run(["cloud", "enroll", ${q(engramProjectKey)}]);\n` +
        `    // Autosync activates from env (ENGRAM_CLOUD_AUTOSYNC=1 + SERVER + TOKEN); nothing to run here.\n` +
        `    console.log(\`[fleet] engram cloud setup complete (project: ${engramProjectKey})\`);\n` +
        `  } catch (err) {\n` +
        `    // MEM-04/MEM-06: never abort the boot — degrade to local memory.\n` +
        `    console.warn(\`[fleet] engram cloud setup failed; continuing with local memory: \${err instanceof Error ? err.message : String(err)}\`);\n` +
        `  }\n` +
        `}\n` +
        `await setupEngramCloud();\n` +
        `\n`;

  return (
    `/**\n` +
    ` * Container entrypoint — starts one supergateway bridge per stdio MCP server,\n` +
    ` * waits for each port to accept connections, then starts the Flue server.\n` +
    ` * Generated by @inteliside/gateway-converter; bridge facts verified against\n` +
    ` * supergateway ${SUPERGATEWAY_VERSION} (--stdio + --outputTransport streamableHttp, path /mcp).\n` +
    ` */\n` +
    `import { spawn } from "node:child_process";\n` +
    `import { connect } from "node:net";\n` +
    `\n` +
    engramSetup +
    `const BRIDGES = [\n` +
    bridgesLiteral +
    `\n];\n` +
    `\n` +
    `const children = [];\n` +
    `for (const b of BRIDGES) {\n` +
    `  // The command is passed as ONE argv entry — no shell interpolation on our side.\n` +
    `  const child = spawn(\n` +
    `    "npx",\n` +
    `    ["supergateway", "--stdio", b.command, "--outputTransport", "streamableHttp", "--port", String(b.port)],\n` +
    `    { stdio: "inherit" }, // env inherited: container env (incl. the server's vars) reaches the wrapped process\n` +
    `  );\n` +
    `  children.push(child);\n` +
    `}\n` +
    `\n` +
    `function waitForPort(port, timeoutMs = 15000) {\n` +
    `  return new Promise((resolve) => {\n` +
    `    const started = Date.now();\n` +
    `    const tryOnce = () => {\n` +
    `      const sock = connect({ port, host: "127.0.0.1" }, () => { sock.destroy(); resolve(true); });\n` +
    `      sock.on("error", () => {\n` +
    `        sock.destroy();\n` +
    `        if (Date.now() - started > timeoutMs) resolve(false);\n` +
    `        else setTimeout(tryOnce, 250);\n` +
    `      });\n` +
    `    };\n` +
    `    tryOnce();\n` +
    `  });\n` +
    `}\n` +
    `\n` +
    `for (const b of BRIDGES) {\n` +
    `  const up = await waitForPort(b.port);\n` +
    `  if (!up) console.warn(\`[fleet] bridge "\${b.name}" did not come up on :\${b.port} — the agent will boot without it\`);\n` +
    `}\n` +
    `\n` +
    `const server = spawn("node", ["dist/server.mjs"], { stdio: "inherit" });\n` +
    `for (const sig of ["SIGTERM", "SIGINT"]) {\n` +
    `  process.on(sig, () => { server.kill(sig); for (const c of children) c.kill(sig); });\n` +
    `}\n` +
    `server.on("exit", (code) => { for (const c of children) c.kill("SIGTERM"); process.exit(code ?? 0); });\n`
  );
}

// ── scaffold files ────────────────────────────────────────────────────────────

const FLUE_CONFIG = `import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
});
`;

// A CONSTANT package.json name (not the agent name) so the manifest is
// byte-identical across agents within the same bridging class. Agents that use
// in-container stdio bridges ("bridged" class) share one `npm install` Docker
// layer; agents without them share another. The agent's identity comes from the
// src/agents/<name>.ts filename, not this field.
function emitPackageJson(hasBridged: boolean): string {
  const dependencies: Record<string, string> = {
    "@flue/runtime": FLUE_VERSION,
    agents: AGENTS_VERSION,
  };
  // supergateway is only needed when the container entrypoint (start.mjs) bridges
  // one or more stdio MCP servers. Verified against supergateway 3.4.3.
  if (hasBridged) {
    dependencies["supergateway"] = SUPERGATEWAY_VERSION;
  }
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
          // When bridged servers are present, start.mjs launches the supergateway
          // sidecars and then execs the Flue server. Without bridges, the Flue
          // server starts directly.
          start: hasBridged ? "node start.mjs" : "node dist/server.mjs",
          "build:cloudflare": "flue build --target cloudflare",
          "deploy:cloudflare": "wrangler deploy",
        },
        dependencies,
        devDependencies: {
          "@flue/cli": FLUE_VERSION,
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Emit the Dockerfile. The variable parts are: the CMD (when stdio bridges are
 * present, the entrypoint is start.mjs — which starts bridges then the server —
 * otherwise the Flue server starts directly), and a multi-stage `COPY --from` of
 * the pinned `engram` binary when shared memory is on (J4). When shared memory is
 * off (or the target is Cloudflare) the Dockerfile is byte-identical to before.
 */
function emitDockerfile(hasBridged: boolean, sharedMemory: boolean): string {
  const cmd = hasBridged ? `CMD ["node", "start.mjs"]` : `CMD ["node", "dist/server.mjs"]`;
  // Multi-stage: pull the pinned engram binary out of the official image (RNF-02:
  // only the binary is copied, not the whole image, so the final layer stays slim).
  const engramCopy = sharedMemory
    ? `# Shared memory (Engram): copy the pinned engram binary from the official image.\n` +
      `COPY --from=${ENGRAM_IMAGE} ${ENGRAM_BIN_PATH} ${ENGRAM_BIN_PATH}\n`
    : "";
  return (
    `# Deployable Flue agent (Node target). Built by @inteliside/gateway-converter.\n` +
    `FROM node:22-slim\n` +
    `WORKDIR /app\n` +
    engramCopy +
    `COPY package.json ./\n` +
    `RUN npm install\n` +
    `COPY . .\n` +
    `RUN npx flue build --target node\n` +
    `ENV HOST=0.0.0.0\n` +
    `ENV PORT=8080\n` +
    `EXPOSE 8080\n` +
    cmd +
    `\n`
  );
}

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

function emitEnvExample(
  apiKeyEnv: string,
  httpMcp: Array<{ name: string; url: string }>,
  stdioMcp: Array<{ name: string; env?: Record<string, string> }>,
  env: Record<string, string> = {},
  sharedMemory = false,
): string {
  const lines = [`# Model provider key (the agent reads this at runtime).`, `${apiKeyEnv}=`];
  // Shared memory (Engram cloud, J4). NAMES only — the deployer injects real values
  // from the secret store (rule #8 / MEM-08); nothing is committed. Without
  // SERVER+TOKEN the agent runs with local memory only. Set ENGRAM_CLOUD_AUTOSYNC=1
  // (deployer-injected) to enable autosync replication.
  if (sharedMemory) {
    lines.push(
      "",
      `# Shared memory (Engram cloud) — names only; values are injected by the deployer.`,
      `ENGRAM_CLOUD_SERVER=`,
      `ENGRAM_CLOUD_TOKEN=`,
      `ENGRAM_CLOUD_AUTOSYNC=`,
    );
  }
  for (const mcp of httpMcp) {
    lines.push("", `# Optional override for the "${mcp.name}" MCP server URL.`, `${upperSnake(mcp.name)}_MCP_URL=`);
  }
  // Env vars declared on stdio MCP servers in .mcp.json. Values are DROPPED —
  // only the names surface here (rule #8: secrets only in env vars, never in the repo).
  // The container env reaches the bridged process via `{ stdio: "inherit" }` in start.mjs.
  for (const mcp of stdioMcp) {
    const names = Object.keys(mcp.env ?? {}).sort();
    if (names.length > 0) {
      lines.push("", `# Env vars for the "${mcp.name}" stdio MCP server (passed through to the bridged process).`);
      for (const name of names) lines.push(`${name}=`);
    }
  }
  // Env vars declared in the source project's settings(.local).json `env` block.
  // NAMES only (never the values — secrets stay out of the repo, per Fleet rules).
  const settingsEnvNames = Object.keys(env)
    .filter((k) => k !== apiKeyEnv)
    .sort();
  if (settingsEnvNames.length > 0) {
    lines.push("", `# From the source project's .claude/settings.json "env" block — fill in real values.`);
    for (const name of settingsEnvNames) lines.push(`${name}=`);
  }
  return lines.join("\n") + "\n";
}

function emitReadme(
  project: ClaudeProject,
  specifier: string,
  apiKeyEnv: string,
  httpMcp: Array<{ name: string }>,
  bridgedMcp: Array<{ name: string; port: number }>,
  unmapped: UnmappedItem[],
  nodeSandbox: boolean,
): string {
  const lines: string[] = [];
  lines.push(`# ${project.name}`, "");
  lines.push(`Deployable **Flue** agent generated from a Claude Code project by`, `\`@inteliside/gateway-converter\`. Re-convert the source rather than editing here.`, "");
  lines.push(`## Model`, "");
  lines.push(`- Specifier: \`${specifier}\``);
  lines.push(`- Set \`${apiKeyEnv}\` in the environment (see \`.env.example\`).`, "");
  lines.push(`## Run`, "", "```bash", "npm install", `export ${apiKeyEnv}=...`, "npm run dev      # local dev server", "npm run build && npm start   # production (node start.mjs)", "```", "");
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
  lines.push(
    nodeSandbox
      ? `- Real shell and filesystem (\`sandbox: local()\`) — the agent can run commands and use files inside its container.`
      : `- Emulated sandbox only (Cloudflare Workers): no real shell or filesystem; bash-like commands run in an in-memory emulator.`,
  );
  if (bridgedMcp.length > 0) {
    lines.push("", `## Bridged stdio MCP servers`, "");
    lines.push(`These stdio servers run inside the container as supergateway sidecars (started by \`start.mjs\`). They are available to the agent at boot time; if a bridge fails to start, the agent boots without those tools rather than crashing.`, "");
    for (const m of bridgedMcp) {
      lines.push(`- **${m.name}** — internal port ${m.port} (\`http://127.0.0.1:${m.port}/mcp\`)`);
    }
  }
  if (unmapped.length) {
    lines.push("", `## Not mapped`, "");
    for (const u of unmapped) lines.push(`- ${u.reason}`);
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
