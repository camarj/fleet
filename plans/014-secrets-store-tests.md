# Plan 014: Tests unitarios para `SecretsStore` (round-trip, no-fuga de valores, persistencia 0600)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP condition" occurs, stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5ee2124..HEAD -- packages/core/src/secrets/store.ts`
> If it changed, compare the API below against the live code before writing tests.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/009-run-all-core-tests.md (para incluir el test en la suite)
- **Category**: tests
- **Planned at**: commit `5ee2124`, 2026-06-14

## Why this matters

`SecretsStore` guarda las API keys de los proveedores (Anthropic, OpenRouter,
Fly, Cloudflare, Dokploy, Engram) en disco. Es código sensible a seguridad y
**no tiene ningún test**. Un fallo en el round-trip (set→get), en la precedencia
o en la garantía de que `list()` NO devuelve valores (solo ids) podría exponer
secretos. Estos son tests baratos de alto valor security-adjacent.

## Current state

`packages/core/src/secrets/store.ts` — API completa (clase `SecretsStore`):

```ts
export class SecretsStore {
  constructor(path?: string)          // default: secretsPath() — para tests, PASA un path temporal
  list(): string[]                    // ids de proveedores con key, ORDENADOS; NUNCA valores
  get(provider: string): string | undefined   // valor; uso server-side
  set(provider: string, apiKey: string): void // apiKey "" => elimina el provider
  delete(provider: string): void
}
```

Comportamiento clave (verificado en el código):
- Persiste en el `path` dado como JSON con permisos `0600` (`#persist`).
- `#load` tolera archivo inexistente (→ `{}`) y JSON corrupto (catch → `{}`).
- `set(p, "")` (apiKey vacío) **borra** el provider en lugar de guardarlo.
- `list()` devuelve `Object.keys(...).sort()` — ids, nunca valores.

Estilo de test del repo: archivos `tsx`-ejecutables con `node:assert` /
`node:test`. Replica la estructura de `packages/core/test/token.test.ts` (test
pequeño y enfocado del repo). Para no tocar el secrets real del usuario, **crea
un path temporal** con `node:os` `tmpdir()` + un nombre único, y bórralo al final.

## Commands you will need

| Purpose          | Command                                                              | Expected |
|------------------|---------------------------------------------------------------------|----------|
| Correr este test | `pnpm --filter @inteliside/gateway-core exec tsx test/secrets.test.ts` | exit 0 |
| Suite completa   | `pnpm --filter @inteliside/gateway-core test`                       | exit 0   |
| Typecheck        | `pnpm --filter @inteliside/gateway-core typecheck`                  | exit 0   |

## Scope

**In scope**:
- `packages/core/test/secrets.test.ts` (crear)
- `packages/core/package.json` (añadir al script `test`)

**Out of scope**:
- No modifiques `store.ts`. Si un test revela un bug real, repórtalo (STOP), no
  lo "arregles" aquí.
- No pruebes la precedencia env-var en `core.ts` (si existe en otra capa) — este
  plan cubre solo `SecretsStore`.

## Git workflow

- Branch: `test/014-secrets-store`
- Commit: `test(core): add SecretsStore unit tests`
- No push/PR salvo que el operador lo pida.

## Steps

### Step 1: Escribir el test

Crea `packages/core/test/secrets.test.ts`. Usa un path temporal único
(`join(tmpdir(), \`fleet-secrets-test-<algo-único>.json\`)`) y construye
`new SecretsStore(tmpPath)`. Cubre estos casos:

1. **Round-trip**: `set("anthropic", "sk-test-123")`, luego `get("anthropic")`
   === `"sk-test-123"`.
2. **`list()` devuelve ids ordenados, no valores**: tras setear `anthropic` y
   `fly`, `list()` === `["anthropic", "fly"]` (ordenado), y `JSON.stringify(list())`
   NO contiene `"sk-test-123"`.
3. **`set(p, "")` borra**: `set("anthropic", "")` → `get("anthropic")` ===
   `undefined` y `"anthropic"` no está en `list()`.
4. **`delete`**: `delete("fly")` → `get("fly")` === `undefined`.
5. **Persistencia entre instancias**: crea una segunda `new SecretsStore(tmpPath)`
   y verifica que `get` recupera lo guardado por la primera.
6. **Permisos 0600** (POSIX): tras un `set`, `statSync(tmpPath).mode & 0o777`
   === `0o600`. (En plataformas sin semántica chmod, este assert puede
   omitirse con un guard `process.platform !== "win32"`.)
7. **Tolerancia a JSON corrupto**: escribe `"{ corrupto"` en el path, crea una
   nueva `SecretsStore(tmpPath)`, y verifica que `list()` === `[]` (no lanza).

Borra el archivo temporal en un `finally`.

**Verify**: `pnpm --filter @inteliside/gateway-core exec tsx test/secrets.test.ts` → exit 0.

### Step 2: Añadir al script `test`

Inserta `tsx test/secrets.test.ts` en el script `test` (orden alfabético).
Coordina con el plan 009.

**Verify**: `pnpm --filter @inteliside/gateway-core test` → exit 0.

### Step 3: Typecheck

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

## Test plan

- Casos: round-trip, list-sin-valores, borrado por string vacío, delete,
  persistencia entre instancias, permisos 0600, tolerancia a corrupción.
- Patrón estructural: `packages/core/test/token.test.ts`.
- Verificación: la suite completa pasa con el nuevo archivo incluido.

## Done criteria

- [ ] `packages/core/test/secrets.test.ts` existe y pasa en solitario
- [ ] Usa un path temporal (NO el secrets real) y lo limpia
- [ ] Cubre los 7 casos del Step 1 (el de permisos puede guardarse tras un
      guard de plataforma)
- [ ] Está en el script `test`; la suite completa pasa
- [ ] `typecheck` exit 0
- [ ] `store.ts` NO modificado
- [ ] Fila de este plan actualizada en `plans/README.md`

## STOP conditions

- `SecretsStore` no acepta un `path` por constructor en el commit que tienes
  (drift): para y reporta.
- El assert de permisos 0600 falla en Linux/macOS (no en Windows): puede ser un
  bug real de `#persist` — repórtalo, no lo ocultes.
- Algún caso revela que `list()` SÍ expone valores: es un hallazgo de seguridad,
  para y reporta de inmediato.

## Maintenance notes

- Si `SecretsStore` migra a un keychain del SO, estos tests deben adaptarse al
  nuevo backend (el comentario en `store.ts` anticipa ese cambio).
- Si se añade precedencia env-var en otra capa, cubrirla con un test aparte.
