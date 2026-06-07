/**
 * Single-command version bump for the whole Fleet monorepo (lockstep SemVer).
 *
 * One version drives everything: all package.json files, the Tauri config, and
 * the Rust crate. Run from the repo root:
 *
 *   node scripts/bump-version.mjs <patch|minor|major|X.Y.Z>
 *   pnpm version:set <patch|minor|major|X.Y.Z>
 *
 * It does NOT commit or tag — review the diff, then:
 *   git commit -am "chore(release): vX.Y.Z" && git tag vX.Y.Z && git push --follow-tags
 *
 * See VERSIONING.md for the policy.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Files that carry the version, and how to find the version field in each.
const JSON_FILES = [
  "package.json",
  "packages/core/package.json",
  "frontend/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
];
const CARGO_TOML = "apps/desktop/src-tauri/Cargo.toml";
const CARGO_LOCK = "apps/desktop/src-tauri/Cargo.lock";

const SEMVER = /^\d+\.\d+\.\d+$/;

function read(rel) {
  return readFileSync(join(repo, rel), "utf8");
}
function write(rel, content) {
  writeFileSync(join(repo, rel), content);
}

function nextVersion(current, arg) {
  if (SEMVER.test(arg)) return arg;
  const [maj, min, pat] = current.split(".").map(Number);
  if (arg === "major") return `${maj + 1}.0.0`;
  if (arg === "minor") return `${maj}.${min + 1}.0`;
  if (arg === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Invalid bump "${arg}" — use major | minor | patch | X.Y.Z`);
}

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/bump-version.mjs <patch|minor|major|X.Y.Z>");
  process.exit(1);
}

const root = JSON.parse(read("package.json"));
const current = root.version;
if (!SEMVER.test(current)) throw new Error(`root package.json version "${current}" is not X.Y.Z`);
const next = nextVersion(current, arg);

if (next === current) {
  console.log(`Version already ${current} — nothing to do.`);
  process.exit(0);
}

// JSON manifests: replace the first top-level "version" field, preserving format.
for (const rel of JSON_FILES) {
  const before = read(rel);
  const after = before.replace(`"version": "${current}"`, `"version": "${next}"`);
  if (after === before) throw new Error(`Could not find "version": "${current}" in ${rel}`);
  write(rel, after);
}

// Cargo.toml: the [package] version is the only full-semver `version = "X.Y.Z"`
// (dependency versions are "2", "1", etc.), so a targeted replace is safe.
{
  const before = read(CARGO_TOML);
  const after = before.replace(`version = "${current}"`, `version = "${next}"`);
  if (after === before) throw new Error(`Could not find version = "${current}" in ${CARGO_TOML}`);
  write(CARGO_TOML, after);
}

// Cargo.lock: only the gateway-desktop package entry.
{
  const before = read(CARGO_LOCK);
  const after = before.replace(
    `name = "gateway-desktop"\nversion = "${current}"`,
    `name = "gateway-desktop"\nversion = "${next}"`,
  );
  if (after === before) console.warn(`! Cargo.lock entry not updated (will sync on next cargo build)`);
  else write(CARGO_LOCK, after);
}

console.log(`Fleet ${current} → ${next}`);
console.log(`\nNext:\n  git commit -am "chore(release): v${next}"\n  git tag v${next}\n  git push --follow-tags`);
