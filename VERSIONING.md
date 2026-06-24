# Versioning

Fleet uses **[Semantic Versioning 2.0.0](https://semver.org/)** — `MAJOR.MINOR.PATCH` —
with a single version applied **in lockstep** across the whole monorepo (Core,
frontend, desktop shell, Tauri config, Rust crate). One number describes the
product; there is no per-package versioning.

## What each part means

| Part | Bump when… |
| --- | --- |
| **MAJOR** | A breaking change to a public contract — the Gateway API (`packages/core/src/api.ts`), the neutral run model, or desktop IPC. |
| **MINOR** | A backward-compatible feature (new capability, new adapter, new UI surface). |
| **PATCH** | A backward-compatible bug fix or internal change with no API impact. |

### Pre-1.0 (current: `0.x`)

While the major is `0`, the public API is still settling. Treat **MINOR** as the
"something changed, possibly breaking" signal and **PATCH** as "safe fix". We move
to `1.0.0` when the Gateway API and the Flue adapter are considered stable (the
A2A coordination layer is post-pivot direction, ADR-13 — it does not gate 1.0.0).

## Releasing

The version lives in 7 manifests. Never edit them by hand — use the bump script,
which updates all of them at once:

```bash
pnpm version:set patch       # 0.1.0 → 0.1.1
pnpm version:set minor       # 0.1.0 → 0.2.0
pnpm version:set major       # 0.1.0 → 1.0.0
pnpm version:set 0.3.0       # set an exact version
```

Then:

```bash
# 1. Move the CHANGELOG "Unreleased" notes under a new version heading.
# 2. Review the diff.
git commit -am "chore(release): v0.2.0"
git tag v0.2.0
git push --follow-tags
```

**Git tags (`vX.Y.Z`) are the source of truth for releases.** The desktop bundle
name derives from the Tauri version, so a tagged build produces
`Fleet_X.Y.Z_aarch64.dmg`.

## Commits & changelog

Commits follow **[Conventional Commits](https://www.conventionalcommits.org/)**
(`feat:`, `fix:`, `chore:`, `docs:`, …). This keeps history readable and lets the
`CHANGELOG.md` be assembled from commit messages. The changelog follows
[Keep a Changelog](https://keepachangelog.com/).

> Automation (changesets / semantic-release) can be layered on later if releases
> get frequent — the lockstep + conventional-commits foundation is already in
> place for it.
