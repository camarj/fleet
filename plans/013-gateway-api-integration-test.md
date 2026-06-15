# Plan 013: Test de integración de la Gateway API (handshake + request/response sobre WebSocket)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP condition" occurs, stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5ee2124..HEAD -- packages/core/src/server.ts packages/core/src/api.ts`
> If either changed, re-confirm the `startServer` signature and the request/event
> shapes against live code before writing the test.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (solo añade un test)
- **Depends on**: plans/009-run-all-core-tests.md (para que el test nuevo se incluya en la suite)
- **Category**: tests
- **Planned at**: commit `5ee2124`, 2026-06-14

## Why this matters

La frontera entre el frontend y el Core (la Gateway API sobre WebSocket) es el
nervio crítico del sistema, y **no tiene ningún test de integración**. Los tests
de `packages/core/test/` cubren subsistemas (mapeo Flue, deploy, org) por
separado, pero nadie verifica el camino completo: cliente WS → `core.handle()` →
evento emitido de vuelta. Un cambio que rompa el handshake, el routing de
mensajes o el formato de un evento llegaría a producción sin señal. Este test
levanta el server real, conecta un cliente WS y asegura un ciclo
request→response que NO requiere Docker ni un agente desplegado.

## Current state

- `packages/core/src/server.ts` exporta:
  ```ts
  export function startServer(host?, port?, dbPath?): { close: () => Promise<void> }
  ```
  - Honra `GATEWAY_NO_AUTH=1` para saltarse la verificación de token (modo dev/test).
  - Honra `GATEWAY_DB=:memory:` para un store efímero (los tests ya lo usan así).
  - Por cada conexión: parsea cada mensaje como `ClientRequest` y llama
    `core.handle(req, emit)`; `emit` envía `ServerEvent`s como JSON.
- `packages/core/src/api.ts` define `ClientRequest` y `ServerEvent`. Requests que
  NO requieren un agente ni Docker (ideales para este test):
  - `{ type: "agents.list" }` → responde con un evento `{ type: "agents", ... }`.
  - `{ type: "secrets.list" }` → responde con `{ type: "secrets", ... }`.
  - `{ type: "org.status" }` → responde con `{ type: "org.status", bound: false, ... }`
    cuando no hay org vinculada.
  - Un JSON inválido → `{ type: "error", message: "invalid JSON request" }`.
- Cliente WebSocket disponible: el paquete `ws` ya es dependencia de
  `packages/core` (`import WebSocket from "ws"`).
- Estilo de test del repo: archivos `tsx`-ejecutables que lanzan con código ≠ 0
  al fallar una aserción. Usa `node:assert` y `node:test` como hacen los tests
  existentes; **abre `packages/core/test/org.test.ts` y replica su estructura
  exacta** (imports, cómo agrupa casos, cómo asevera).

## Commands you will need

| Purpose          | Command                                                                    | Expected |
|------------------|----------------------------------------------------------------------------|----------|
| Correr este test | `pnpm --filter @inteliside/gateway-core exec tsx test/api-integration.test.ts` | exit 0 |
| Suite completa   | `pnpm --filter @inteliside/gateway-core test`                              | exit 0   |
| Typecheck        | `pnpm --filter @inteliside/gateway-core typecheck`                         | exit 0   |

## Scope

**In scope**:
- `packages/core/test/api-integration.test.ts` (crear)
- `packages/core/package.json` (añadir el archivo al script `test`; ver Depends on)

**Out of scope**:
- No modifiques `server.ts`, `api.ts` ni `core.ts`. Si el test necesita un cambio
  de producción para pasar, es una STOP condition.
- No pruebes `session.start` end-to-end (requiere un agente desplegado/Docker) —
  eso es un test E2E aparte.

## Git workflow

- Branch: `test/013-gateway-api-integration`
- Commit: `test(core): add Gateway API WebSocket integration test`
- No push/PR salvo que el operador lo pida.

## Steps

### Step 1: Escribir el test

Crea `packages/core/test/api-integration.test.ts` siguiendo la estructura de
`org.test.ts`. El test debe:

1. Poner `process.env.GATEWAY_NO_AUTH = "1"` antes de importar/levantar el server.
2. Llamar `startServer("127.0.0.1", <puerto libre>, ":memory:")`. Usa un puerto
   alto poco común (p.ej. 4187) o 0 si el server lo soporta; si 0 no es válido,
   usa un puerto fijo y documenta el supuesto.
3. Abrir un `WebSocket` (del paquete `ws`) a `ws://127.0.0.1:<puerto>`.
4. Caso A — **request válido**: al abrir, enviar `{ type: "agents.list" }`;
   esperar un mensaje y aseverar que `JSON.parse(msg).type === "agents"`.
5. Caso B — **org.status sin vincular**: enviar `{ type: "org.status" }`;
   aseverar `type === "org.status"` y `bound === false`.
6. Caso C — **JSON inválido**: enviar el string `"{ not json"`; aseverar que
   llega `{ type: "error", message: "invalid JSON request" }`.
7. Cerrar el socket y `await server.close()` en un `finally`.

Envuelve la espera de cada respuesta en una promesa con timeout (p.ej. 5s) que
rechace si no llega el evento esperado, para que el test no cuelgue.

**Verify**: `pnpm --filter @inteliside/gateway-core exec tsx test/api-integration.test.ts` → exit 0.

### Step 2: Añadir el test al script `test`

Inserta `tsx test/api-integration.test.ts` en el script `test` de
`packages/core/package.json` (en orden alfabético, junto a los demás).
NOTA: esto asume que el plan 009 ya normalizó el script; coordina con él.

**Verify**: `pnpm --filter @inteliside/gateway-core test` → exit 0, y el nuevo
test aparece en el output.

### Step 3: Typecheck

**Verify**: `pnpm --filter @inteliside/gateway-core typecheck` → exit 0.

## Test plan

- Casos cubiertos por el nuevo test: request válido enrutado y respondido
  (`agents.list`→`agents`), estado por defecto (`org.status`→`bound:false`),
  manejo de entrada malformada (`error`).
- Patrón estructural: `packages/core/test/org.test.ts`.
- Verificación: `pnpm --filter @inteliside/gateway-core test` → todos pasan,
  incluido `api-integration`.

## Done criteria

- [ ] `packages/core/test/api-integration.test.ts` existe y pasa en solitario
- [ ] El test levanta `startServer(..., ":memory:")` con `GATEWAY_NO_AUTH=1`,
      conecta por `ws`, y cubre los 3 casos (A/B/C)
- [ ] El test cierra el server en `finally` (no deja puertos abiertos)
- [ ] Está en el script `test` y `pnpm --filter @inteliside/gateway-core test` pasa
- [ ] `typecheck` exit 0
- [ ] No se modificó código de producción (`server.ts`/`api.ts`/`core.ts`)
- [ ] Fila de este plan actualizada en `plans/README.md`

## STOP conditions

- `agents.list` / `org.status` / el caso de JSON inválido NO se comportan como
  describe "Current state" (drift en `api.ts`/`server.ts`): para y reporta los
  tipos reales.
- El test requiere Docker, red externa o un agente real para pasar: re-evalúa el
  caso elegido (debe ser uno que no lo necesite) o reporta.
- El puerto elegido choca de forma intermitente: cambia a un puerto efímero o
  reporta.

## Maintenance notes

- Cuando exista un test E2E con un agente real (docker-local), `session.start`
  end-to-end iría ahí, no aquí (este test es sin-infra a propósito).
- Si se añade auth obligatoria por defecto, este test seguirá usando
  `GATEWAY_NO_AUTH=1`; un test separado debería cubrir el rechazo 401.
