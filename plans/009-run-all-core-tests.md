# Plan 009: Todos los tests de `packages/core` se ejecutan (hoy 6 de 20 quedan fuera)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5ee2124..HEAD -- packages/core/package.json packages/core/test`
> If `packages/core/package.json` or any test changed since this plan was
> written, compare the "Current state" excerpts against the live code before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (some excluded tests may need Docker/network and be excluded on purpose)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `5ee2124`, 2026-06-14

## Why this matters

El script `test` de `packages/core` lista **14 archivos a mano**, pero hay
**20 archivos `*.test.ts`** en `packages/core/test/`. Seis tests están escritos
pero **nunca se ejecutan** — dan una falsa sensación de cobertura y no protegen
contra regresiones. Cuando montemos CI (plan 012), debe correr la suite
completa, no 14 de 20. Este plan hace que todos los tests corran (o, si alguno
requiere Docker/red, lo separa explícitamente en una suite aparte documentada).

## Current state

- `packages/core/package.json` — el script `test` (una sola línea) encadena con
  `&&` exactamente estos 14 archivos:
  `flue, session-history, deploy-log-db, flue-instance-id, failed-deploy-log,
  model-override, orchestrator, workflow, token, dokploy, engram-server-deployer,
  pricing, usage-summary, org`.
  Cada uno se corre como `tsx test/<name>.test.ts`.
- Los **20** archivos reales en `packages/core/test/` son:
  `deploy-log-db, deploy-log, deploy, dokploy, engram-server-deployer,
  failed-deploy-log, flue-instance-id, flue, health, model-override,
  orchestrator, org, preflight, pricing, session-history, stop-delete, token,
  usage-summary, workflow-output-cap, workflow`.
- **Los 6 que faltan en el script**: `deploy-log`, `deploy`, `health`,
  `preflight`, `stop-delete`, `workflow-output-cap`.
- Runtime: Node ≥22.18 (CI usa Node 24), pnpm 9.0.0, runner = `tsx` (cada test
  es un archivo ejecutable, no usa un framework con auto-discovery).
- Convención de tests: cada `test/*.test.ts` se ejecuta de forma independiente
  con `tsx` y sale con código ≠ 0 si una aserción falla (ver `test/flue.test.ts`
  como ejemplo del estilo).

## Commands you will need

| Purpose         | Command                                                | Expected on success |
|-----------------|--------------------------------------------------------|---------------------|
| Install         | `pnpm install`                                         | exit 0              |
| Un test suelto  | `pnpm --filter @inteliside/gateway-core exec tsx test/<name>.test.ts` | exit 0 |
| Suite completa  | `pnpm --filter @inteliside/gateway-core test`          | exit 0, todos pasan |
| Typecheck       | `pnpm --filter @inteliside/gateway-core typecheck`     | exit 0              |

## Scope

**In scope**:
- `packages/core/package.json` (solo el/los script(s) de test)

**Out of scope** (NO tocar):
- El contenido de cualquier `test/*.test.ts` — este plan no corrige tests, solo
  los hace correr. Si un test falla por un bug real, es una STOP condition.
- Migrar a un test runner (Vitest/node:test): fuera de alcance, es otro plan.

## Git workflow

- Branch: `test/009-run-all-core-tests`
- Conventional commits, p.ej. `test(core): run all 20 core test files`
- No hagas push ni abras PR salvo que el operador lo pida.

## Steps

### Step 1: Verificar individualmente los 6 tests excluidos

Corre **uno por uno** los 6 que hoy no están en el script:

```
pnpm --filter @inteliside/gateway-core exec tsx test/deploy.test.ts
pnpm --filter @inteliside/gateway-core exec tsx test/deploy-log.test.ts
pnpm --filter @inteliside/gateway-core exec tsx test/health.test.ts
pnpm --filter @inteliside/gateway-core exec tsx test/preflight.test.ts
pnpm --filter @inteliside/gateway-core exec tsx test/stop-delete.test.ts
pnpm --filter @inteliside/gateway-core exec tsx test/workflow-output-cap.test.ts
```

Clasifica cada uno:
- **(A) Pasa sin dependencias externas** (no requiere Docker, ni red, ni un
  binario como `gh`/`docker`/`fly`): va a la suite principal.
- **(B) Requiere Docker/red/binario externo o es lento/flaky**: NO va a la suite
  principal; va a una suite `test:integration` separada (Step 3).

**Verify**: cada comando termina (no cuelga). Anota el código de salida y si
imprimió errores de "docker not found", timeouts de red, etc.

### Step 2: Reescribir el script `test` con los archivos de categoría (A)

Reemplaza la línea `test` de `packages/core/package.json` para que incluya
**todos** los archivos de categoría (A) — es decir, los 14 actuales más los
excluidos que pasaron limpios. Mantén el patrón `tsx test/<name>.test.ts && …`
en orden alfabético para que el diff sea estable y nadie vuelva a olvidar uno.

Si TODOS los 6 son categoría (A), el script final corre los 20.

**Verify**: `pnpm --filter @inteliside/gateway-core test` → exit 0, y el output
muestra que corrieron N archivos (N = 14 + los reincorporados).

### Step 3 (solo si hubo tests categoría B): añadir script `test:integration`

Si algún test es categoría (B), añade un script separado en
`packages/core/package.json`:

```
"test:integration": "tsx test/<B-name>.test.ts && …"
```

y un comentario en `plans/README.md` (sección Dependency notes) explicando qué
requiere (Docker, etc.) y por qué no corre en CI por defecto.

**Verify**: `pnpm --filter @inteliside/gateway-core run test:integration`
existe como script (no lo ejecutes en este plan si requiere Docker que no tienes).

### Step 4: Typecheck

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

## Test plan

Este plan no escribe tests nuevos; activa los existentes. La verificación es que
`pnpm --filter @inteliside/gateway-core test` corre estrictamente más archivos
que antes y todos pasan.

## Done criteria

ALL must hold:

- [ ] `pnpm --filter @inteliside/gateway-core test` exits 0
- [ ] El script `test` incluye todos los tests de categoría (A); ningún archivo
      `test/*.test.ts` de categoría (A) queda fuera
      (compara: `ls packages/core/test/*.test.ts` vs los nombres en el script)
- [ ] Si hubo tests (B): existe `test:integration` y está documentado en
      `plans/README.md`
- [ ] `pnpm --filter @inteliside/gateway-core typecheck` exits 0
- [ ] Solo `packages/core/package.json` modificado (`git status`)
- [ ] Fila de este plan actualizada en `plans/README.md`

## STOP conditions

Para y reporta (no improvises) si:

- Un test excluido **falla por un bug real del código** (no por falta de Docker):
  significa que hay una regresión oculta — repórtala con el output, no la
  "arregles" en este plan.
- Más de 2 de los 6 tests requieren Docker/red: puede que el split correcto sea
  distinto — reporta tu clasificación y pide confirmación.
- El script `test` ya fue migrado a un runner con auto-discovery desde el commit
  planeado (drift): re-evalúa, este plan podría ser innecesario.

## Maintenance notes

- Cuando se añadan tests nuevos, deben aparecer en el script (o, idealmente, un
  plan futuro migra a un runner con auto-discovery — Vitest o `node --test` con
  glob — para eliminar la lista manual de raíz).
- El plan 012 (CI) asume que `pnpm --filter @inteliside/gateway-core test` corre
  la suite completa. Este plan es su prerrequisito.
