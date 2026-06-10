/**
 * WS auth token — persisted 0600, generated on first Core boot.
 * The frontend must echo this token in the WS handshake (query param `token`).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { tokenPath } from "../paths.js";

/**
 * Load the persisted WS auth token, generating + persisting one on first boot.
 * The frontend must echo this token in the WS handshake (query param `token`).
 */
export function loadOrCreateToken(path: string = tokenPath()): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
    // Stale/empty file: remove it so the rewrite creates a fresh inode and
    // writeFileSync's `mode` actually applies (it is ignored on existing files).
    rmSync(path, { force: true });
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on platforms without chmod semantics */
  }
  return token;
}

/** Constant-time string compare (handles unequal lengths without throwing). */
export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Decide whether a WS upgrade request carries the right token. `reqUrl` is the
 * raw `info.req.url` (path + query). The host is irrelevant — only the `token`
 * query param matters — so any valid `origin` works for parsing. A missing,
 * empty, mismatched, or unparseable URL all deny.
 */
export function isAuthorizedRequestUrl(
  reqUrl: string | undefined,
  token: string,
  origin = "ws://localhost",
): boolean {
  try {
    const provided = new URL(reqUrl ?? "", origin).searchParams.get("token");
    return provided != null && tokensMatch(provided, token);
  } catch {
    return false;
  }
}
