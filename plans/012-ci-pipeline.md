# Plan 012: Pipeline de CI (GitHub Actions) — typecheck + tests + build en cada push

> **Executor instructions**: Follow this plan step by step. Run every
> verification command locally before relying on CI. If a "STOP condition"
> occurs, stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5ee2124..HEAD -- package.json packages/core/package.json packages/converter/package.json`
> Confirm the verification scripts still exist as named below before writing the
> workflow.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (CI no cambia código)
- **Depends on**: plans/009-run-all-core-tests.md (CI debe correr la suite completa)
- **Category**: dx
- **Planned at**: commit `5ee2124`, 2026-06-14

## Why this matters

No existe `.github/workflows/`. Nada corre los tests automáticamente: código
roto puede llegar a `main` sin ninguna señal. Las rutas críticas (deploy,
mapeo de eventos Flue, protocolo WebSocket) no tienen guardián. Un CI que corra
typecheck + tests + build en cada push y PR cierra ese hueco. **Debe ir después
del plan 009**, para que CI corra los 20 tests del core, no 14.

## Current state

- No hay `.github/workflows/` en el repo.
- Monorepo pnpm. `package.json` raíz declara `"packageManager": "pnpm@9.0.0"` y
  `"engines": { "node": ">=22.18" }`.
- Comandos de verificación reales por workspace:
  - `pnpm --filter @inteliside/gateway-core typecheck`
  - `pnpm --filter @inteliside/gateway-core test`
  - `pnpm --filter @inteliside/gateway-converter typecheck`
  - `pnpm --filter @inteliside/gateway-converter test`
  - `pnpm --filter @inteliside/gateway-frontend build`
- El Core importa el converter desde `dist`, así que **el converter debe
  construirse antes de typecheckear/testear el core** (ver `CLAUDE.md`,
  "Dev gotchas": "The Core imports the converter from `dist`").
  Script disponible: `pnpm --filter @inteliside/gateway-converter build`.
- `apps/desktop` (Tauri/Rust) NO se incluye en CI en esta primera versión
  (requiere toolchain Rust; es otro plan).

## Commands you will need

| Purpose            | Command                                              | Expected |
|--------------------|-----------------------------------------------------|----------|
| Install            | `pnpm install --frozen-lockfile`                    | exit 0   |
| Build converter    | `pnpm --filter @inteliside/gateway-converter build` | exit 0   |
| Converter checks   | `pnpm --filter @inteliside/gateway-converter typecheck && pnpm --filter @inteliside/gateway-converter test` | exit 0 |
| Core checks        | `pnpm --filter @inteliside/gateway-core typecheck && pnpm --filter @inteliside/gateway-core test` | exit 0 |
| Frontend build     | `pnpm --filter @inteliside/gateway-frontend build`  | exit 0   |

## Scope

**In scope**:
- `.github/workflows/ci.yml` (crear)
- `package.json` raíz: opcionalmente añadir un script agregador `verify` (ver Step 3)

**Out of scope**:
- CI para `apps/desktop` (Tauri/Rust) — plan futuro.
- Lint/format (es el plan de Biome, separado).
- Publicar paquetes / releases.

## Git workflow

- Branch: `ci/012-github-actions`
- Commit: `ci: add typecheck + test + build workflow`
- No push/PR salvo que el operador lo pida (pero CI solo "vive" al pushear; deja
  claro en el reporte que el workflow no se ejercita hasta el primer push).

## Steps

### Step 1: Validar localmente la secuencia completa

Corre, en este orden, la secuencia que CI replicará:

```
pnpm install --frozen-lockfile
pnpm --filter @inteliside/gateway-converter build
pnpm --filter @inteliside/gateway-converter typecheck
pnpm --filter @inteliside/gateway-converter test
pnpm --filter @inteliside/gateway-core typecheck
pnpm --filter @inteliside/gateway-core test
pnpm --filter @inteliside/gateway-frontend build
```

**Verify**: todos exit 0. Si `--frozen-lockfile` falla, corre `pnpm install`
una vez, commitea el lockfile actualizado, y reintenta.

### Step 2: Escribir `.github/workflows/ci.yml`

Crea el workflow con:
- Trigger: `on: [push, pull_request]`.
- Un job `verify` en `ubuntu-latest`.
- Steps: checkout → `pnpm/action-setup@v4` con version 9 → `actions/setup-node@v4`
  con `node-version: 24` y `cache: pnpm` → `pnpm install --frozen-lockfile` →
  la secuencia del Step 1 (converter build + checks, core checks, frontend build).

Forma objetivo (ajusta versiones de actions a la última estable estable que
resuelva el ejecutor; estas son conocidas-buenas):

```yaml
name: CI
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @inteliside/gateway-converter build
      - run: pnpm --filter @inteliside/gateway-converter typecheck
      - run: pnpm --filter @inteliside/gateway-converter test
      - run: pnpm --filter @inteliside/gateway-core typecheck
      - run: pnpm --filter @inteliside/gateway-core test
      - run: pnpm --filter @inteliside/gateway-frontend build
```

**Verify**: el archivo existe y es YAML válido
(`node -e "require('js-yaml')" ` no está garantizado; basta con revisar a ojo la
indentación o usar `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` si Python está disponible).

### Step 3 (opcional pero recomendado): script `verify` agregador

Añade a `package.json` raíz un script que reproduzca la secuencia, para que un
dev pueda correr `pnpm verify` localmente igual que CI:

```
"verify": "pnpm --filter @inteliside/gateway-converter build && pnpm --filter @inteliside/gateway-converter typecheck && pnpm --filter @inteliside/gateway-converter test && pnpm --filter @inteliside/gateway-core typecheck && pnpm --filter @inteliside/gateway-core test && pnpm --filter @inteliside/gateway-frontend build"
```

**Verify**: `pnpm verify` exit 0.

## Test plan

CI no añade tests; orquesta los existentes. La verificación es que la secuencia
completa pasa localmente (Step 1) y que el workflow está bien formado.

## Done criteria

- [ ] `.github/workflows/ci.yml` existe y dispara en push + pull_request
- [ ] La secuencia del Step 1 pasa localmente, exit 0 en cada comando
- [ ] (Si se hizo Step 3) `pnpm verify` exit 0
- [ ] El workflow corre la suite **completa** del core (verifica que el plan 009
      ya está aplicado: el script `test` del core incluye los 20 archivos)
- [ ] Fila de este plan actualizada en `plans/README.md`

## STOP conditions

- El plan 009 NO está aplicado todavía (el script `test` del core sigue listando
  14 archivos): para y aplica 009 primero, o reporta.
- `--frozen-lockfile` falla y `pnpm install` produce un lockfile con cambios
  grandes inesperados: reporta antes de commitear el lockfile.
- Algún comando de la secuencia falla localmente por un bug real: NO lo
  "arregles" aquí; reporta — CI debe reflejar el estado real.

## Maintenance notes

- Cuando se añada lint (plan de Biome), agregar un step `pnpm lint` al workflow.
- Cuando `apps/desktop` necesite CI, añadir un job aparte con toolchain Rust
  (matriz por OS si se empaqueta para varias plataformas).
- Si el converter deja de necesitar build-antes-de-core (p.ej. si el Core lo
  importa desde `src`), simplificar la secuencia.
