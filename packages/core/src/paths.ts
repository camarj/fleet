/**
 * Fleet data-directory paths. Everything the Core persists outside the DB lives
 * under one root: deployed Flue agents and the secrets store. Override the root
 * with GATEWAY_DATA_DIR (used by tests and packaging).
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  return process.env.GATEWAY_DATA_DIR ?? join(homedir(), ".fleet");
}

/** Parent dir holding every deployed agent (and a shared @flue install). */
export function deployedDir(): string {
  return join(dataDir(), "deployed");
}

/** Secrets file (provider API keys), 0600. */
export function secretsPath(): string {
  return join(dataDir(), "secrets.json");
}
