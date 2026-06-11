/**
 * OrgStore — local org binding persistence. Mirrors SecretsStore
 * (secrets/store.ts) but holds NO secret values (rule #8).
 *
 * Persists one JSON document to `orgBindingPath()` =
 * <dataDir>/org-binding.json when an org is bound, removes the file on
 * leave. The contents uniquely identify the bound repo and the user's role
 * (derived from org.json.owner vs whoami) but carry no credentials.
 *
 * Constraint: exactly zero or one binding at a time. A second createOrg /
 * bindOrg call MUST clear any previous binding first (call clear() then save
 * the new one — the caller's (OrgManager's) responsibility).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { orgBindingPath } from "../paths.js";
import type { OrgRole } from "./registry.js";

// ── Binding shape ───────────────────────────────────────────────────────────

/**
 * Persisted org binding document.
 *
 * schemaVersion: current known version is 1. Readers SKIP files with a
 * version greater than the known max (forward-compat, same rule as the
 * registry repo format).
 */
export interface OrgBinding {
  schemaVersion: number;
  repo: string;       // "owner/repo" — full qualified repo name
  orgId: string;
  orgName: string;
  myLogin: string;    // authenticated gh login at bind time
  role: OrgRole;
  lastSyncedAt: string | null; // ISO 8601 or null if never synced
}

const CURRENT_SCHEMA_VERSION = 1;

// ── OrgStore ────────────────────────────────────────────────────────────────

export class OrgStore {
  readonly #path: string;

  constructor(path: string = orgBindingPath()) {
    this.#path = path;
  }

  /** Load the current binding, or null if not bound / file missing / corrupt. */
  load(): OrgBinding | null {
    if (!existsSync(this.#path)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") return null;
      const b = raw as Record<string, unknown>;
      // Skip entries with a schemaVersion we don't understand (forward compat).
      if (typeof b.schemaVersion !== "number" || b.schemaVersion > CURRENT_SCHEMA_VERSION) {
        console.warn("[OrgStore] Unknown schemaVersion — ignoring binding file.");
        return null;
      }
      return raw as OrgBinding;
    } catch {
      return null;
    }
  }

  /** Persist a new binding. Creates parent directories as needed. */
  save(binding: OrgBinding): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify(binding, null, 2), { encoding: "utf8" });
  }

  /**
   * Update lastSyncedAt on the stored binding (no-op if not bound).
   * Used after a successful reconcile without re-writing the full object.
   */
  touchSyncedAt(at: string): void {
    const current = this.load();
    if (!current) return;
    this.save({ ...current, lastSyncedAt: at });
  }

  /** Remove the binding file entirely (org leave). */
  clear(): void {
    if (existsSync(this.#path)) rmSync(this.#path, { force: true });
  }

  /** True when a binding file exists and is parseable. */
  isBound(): boolean {
    return this.load() !== null;
  }
}
