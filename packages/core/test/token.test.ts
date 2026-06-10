/**
 * WU-20 unit test — WS auth token module.
 *
 * Covers:
 *   1. loadOrCreateToken: generates a 64-char hex token, persists it at 0600,
 *      and returns the SAME token on the second call (idempotent load).
 *   2. tokensMatch: true for identical strings, false for different strings,
 *      false for strings of different lengths.
 *
 * Uses a temp dir via GATEWAY_DATA_DIR so it never touches ~/.fleet.
 *
 * Run: pnpm --filter @inteliside/gateway-core exec tsx test/token.test.ts
 */

import { rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(DIR, "..", ".token-test");
process.env.GATEWAY_DATA_DIR = DATA_DIR;

const { loadOrCreateToken, tokensMatch, isAuthorizedRequestUrl } = await import("../src/auth/token.js");

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });

  // ── 1. loadOrCreateToken ─────────────────────────────────────────────────

  console.log("\n[1] loadOrCreateToken …");

  const tokenFile = join(DATA_DIR, "gateway-token");

  const t1 = loadOrCreateToken(tokenFile);
  assert(typeof t1 === "string" && t1.length === 64, `generated token is 64-char hex (got ${t1.length})`);
  assert(/^[0-9a-f]+$/.test(t1), "token is lowercase hex");

  // Check file permissions (mode & 0o777 should be 0o600).
  const mode = statSync(tokenFile).mode & 0o777;
  assert(mode === 0o600, `token file mode is 0600 (got ${mode.toString(8)})`);

  // Second call must return the same token (idempotent load).
  const t2 = loadOrCreateToken(tokenFile);
  assert(t2 === t1, "second loadOrCreateToken returns the same token");

  // ── 2. tokensMatch ───────────────────────────────────────────────────────

  console.log("\n[2] tokensMatch …");

  const a = "abc123";
  assert(tokensMatch(a, a), "identical strings match");
  assert(!tokensMatch(a, "abc124"), "different strings do not match");
  assert(!tokensMatch(a, "abc12"), "shorter string does not match");
  assert(!tokensMatch("abc12", a), "longer string does not match");
  assert(!tokensMatch("", "x"), "empty vs non-empty does not match");
  assert(tokensMatch("", ""), "empty matches empty");

  // ── 3. isAuthorizedRequestUrl (the WS handshake gate) ────────────────────

  console.log("\n[3] isAuthorizedRequestUrl …");

  const T = "deadbeef";
  assert(isAuthorizedRequestUrl("/?token=deadbeef", T), "correct token authorizes");
  assert(!isAuthorizedRequestUrl("/?token=wrong", T), "wrong token denies");
  assert(!isAuthorizedRequestUrl("/?token=", T), "empty token param denies");
  assert(!isAuthorizedRequestUrl("/", T), "missing token param denies");
  assert(!isAuthorizedRequestUrl(undefined, T), "undefined url denies");
  assert(isAuthorizedRequestUrl("/path?foo=1&token=deadbeef", T), "token among other params authorizes");

  rmSync(DATA_DIR, { recursive: true, force: true });

  console.log(process.exitCode ? "\nFAILED" : "\nALL GOOD");
  process.exit(process.exitCode ? 1 : 0);
}

main();
