/**
 * SecretsStore — provider API keys persisted server-side, never in the repo or
 * the frontend (rule #8). File-backed at `<dataDir>/secrets.json` with 0600
 * permissions. The frontend only ever sets/lists; it never reads key VALUES back
 * — `list()` returns provider ids that have a key, not the secrets themselves.
 *
 * (File-at-rest is the MVP "secure store"; it can be swapped for an OS keychain
 * later without changing callers.)
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { secretsPath } from "../paths.js";

export class SecretsStore {
  readonly #path: string;
  #keys: Record<string, string>;

  constructor(path: string = secretsPath()) {
    this.#path = path;
    this.#keys = this.#load();
  }

  /** Provider ids that currently have a key set (NOT the values). */
  list(): string[] {
    return Object.keys(this.#keys).sort();
  }

  /** The key for a provider, if set. Server-side use only. */
  get(provider: string): string | undefined {
    return this.#keys[provider];
  }

  set(provider: string, apiKey: string): void {
    if (apiKey) this.#keys[provider] = apiKey;
    else delete this.#keys[provider];
    this.#persist();
  }

  delete(provider: string): void {
    delete this.#keys[provider];
    this.#persist();
  }

  #load(): Record<string, string> {
    if (!existsSync(this.#path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  #persist(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify(this.#keys, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.#path, 0o600);
    } catch {
      /* best-effort on platforms without chmod semantics */
    }
  }
}
