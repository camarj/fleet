/**
 * @inteliside/gateway-converter — reads a Claude Code agent project and emits a
 * standalone, deployable Flue (TypeScript) agent. Deterministic, no LLM. The
 * target provider/model are choosable at convert time.
 */

export * from "./types.js";
export { ConvertError, knownProviders, resolveModel } from "./providers.js";
export { readClaudeProject } from "./read.js";
export { emitFlueProject } from "./emit.js";
export { writeFlueProject } from "./write.js";

import { emitFlueProject } from "./emit.js";
import { readClaudeProject } from "./read.js";
import { writeFlueProject } from "./write.js";
import type { ConvertOptions, FlueProject } from "./types.js";

/** Read a Claude Code project and emit a Flue project in memory (no writes). */
export function convert(srcDir: string, opts: ConvertOptions = {}): FlueProject {
  return emitFlueProject(readClaudeProject(srcDir), opts);
}

/** Convert and write the Flue project to `outDir`. Returns the in-memory result. */
export function convertAndWrite(srcDir: string, outDir: string, opts: ConvertOptions = {}): FlueProject {
  const project = convert(srcDir, opts);
  writeFlueProject(project, outDir);
  return project;
}
