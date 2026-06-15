# Plan 010: Eliminar la dependencia `express` no usada de `packages/core`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP condition" occurs, stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5ee2124..HEAD -- packages/core`
> If `packages/core/package.json` changed, re-confirm `express` is still listed
> and still unused before proceeding.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dependencies
- **Planned at**: commit `5ee2124`, 2026-06-14

## Why this matters

`packages/core` declara `express` (`^5.2.1`) y `@types/express` (`^5.0.6`) en
`devDependencies`, pero **el código no importa Express en ninguna parte** — el
Core usa `ws` (WebSocket) directamente (ver `packages/core/src/server.ts`). Una
dependencia sin uso infla `node_modules`, añade superficie de supply-chain (una
CVE de Express afectaría el build aunque no se use) y confunde la intención.

## Current state

- `packages/core/package.json` → `devDependencies` contiene:
  - `"express": "^5.2.1"`
  - `"@types/express": "^5.0.6"`
- `packages/core/src` no tiene ningún `import ... from "express"` ni
  `require("express")` (verificado: 0 coincidencias).
- El servidor real es WebSocket puro: `packages/core/src/server.ts` usa
  `import { WebSocketServer } from "ws"`.

## Commands you will need

| Purpose                | Command                                             | Expected |
|------------------------|-----------------------------------------------------|----------|
| Confirmar no-uso       | `grep -rn "express" packages/core/src`              | 0 líneas |
| Install                | `pnpm install`                                       | exit 0   |
| Typecheck              | `pnpm --filter @inteliside/gateway-core typecheck`  | exit 0   |
| Tests                  | `pnpm --filter @inteliside/gateway-core test`       | exit 0   |
| Build                  | `pnpm --filter @inteliside/gateway-core build`      | exit 0   |

## Scope

**In scope**:
- `packages/core/package.json` (quitar las dos entradas)
- `pnpm-lock.yaml` (se actualiza solo al correr `pnpm install`)

**Out of scope**:
- Cualquier otro workspace. NO toques `frontend`, `converter`, `apps/*`.
- No actualices otras versiones de dependencias "de paso".

## Git workflow

- Branch: `chore/010-remove-unused-express`
- Commit: `chore(core): drop unused express dependency`
- No push/PR salvo que el operador lo pida.

## Steps

### Step 1: Confirmar que `express` no se usa

**Verify**: `grep -rn "express" packages/core/src` → sin coincidencias.
Si aparece **cualquier** import real de express → STOP (el supuesto es falso).

### Step 2: Quitar `express` y `@types/express` de `devDependencies`

Edita `packages/core/package.json` y elimina ambas líneas.

**Verify**: `grep -n "express" packages/core/package.json` → sin coincidencias.

### Step 3: Reinstalar y verificar

```
pnpm install
pnpm --filter @inteliside/gateway-core typecheck
pnpm --filter @inteliside/gateway-core test
pnpm --filter @inteliside/gateway-core build
```

**Verify**: los cuatro comandos exit 0.

## Test plan

No se escriben tests. La verificación es que typecheck + la suite de tests +
build siguen pasando sin express.

## Done criteria

- [ ] `grep -rn "express" packages/core` solo aparece (si acaso) en el lockfile
      como dependencia transitiva de otra cosa, no como dependencia directa
- [ ] `pnpm --filter @inteliside/gateway-core typecheck` exit 0
- [ ] `pnpm --filter @inteliside/gateway-core test` exit 0
- [ ] `pnpm --filter @inteliside/gateway-core build` exit 0
- [ ] Solo `packages/core/package.json` y `pnpm-lock.yaml` modificados
- [ ] Fila de este plan actualizada en `plans/README.md`

## STOP conditions

- `grep` encuentra un import real de express en `src` → el supuesto es falso,
  reporta.
- `pnpm install` falla o el build/typecheck/test rompe tras quitar la dep →
  express podría ser una dependencia transitiva requerida; reporta el error.

## Maintenance notes

- Si en el futuro se añade un servidor HTTP (no solo WS), reconsiderar; pero la
  arquitectura actual es WebSocket puro (`server.ts`).
