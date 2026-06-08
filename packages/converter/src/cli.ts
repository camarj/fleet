#!/usr/bin/env node
/**
 * CLI: claude-to-flue <src-project> <out-dir> [--provider <id>] [--model <id>]
 *
 * Reads a Claude Code project and writes a deployable Flue agent. The optional
 * --provider/--model select the target model (the converter's central feature);
 * by default the source (Anthropic) model is kept.
 */

import { convertAndWrite } from "./index.js";
import { ConvertError } from "./providers.js";

interface Args {
  src?: string;
  out?: string;
  provider?: string;
  model?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") args.provider = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a) positional.push(a);
  }
  args.src = positional[0];
  args.out = positional[1];
  return args;
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  if (!args.src || !args.out) {
    console.error("Usage: claude-to-flue <src-project> <out-dir> [--provider <id>] [--model <id>]");
    process.exit(1);
  }
  try {
    const { report } = convertAndWrite(args.src, args.out, { provider: args.provider, model: args.model });
    console.log(`✓ Converted "${report.agentName}" → ${args.out}`);
    console.log(`  model: ${report.modelSpecifier} (key env: ${report.apiKeyEnv})`);
    console.log(`  subagents: ${report.subagents.length}, skills: ${report.skills.length}, http MCP: ${report.mcpHttp.length}`);
    for (const u of report.unmapped) console.log(`  ! not mapped: ${u}`);
  } catch (err) {
    if (err instanceof ConvertError) {
      console.error(`✖ ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

main(process.argv.slice(2));
