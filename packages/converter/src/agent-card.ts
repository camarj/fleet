/**
 * A2A Agent Card emitter (pivote B1, issue #68).
 *
 * Derives an **Agent Card** — the A2A protocol's capability descriptor — from a
 * parsed Claude Code project, so the converted agent can be advertised to the
 * Baton Orchestrator / A2A coordination layer (ADR-13, `CONTEXT.md`: Agent Card,
 * Capability). Deterministic, no network, no LLM — like the rest of the converter.
 *
 * The shape is the A2A **JSON representation** of `AgentCard`, NOT invented
 * (CLAUDE.md rule #4). Verified against:
 *   - `@a2a-js/sdk` 0.3.13 `dist` type definitions (the JSON wire our `A2aAdapter`
 *     ecosystem consumes — `packages/core/src/adapters/foreign/a2a-types.ts`),
 *   - the normative `spec/a2a.proto` (a2aproject/A2A, `main`), and
 *   - https://a2a-protocol.org/latest/specification/ (§ "Agent Card").
 *
 * Required JSON fields (per the SDK interface): `name`, `description`, `version`,
 * `protocolVersion`, `url`, `capabilities`, `defaultInputModes`,
 * `defaultOutputModes`, `skills`. `provider`, `preferredTransport`,
 * `additionalInterfaces`, `security*`, `signatures` are optional.
 *
 * The agent's **endpoint** is NOT known at convert time (it is assigned at deploy,
 * issue #68 AC). So `url` is emitted EMPTY — a placeholder the registrar/deployer
 * fills (Baton slice B2). Likewise `preferredTransport`/`additionalInterfaces`
 * are left for the registrar, which knows how the deployed Flue agent is fronted.
 */

import type { ClaudeProject } from "./types.js";

/** A2A protocol version this card declares (proto examples: "0.3", "1.0"; SDK line 0.3.x). */
const A2A_PROTOCOL_VERSION = "0.3.0";

/** A2A `AgentSkill` (JSON). `id`/`name`/`description`/`tags` are required. */
export interface A2aAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/** A2A `AgentCapabilities` (JSON). All fields optional. */
export interface A2aAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

/** The subset of A2A `AgentCard` (JSON) the converter emits. */
export interface A2aAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  /** Preferred endpoint URL. EMPTY at convert time — filled by the registrar/deployer (B2). */
  url: string;
  version: string;
  capabilities: A2aAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aAgentSkill[];
}

/** Identity/runtime facts the card needs, resolved by the emitter. */
export interface AgentCardInputs {
  /** Final Flue model specifier, e.g. "anthropic/claude-sonnet-4-6". */
  modelSpecifier: string;
  /** Names of HTTP MCP servers actually wired (tools the agent can use). */
  httpMcp: string[];
  /** Names of stdio MCP servers bridged in-container (tools the agent can use). */
  bridgedMcp: string[];
}

/**
 * Build the Agent Card from the parsed project plus the resolved runtime facts.
 * Capabilities are derived from the agent's skills, subagents and wired MCP
 * servers (tools); identity/runtime (name, model) lands in `name`/`description`.
 * Output is fully deterministic — every list is sorted.
 */
export function buildAgentCard(project: ClaudeProject, inputs: AgentCardInputs): A2aAgentCard {
  const purpose = describePurpose(project);

  const skills: A2aAgentSkill[] = [];

  // Baseline: the agent's core conversational capability (instructions). Guarantees a
  // non-empty `skills` array even for an instructions-only agent.
  skills.push({
    id: "general",
    name: project.name,
    description: purpose,
    tags: ["general", "claude-code"],
  });

  // Subagents → focused skills (they carry a real description in their frontmatter).
  for (const sub of [...project.subagents].sort((a, b) => a.name.localeCompare(b.name))) {
    skills.push({
      id: `subagent-${sub.name}`,
      name: sub.name,
      description: sub.description?.trim() || `Subagent "${sub.name}".`,
      tags: ["subagent"],
    });
  }

  // Skills → skills (SKILL.md description when present).
  for (const sk of [...project.skills].sort((a, b) => a.name.localeCompare(b.name))) {
    skills.push({
      id: `skill-${sk.name}`,
      name: sk.name,
      description: sk.description?.trim() || `Skill "${sk.name}".`,
      tags: ["skill"],
    });
  }

  // Wired MCP servers (HTTP + bridged stdio) → tool capabilities. Unmapped servers
  // are NOT advertised — the agent cannot actually reach them.
  for (const name of [...inputs.httpMcp, ...inputs.bridgedMcp].sort((a, b) => a.localeCompare(b))) {
    skills.push({
      id: `mcp-${name}`,
      name,
      description: `Tools provided by the "${name}" MCP server.`,
      tags: ["mcp", "tools"],
    });
  }

  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: project.name,
    description: `${purpose} Runtime: Flue agent, model ${inputs.modelSpecifier}. Converted from a Claude Code project.`,
    url: "", // endpoint assigned at deploy — filled by the registrar (B2), never baked here.
    version: "1.0.0",
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills,
  };
}

/** First meaningful (non-heading, non-empty) line of the instructions, bounded. */
function describePurpose(project: ClaudeProject): string {
  for (const raw of project.instructions.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("---")) continue;
    return line.length > 280 ? `${line.slice(0, 277)}...` : line;
  }
  return `Agent "${project.name}".`;
}
