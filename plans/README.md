# Implementation Plans

Plans 001–008 se generaron el 2026-06-12 desde `docs/BACKLOG.md` (secciones
I/J/K). Plans 009–015 se generaron el 2026-06-14 desde una auditoría completa
del repo (commit `5ee2124`). Ejecuta en el orden de abajo salvo que las
dependencias digan otra cosa. Cada ejecutor: lee el plan completo antes de
empezar, respeta sus STOP conditions, y actualiza su fila al terminar.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001 | `sandbox: local()` para agentes Node (I-PR1) | P1 | S | — | DONE — PR #37, live-verified |
| 002 | Stable Flue instanceId por agente (J1) | P1 | S | — | DONE — PR #38, live-verified |
| 003 | Orchestrator robustness (K-PR1) | P1 | M | — | DONE — PR #39, live-verified |
| 004 | Bridge stdio MCP en el contenedor (I-PR2) | P1 | M | 001 | DONE — PR #40, live-verified |
| 005 | Atribución de usage/cost de workflows (K2) | P1 | M | — | DONE — merged PR #44 |
| 006 | Workflow run history (K5/D2) | P1 | M | — | DONE — merged PR #45 |
| 007 | Cap de output de workflows (K3) | P1 | S–M | 005 | DONE — merged PR #46 |
| 008 | Tolerant http-MCP connect (I9) | P2 | S | — | DONE — merged PR #43 |
| 009 | Correr los 20 tests del core (hoy 6 fuera) | P1 | S | — | DONE — `test` corre los **20**; `deploy`+`preflight` arreglados (dummy key + aislamiento de `GATEWAY_DATA_DIR`) |
| 010 | Quitar `express` no usado del core | P2 | S | — | TODO |
| 011 | Botón UI para deploy de memoria compartida (Engram) | P1 | S–M | — | TODO |
| 012 | CI pipeline (GitHub Actions) | P1 | M | 009 | DONE — `.github/workflows/ci.yml` + script raíz `verify`; secuencia validada local (exit 0). No ejercitada hasta el primer push |
| 013 | Test de integración de la Gateway API (WS) | P2 | M | 009 | TODO |
| 014 | Tests unitarios de `SecretsStore` | P2 | S | 009 | TODO |
| 015 | SPIKE: diseño de paridad converter (I-PR3/I-PR4) | P2 | M | — | TODO |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (con razón) | REJECTED (con motivo)

## Orden recomendado para la nueva tanda (009–015)

1. **009** primero (arregla el script de tests) — desbloquea 012/013/014, que
   añaden tests al mismo script.
2. **010** y **011** en paralelo (independientes, alto valor / bajo riesgo).
3. **012** (CI) después de 009 — CI debe correr la suite completa.
4. **013** y **014** (tests nuevos) después de 009; entran en CI vía 012.
5. **015** (spike) cuando se quiera priorizar la paridad del converter; produce
   el diseño de los PRs I-PR3/I-PR4.

## Dependency notes

- **012 depende de 009**: no tiene sentido montar CI que corra 14 de 20 tests.
- **013 y 014 dependen de 009**: ambos insertan su archivo en el script `test`
  del core; 009 normaliza ese script primero (evita conflictos de merge).
- **011 no toca `api.ts`**: los tipos `orgMemory.*` ya existen en el Core y en
  `frontend/src/lib/api.ts`; es UI pura (no aplica la regla #11 de espejar API).
- **015 es spike**: su salida (`docs/converter-parity-design.md`) alimenta dos
  PRs futuros (I-PR3 = I3+I4+I5+I8; I-PR4 = I6+I7), que se planificarán aparte.
- **009 — los 20 tests corren en la suite principal (y en CI)**: durante 009 se
  detectó que `deploy.test.ts` y `preflight.test.ts` fallaban por *setup del
  test* (no por bugs de producción) y se arreglaron en el mismo PR:
  - `deploy.test.ts`: el deployer ganó un guard *fail-fast* (J4) que exige una key
    de proveedor antes de construir; el test ahora inyecta una key dummy con
    `secrets.set` antes del deploy (como `health`/`stop-delete`).
  - `preflight.test.ts`: ahora aísla `GATEWAY_DATA_DIR` a un dir limpio para que el
    check "no API key set" sea determinista (antes leía el `~/.fleet/secrets.json`
    real). No queda ningún `test:integration`.

## Findings considered and rejected (auditoría 2026-06-14)

- **FlueAdapter "promise sin await"** (`adapters/flue.ts`): el código es correcto
  (el try/catch envuelve el for-await; el caller espera `handle.done`). No es bug.
- **Migrar React 19**: ya está en `^19.2.0` estable; no hay migración pendiente.
- **Violación de capas frontend↔core**: no existe; `frontend/src/lib/api.ts` está
  espejado a mano a propósito (CLAUDE.md regla #11). No tocar.
- **"Secretos en stderr de comandos de deploy"**: especulativo. Los secretos se
  pasan por env/stdin (no por args) y las CLIs actuales (fly/wrangler/docker) no
  echan stdin en errores. Hardening defensivo de bajo valor; no se planifica.
- **N+1 en `#connectOrgAgents` / prune** (`core.ts:915`, `org-manager.ts:158,214`):
  real pero de bajo impacto a la escala actual (orgs pequeñas). Vale la pena solo
  si una org llega a decenas/cientos de agentes; no se planifica ahora.

## Refactors grandes diferidos (no planificados — requieren tests primero)

- **`GatewayCore` god-object** (`core.ts`, 1202 líneas): extraer managers
  (deploy/org/session). Requiere characterization tests antes (riesgo HIGH).
- **Duplicación entre los 6 deploy targets** (`flue-deployer.ts`): introducir una
  `DeployStrategy`/`SecretInjector`. Esfuerzo L; hacerlo solo si se añaden más
  targets o cambia el patrón de secretos.

## Direction (opciones de producto, decididas por el dueño)

- **Stop/teardown remoto real** (Fly/Cloudflare): hoy `stopDeployment` es no-op
  para targets remotos (`flue-deployer.ts:684`); el usuario paga infra que no
  puede apagar desde Fleet. Dokploy ya lo tiene. (No planificado aún.)
- **Phase 3 — entrega web** (`apps/web` es solo un package.json): requiere
  decidir antes si el Core es remoto o embebido. Esfuerzo L. (No planificado aún.)
