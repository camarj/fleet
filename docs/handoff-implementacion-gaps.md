# Handoff de implementación — Gaps + Orquestador Visual

> **Para agentes implementadores.** Este documento contiene TODAS las decisiones
> de arquitectura ya tomadas. Tu trabajo es planificar en detalle e implementar
> las unidades de trabajo (WU) en el orden indicado. **No tomes decisiones de
> arquitectura nuevas**: si algo no está especificado acá ni en `CLAUDE.md` ni
> en las skills, PARÁ y preguntá.
>
> Fecha: 2026-06-09 · Rama base: `feat/flue-migration` (PR #1)
> Contexto previo: `docs/handoff-flue-integration.md` (plan Flue) y
> `docs/analisis-gaps-2026-06-09.md` (análisis que origina este plan).

---

## Estado / Progreso (actualizado 2026-06-10)

| Fase | Estado | WUs | Notas |
| --- | --- | --- | --- |
| F0 Persistencia | ✅ DONE (merged) | WU-01 | DB a archivo `fleet.db` |
| F1 Ciclo de vida | ✅ DONE (merged, verificado en app) | WU-02..05 | stop/delete, health+reconnect, offline guard, connect-by-URL |
| F2 Día 2 | ✅ DONE (merged, verificado en app) | WU-06..09 | historial, preflight, banner, deploy logs |
| F3 API honesta + converter | ✅ DONE (merged PR #8) | WU-10 ✅, WU-11 ✅ | config→redeploy honesto; deploy.unmapped + settings.local/env |
| F4 Verificar targets en vivo | 🔒 bloqueado | WU-12..15 | necesita FLY/CLOUDFLARE tokens + Coolify/Dokploy |
| F5 Orquestador visual | ✅ DONE (merged PR #9) | WU-16..19 | motor DAG + API + canvas React Flow; smoke en vivo |
| F6 Hardening | ⏳ SIGUIENTE | WU-20..23 | WS auth, a11y, shutdown sidecar, multi-conversación |

> Nota histórica: F0–F2 mergeadas vía PR #3 (`4b315e3`) + PR #4 (docs); PR #1/#2
> trajeron la migración Flue. Las ramas nuevas salen siempre de `main`.

---

## 🔖 ESTADO DE SESIÓN — para continuar (cierre 2026-06-10)

**Todo F0–F5 está mergeado en `main`.** El proyecto Fleet tiene: persistencia,
control de ciclo de vida, día-2 (historial/preflight/banner/logs), API honesta
(modelo vía redeploy + aviso de features no convertibles), y el **orquestador
visual completo** (motor DAG en el Core + canvas React Flow para editar/correr
workflows). `main` HEAD ≈ PR #9 merge (`b7b9402`).

### Qué se hizo esta sesión
1. **Supervisión F0–F2** (PR #5): auditoría adversarial + 4 fixes (carrera de
   adapter en health/reconnect, catch de migraciones, gate de preflight,
   modal de deploy-log colgado).
2. **F3 / WU-10** (PR #6→#8): override de modelo HONESTO. `config.updated` lleva
   `requiresRedeploy`; `agent.redeploy` aplica el override; `AgentSummary.model`
   ahora deriva del deploy real (antes SIEMPRE era `""` para Flue). Modal
   "Configure" por agente + `ModelPicker` compartido.
3. **F3 / WU-11** (PR #7→#8): `deploy.unmapped` (hooks/MCP stdio/permissions) con
   warning expandible en el wizard y el redeploy; converter lee
   `settings.local.json` y vuelca `env` a `.env.example` (solo NOMBRES, regla #8).
4. **F5 / WU-16..19** (PR #9): motor de orquestación DAG, persistencia + API,
   y el canvas React Flow (`@xyflow/react` 12). Smoke en vivo OK.

### Verificado / pendiente de verificar
- F3 WU-10/11: gates verdes + smoke. **Pendiente del usuario**: probar en la app
  cambiar modelo → redeploy → confirmar que el agente corre el modelo nuevo.
- F5: gates verdes + smoke en vivo del canvas (render, nodos, inspector,
  validación). **Pendiente del usuario**: correr un workflow real con ≥1 agente
  vivo de punta a punta (no se automatizó para no gastar tokens del usuario).

### Próximos pasos (en orden sugerido)
1. **F6 Hardening** (no bloquea nada, no necesita credenciales) — WU-20..23, §8.
   Buen candidato para la próxima sesión.
2. **F4 Verificación de targets en vivo** — cuando el usuario tenga
   `FLY_API_TOKEN` / `CLOUDFLARE_API_TOKEN` y un Coolify/Dokploy. §6.

### Decisiones/contexto que la próxima sesión debe saber
- **F5 input nodes**: el handoff usa `{{input.X}}` pero `WorkflowNode` no tenía
  cómo nombrar el parámetro → se agregó `name?` a los nodos `input` (la clave del
  run-input). Si se quiere otro modelo de inputs, solo cambia la resolución en
  `packages/core/src/orchestration/index.ts`.
- **F5 runner**: el adapter Flue solo emite `message.delta` (no
  `message.completed`); el runner del Core acumula deltas para el texto final.
- **GOTCHA de PRs stackeados** (nos mordió con #6/#7): si stackeás PRs (base de B
  = rama de A), mergeá de ABAJO hacia arriba y RE-TARJETEÁ la base del de arriba a
  `main` antes de mergear, o GitHub lo mergea en una rama huérfana. F5 se hizo
  como UNA sola PR justo para evitar esto.
- Limitaciones v1 ya registradas más abajo (WU-09 error-log, preflight wrangler,
  findCfOutputDir `.json` vs `.jsonc`, refresco de sesiones tras reconexión,
  merge shallow de `env`, MCP stdio solo-reportado).

### Revisión de supervisión F0–F2 (2026-06-09)

Auditoría adversarial (Core + Frontend) de WU-01..09 contra esta spec.
**Veredicto: implementación fiel, sin bugs críticos.** El espejo de tipos
core↔frontend está intacto (única diferencia intencional: `local-process`
no se expone en la UI). Se corrigieron 4 hallazgos en la rama
`fix/f0-f2-review-findings`:

1. **WU-03**: carrera entre `#reconnectPersisted()` y `#healthTick()` podía
   filtrar un `FlueAdapter` duplicado — guard post-`await` en ambos lados.
2. **db.ts**: el catch de migraciones tragaba CUALQUIER error; ahora solo
   "duplicate column name" se trata como ya-aplicada, el resto se relanza.
3. **WU-07**: el botón Deploy no se deshabilitaba mientras el preflight
   cargaba (`preflightChecks === null`) — gate bypasseable.
4. **WU-09**: un `error` del Core a `deploy.lastLog` dejaba el modal en
   "Loading…" para siempre — ahora se muestra el error en el modal.

**Limitaciones conocidas registradas (NO bloquean F3)** — ver notas
agregadas en F4/F6:

- WU-09: si un PRIMER deploy falla antes de registrar el agente, el log de
  error se descarta (no hay fila a la cual asociarlo). Aceptado en v1.
- WU-10 (hecho, rama `feat/wu-10-model-override`, stacked sobre los fixes):
  el supuesto del handoff de que `AgentSummary.model` reflejaba el modelo
  corriente era FALSO (siempre `""` para Flue). Se corrigió: `AgentSummary.model`
  ahora se deriva de la tabla `deploys` (`provider/model`). `config.updated`
  lleva `requiresRedeploy`; `agent.redeploy` aplica el override de config; se
  quitó el override muerto de `session.start`. Falta verificación en vivo
  (cambiar modelo → redeploy → el agente corre el modelo nuevo) — es el
  criterio de aceptación manual, cubierto por WU-15 cuando haya credenciales,
  o con un docker-local local.
- WU-11 (hecho, rama `feat/wu-11-unmapped-report`, stacked sobre WU-10):
  `ConvertReport.unmapped` pasó de `string[]` a `{kind,name,reason}[]`; el Core
  emite `deploy.unmapped` y el wizard/redeploy lo muestran como warning
  expandible (no bloquea). Plus converter: lee `.claude/settings.local.json`
  (merge shallow sobre `settings.json`) y vuelca la sección `env` a
  `.env.example` **solo los NOMBRES** (regla #8, nunca valores). Limitaciones
  registradas: el merge de `env` es shallow (si ambos archivos tienen `env`, el
  local reemplaza al base — no se combinan); MCP stdio sigue solo-reportado.
- Preflight `cloudflare`: `checkWrangler()` siempre devuelve ok (el deployer
  auto-instala wrangler vía npm); no avisa si npm falta.
- `findCfOutputDir()` busca `wrangler.json` (no `.jsonc`) en el output de
  `flue build` — verificar en WU-13 contra el output real.
- Frontend: el historial de sesiones no se refresca tras reconexión para el
  agente ya seleccionado (solo on-select) — cubrir en WU-23.
- `App.tsx` (`agent.removed`): `setSelectedId` anidado dentro del updater de
  `setAgents` — inofensivo con StrictMode off, limpiar en F6 (WU-21).

---

## 0. Reglas de juego (leer SIEMPRE antes de cualquier WU)

1. **Leé `CLAUDE.md` del repo completo.** Sus reglas son no negociables:
   el Core solo habla con agentes vía `FlueAdapter`; el frontend solo habla
   con el Core por WebSocket (Gateway API); `neutral.ts` es el protocolo
   propio; nunca inventes wire de Flue (verificá contra `@flue/sdk`/`@flue/cli`
   o la skill `flue-client`); secrets solo en env vars/secure store.
2. **Skills**: cargá la skill que corresponda antes de tocar su área —
   `adapter-interface`, `flue-client`, `transcript-panel`, `react-flow-canvas`,
   `tauri-shell-sidecar`.
3. **Gotcha de dev (te va a morder si lo ignorás)**: el Core importa el
   converter desde `dist`. Tras cambiar `packages/converter` corré
   `pnpm --filter @inteliside/gateway-converter build` Y reiniciá el Core.
4. **Gates de verificación** (correr antes de declarar terminado un WU):
   ```
   pnpm --filter @inteliside/gateway-core test
   pnpm --filter @inteliside/gateway-core typecheck
   pnpm --filter @inteliside/gateway-converter test
   pnpm --filter @inteliside/gateway-frontend build
   ```
5. **PRs**: conventional commits, sin atribución a IA. Cada WU ≈ un PR
   revisable (~400 líneas máx). Si un WU se pasa, dividilo en commits de
   unidades de trabajo y avisá.
6. **Tipos espejo**: cada cambio en `packages/core/src/api.ts` se espeja a
   mano en `frontend/src/lib/api.ts`. Si tocás uno, tocás el otro.
7. **Idioma de artefactos**: código, comentarios, strings de UI y commits en
   **inglés**. Docs de handoff en español.

---

## 1. Orden de prioridades (decisión de arquitectura — no reordenar)

| Fase | Tema | WUs | Por qué este orden |
| --- | --- | --- | --- |
| F0 | Persistencia real | WU-01 | Todo lo demás se apoya en que Fleet recuerde |
| F1 | Control del ciclo de vida | WU-02…05 | Un ops center debe poder apagar/conectar lo que opera |
| F2 | Día 2 del usuario | WU-06…09 | Historial, preflight, errores visibles |
| F3 | API honesta + converter | WU-10…11 | Eliminar promesas falsas antes de construir encima |
| F4 | Verificación de targets en vivo | WU-12…15 | **Track paralelo** — corre cuando haya credenciales; no bloquea F2-F5 |
| F5 | Orquestador visual | WU-16…19 | Necesita F0 (persistir workflows) y F1 (agentes vivos/confiables) |
| F6 | Hardening | WU-20…23 | Pre-web y pulido; no bloquea nada anterior |

**Regla de dependencia**: F0 → F1 → F2 → F3 → F5 en serie. F4 puede
intercalarse en cualquier momento con credenciales. F6 al final o como relleno.

---

## 2. FASE 0 — Persistencia

### WU-01 — SQLite a archivo (sacar `:memory:`)

- **Problema**: `packages/core/src/server.ts` defaultea `GATEWAY_DB` a
  `:memory:`. Reiniciar el Core borra agentes, params de redeploy, sesiones
  y usage.
- **Decisión**: el default pasa a ser un archivo en el data dir que ya
  resuelve `packages/core/src/paths.ts` (respeta `GATEWAY_DATA_DIR`).
  Nombre: `fleet.db`. `:memory:` queda disponible solo si se pide explícito
  por env var (los tests lo usan).
- **Tocar**: `server.ts`, `paths.ts` (agregar `dbPath()` si no existe),
  ningún cambio de schema.
- **Al arrancar el Core**: los agentes persistidos se listan con
  `online: false` (los adapters viven en memoria; la reconexión automática
  es WU-03 — acá NO la implementes).
- **Aceptación**: deployar un agente → reiniciar Core → `agents.list`
  devuelve el agente (offline) y conserva `redeployable: true`. Tests verdes
  sin tocar (siguen usando `:memory:` explícito).

---

## 3. FASE 1 — Control del ciclo de vida

### WU-02 — API y Core: stop / delete

- **Decisión de contrato** (`packages/core/src/api.ts` + espejo frontend):
  ```ts
  // ClientRequest +
  | { type: "agent.stop"; agentId: string }     // stop runtime, keep registration
  | { type: "agent.delete"; agentId: string }   // stop + remove registration & deploy params
  // ServerEvent +
  | { type: "agent.updated"; agent: AgentSummary }  // e.g. went offline after stop
  | { type: "agent.removed"; agentId: string }
  ```
- **Semántica**:
  - `agent.stop`: si el deploy fue `docker-local` → `docker rm -f fleet-<name>`;
    si `local-process` → kill del proceso. Para targets remotos (fly/cloudflare)
    en v1 solo desconecta el adapter (no destruye infra remota) y lo marca
    offline — documentalo en el comment del handler. Cierra el adapter
    (`#agents.delete`) y aborta sesiones vivas de ese agente.
  - `agent.delete`: `agent.stop` + borra filas de `agents` (el ON DELETE
    CASCADE limpia configs/deploys/sessions/usage).
- **Tocar**: `api.ts`, `core.ts` (handlers + helper compartido con el cleanup
  que ya hace shutdown), `deploy/flue-deployer.ts` (extraer/exponer
  `stopDeployment(agentName, target)` reutilizando la lógica que ya existe
  para reemplazar contenedores en redeploy), `state/db.ts` (`deleteAgent`).
- **Aceptación**: test en `packages/core/test/` que deploya con
  `local-process`, hace `agent.stop` (proceso muere, agente queda offline,
  sigue en `agents.list`) y luego `agent.delete` (desaparece de la lista).

### WU-03 — Health monitor + reconexión al arrancar

- **Decisión**: el Core corre un loop de health cada **15 s** por agente
  registrado con `sourceRef` (base URL): HTTP GET a la raíz del agente con
  timeout 3 s (mismo criterio 2xx-3xx que `waitReady` en
  `flue-deployer.ts`). Cambio de estado → emitir `agent.updated`.
- **Reconexión**: al construir `GatewayCore`, por cada agente persistido
  intenta `connectFlue(sourceRef)` una vez; si responde, adapter vivo y
  `online: true`; si no, queda offline y el health loop lo levanta cuando
  vuelva.
- **Anti-spam**: emitir `agent.updated` SOLO en transiciones de estado, no
  en cada tick.
- **Tocar**: `core.ts` (loop con `setInterval`, limpiarlo en `shutdown()`),
  sin cambios de schema.
- **Aceptación**: test con `local-process` — matar el proceso a mano →
  en ≤20 s el agente pasa a offline y se emite `agent.updated`; relanzar →
  vuelve a online.

### WU-04 — Frontend: guard de offline + acciones stop/delete

- `TerminalPanel.tsx`: `submit()` debe rechazar si `!agent.online`; en su
  lugar render de banner dentro del panel: "This agent is offline." con
  botón **Redeploy** (si `redeployable`) que dispara el flujo existente de
  `agent.redeploy`.
- `Sidebar.tsx`: por agente, además de ↻ Redeploy, acciones **Stop** y
  **Delete**. Delete pide confirmación (modal `Modal.tsx` existente,
  `dismissable`). Manejar `agent.updated`/`agent.removed` en `App.tsx`
  (upsert ya existe; agregar remove).
- **Aceptación**: build del frontend verde; con un agente offline el input
  queda deshabilitado y el banner aparece; delete saca el agente de la lista.

### WU-05 — UI para conectar un agente existente (`agent.connectFlue`)

- El request YA existe en la API — esto es solo frontend.
- **Decisión de UX**: botón "Connect agent" en el Sidebar junto a
  "+ Deploy agent". Abre modal simple (no wizard): campos Base URL
  (requerido), Agent name (requerido), Token (opcional, password input).
  Submit → `agent.connectFlue`; éxito llega como `agent.registered` (ya
  manejado); error como `error` → mostrarlo en el modal, no en el terminal.
- **Tocar**: `frontend/src/components/` (nuevo `ConnectAgent/`),
  `Sidebar.tsx`, `App.tsx`.
- **Aceptación**: levantar un agente Flue local a mano (o con
  `local-process`) y conectarlo por URL desde el modal; aparece en el sidebar
  online y se puede chatear.

---

## 4. FASE 2 — Día 2 del usuario

### WU-06 — Historial de sesiones (persistir y releer transcripts)

- **Problema**: los `RunEvent` no se guardan; el transcript vive en
  `useState` y se borra al cambiar de agente o reiniciar.
- **Decisión de schema** (`state/db.ts`):
  ```sql
  CREATE TABLE IF NOT EXISTS session_events (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  ```
  Guardar cada `RunEvent` que el Core ya relaya en `session.event` (mismo
  lugar donde incrementa `seq`). Son JSON pequeños; no optimizar todavía.
- **Decisión de contrato**:
  ```ts
  // ClientRequest +
  | { type: "sessions.list"; agentId: string }                  // most recent first
  | { type: "session.history"; sessionId: string }
  // ServerEvent +
  | { type: "sessions"; agentId: string; sessions: SessionSummary[] }
  | { type: "session.history"; sessionId: string; events: RunEvent[]; usage: Usage | null }
  ```
  `SessionSummary = { id, status, startedAt, endedAt, preview }` — preview =
  primeros 80 chars del primer mensaje user (extraerlo del primer
  `message.completed` role user, o del texto enviado en `session.start`,
  guardándolo en `sessions` como columna `preview`).
- **Frontend**: al seleccionar agente, pedir `sessions.list`; si hay una
  sesión previa, cargar la última con `session.history` y reconstruir los
  blocks con el MISMO reducer que usa el streaming (refactorizar el switch
  de eventos de `TerminalPanel.tsx` a una función pura
  `applyEvent(blocks, event)` reutilizable). Botón "New conversation"
  limpia el panel y arranca sesión nueva al enviar.
- **Aceptación**: chatear → reiniciar app (no el Core) → reabrir: el
  transcript anterior se ve. Test de core para `sessions.list`/`session.history`.

### WU-07 — Preflight de deploy

- **Decisión de contrato**:
  ```ts
  // ClientRequest +
  | { type: "deploy.preflight"; provider?: string; model?: string; target: DeployTarget }
  // ServerEvent +
  | { type: "deploy.preflight"; checks: PreflightCheck[] }
  // PreflightCheck = { id: "docker" | "apiKey" | "cli"; label: string; ok: boolean; detail?: string }
  ```
- **Checks por target** (implementar en `deploy/flue-deployer.ts` como
  `preflight(req)` reutilizando lo que ya existe):
  - `docker-local`: `docker info` sale 0 (daemon corriendo).
  - `fly`: `flyctl version` disponible + `FLY_API_TOKEN`/secret presente.
  - `cloudflare`: `wrangler --version` + `CLOUDFLARE_API_TOKEN`.
  - `github`: `git --version` + `gh auth status` (o token).
  - Todos: API key del proveedor derivado del specifier — reutilizar el
    guard que ya existe (`secrets.get(provider) ?? process.env[apiKeyEnv]`),
    `github` exento (igual que hoy).
- **Wizard**: en el paso Review, correr preflight al entrar y render de
  checklist (✓/✗ + detail). Botón Deploy deshabilitado si hay ✗, con el
  motivo visible. Un botón "Re-check".
- **Aceptación**: con Docker apagado, el wizard muestra ✗ y no deja
  deployar; prenderlo + Re-check → ✓ y deja pasar.

### WU-08 — Estado de conexión visible (banner global)

- **Decisión**: banner fijo arriba del `main` cuando `connected === false`:
  "Reconnecting to Fleet Core…" (el cliente ya reintenta solo). Sin sistema
  de toasts en v1 — un solo banner, nada de dependencias nuevas.
- Deshabilitar input del terminal y botones de acción mientras no haya
  conexión (hoy algunos ya lo hacen — completar los que falten).
- **Aceptación**: matar el Core con la app abierta → banner aparece;
  relanzar Core → banner desaparece y las listas se refrescan (ya existe el
  re-fetch on reconnect).

### WU-09 — Persistir logs de deploy

- **Decisión**: columna `log` TEXT en la tabla `deploys` (se sobreescribe
  por deploy — historial de UN log por agente alcanza en v1). El Core
  acumula las líneas que ya streamea en `deploy.log` y las guarda al
  terminar (éxito o error).
- **Contrato**: `{ type: "deploy.lastLog"; agentId: string }` →
  `{ type: "deploy.lastLog"; agentId: string; log: string | null }`.
- **UI**: en el Sidebar, acción "View last deploy log" por agente →
  modal con `<pre>` scrolleable (reusar el estilo del log del wizard).
- **Aceptación**: deployar, cerrar el modal, abrir "View last deploy log" →
  se ve el log completo. Sobrevive reinicio del Core (WU-01).

---

## 5. FASE 3 — API honesta + converter transparente

### WU-10 — Resolver el override de modelo (config.set)

- **Problema**: `config.set` y `RunOptions.model` no tienen efecto real —
  Flue fija el modelo al convertir (`flue.ts:93` lo documenta). La API
  promete lo que el wire no cumple.
- **Decisión**: el camino honesto es **config → redeploy**. Implementar:
  1. `config.set` guarda el override (ya lo hace) y responde
     `config.updated` con un campo nuevo `requiresRedeploy: boolean`
     (true si el specifier difiere del modelo corriente del agente).
  2. Si el agente es `redeployable`, el flujo de `agent.redeploy` debe
     **aplicar el override de config** (pasar el specifier de la config como
     `provider`/`model` al `#runDeploy` en lugar de los params originales,
     actualizando la tabla `deploys`).
  3. Quitar `model` de `RunOptions` en el camino de `session.start`
     (frontend ya no lo manda; limpiar `modelOverride` del request
     `session.start` en ambos `api.ts` — dejar `ModelOverride` solo para
     config). Eliminar el parámetro muerto `_options.model` de
     `FlueAdapter.run` si queda sin uso.
- **UI**: panel de config por agente (modal desde el Sidebar): specifier
  (mismos dropdowns provider/model del wizard — extraer a componente
  compartido `ModelPicker`), y si `requiresRedeploy` → CTA "Redeploy to
  apply".
- **Aceptación**: cambiar modelo de un agente docker-local → badge/CTA →
  redeploy → el agente corre con el modelo nuevo (verificable preguntándole
  al agente qué modelo es, o por el specifier en `AgentSummary.model`).

### WU-11 — Aviso de features no convertibles en el wizard

- **Problema**: el converter manda a `unmapped[]` (hooks, permissions, MCP
  stdio, etc.) y el usuario nunca lo ve.
- **Decisión**: `agent.deployFlue` ya corre la conversión en el Core; el
  resultado del converter incluye `unmapped`. Emitir tras convertir:
  ```ts
  | { type: "deploy.unmapped"; items: { kind: string; name: string; reason: string }[] }
  ```
  El wizard lo muestra en el área de progreso como warning expandible
  ("This agent loses N features when converted: …"). NO bloquea el deploy.
- **Plus converter (alcance acotado)**: leer también
  `.claude/settings.local.json` (merge sobre settings.json) y extraer la
  sección `env` de settings hacia `.env.example` del proyecto emitido.
  Los MCP stdio siguen sin convertirse en v1 — solo se REPORTAN.
- **Aceptación**: fixture de converter con hooks + MCP stdio → el deploy
  los reporta en `deploy.unmapped` y el wizard los muestra. Tests del
  converter actualizados (determinismo intacto).

---

## 6. FASE 4 — Verificación de targets en vivo (track paralelo)

> Estos WUs son **runbooks de verificación**, no desarrollo. Requieren
> credenciales del usuario — pedirlas explícitamente antes de empezar y NUNCA
> persistirlas en el repo. Si algo falla, el fix probablemente toca
> `flue-deployer.ts` o `emit.ts`; aplicar el gotcha del converter (§0.3).

- **WU-12 — Fly.io**: `FLY_API_TOKEN` en Settings → deploy target `fly` →
  agente responde en `*.fly.dev` → conectar y chatear → stop/delete (nota:
  v1 no destruye infra remota — verificar que el comportamiento documentado
  en WU-02 se cumple).
- **WU-13 — Cloudflare**: `CLOUDFLARE_API_TOKEN` → target `cloudflare` →
  worker desplegado → chat E2E. Cuidado: nunca inventar wire CF de Flue;
  ante cualquier discrepancia, verificar contra `@flue/cli` instalado.
  **Verificar también**: `findCfOutputDir()` en `flue-deployer.ts` busca
  `wrangler.json` (no `.jsonc`) en el output de `flue build --target
  cloudflare` — si el build emite `.jsonc`, el deploy CF falla con error
  confuso; corregir ahí.
- **WU-14 — GitHub → Coolify/Dokploy**: target `github` → repo publicado →
  deploy manual en Coolify/Dokploy → conectar por URL con WU-05 (acá se
  prueba el valor real de "Connect agent").
- **WU-15 — Provider/model swap real**: mismo agente fuente deployado con
  anthropic y luego openai o google (usa WU-10): ambos responden.
- **Cierre de fase**: actualizar `docs/handoff-flue-integration.md` con el
  resultado de cada verificación (verificado ✓ / falló + fix).

---

## 7. FASE 5 — Orquestador visual (decisiones cerradas)

> El seam ya existe: `packages/core/src/orchestration/index.ts` define
> `Workflow{Node,Edge}` y `Orchestrator.run()` (hoy rechaza). El canvas stub
> está en `frontend/src/components/WorkflowCanvas/`. Skill: `react-flow-canvas`.

### Decisiones de arquitectura v1 (NO ampliar el alcance)

1. **Modelo**: un workflow es un **DAG sin ciclos, sin condicionales, sin
   loops**. Tipos de nodo: `input` (parámetros del run), `agent` (agentId +
   prompt template), `output` (qué se devuelve). Extender los tipos del
   skeleton:
   ```ts
   export type NodeKind = "input" | "agent" | "output";
   export interface WorkflowNode {
     id: string;
     kind: NodeKind;
     agentId?: string;          // kind === "agent"
     promptTemplate?: string;   // kind === "agent"; supports {{input.X}} and {{<nodeId>.output}}
     position: { x: number; y: number };  // canvas layout, persisted
   }
   ```
2. **Ejecución**: orden topológico; un nodo corre cuando TODAS sus
   dependencias terminaron; nodos independientes corren en paralelo. Nodo
   `agent` = interpolar template → `session.start` contra ese agente vía el
   flujo existente del Core → su output es el texto del último
   `message.completed` del assistant. Falla de un nodo → todo el run falla
   (`failed`), los nodos en vuelo se abortan. Sin retries en v1.
3. **El frontend NUNCA ejecuta nada**: el engine vive en el Core
   (`orchestration/`), el canvas solo edita y visualiza (regla #2 de
   CLAUDE.md aplica igual acá).
4. **Persistencia**: tablas nuevas en `db.ts`:
   ```sql
   CREATE TABLE IF NOT EXISTS workflows (
     id         TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     graph_json TEXT NOT NULL,   -- {nodes, edges} completo, posiciones incluidas
     updated_at TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS workflow_runs (
     id          TEXT PRIMARY KEY,
     workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
     status      TEXT NOT NULL,            -- running | completed | failed | aborted
     inputs_json TEXT NOT NULL,
     outputs_json TEXT,
     started_at  TEXT NOT NULL,
     ended_at    TEXT
   );
   ```
5. **Contrato** (api.ts + espejo):
   ```ts
   // ClientRequest +
   | { type: "workflow.save"; workflow: Workflow }        // upsert by id
   | { type: "workflow.list" }
   | { type: "workflow.delete"; workflowId: string }
   | { type: "workflow.run"; workflowId: string; inputs: Record<string, string> }
   | { type: "workflow.abort"; runId: string }
   // ServerEvent +
   | { type: "workflows"; workflows: Workflow[] }
   | { type: "workflow.run.started"; runId: string; workflowId: string }
   | { type: "workflow.node.status"; runId: string; nodeId: string;
       status: "running" | "completed" | "failed"; output?: string; error?: string }
   | { type: "workflow.run.done"; runId: string; status: "completed" | "failed" | "aborted";
       outputs: Record<string, string> }
   ```
   v1 emite estado **a nivel nodo** (no los RunEvents internos de cada
   agente — eso es v2).

### WU-16 — Engine en el Core (sin UI)

- Implementar `Orchestrator.run()` real: validación del DAG (sin ciclos —
  detectar y rechazar; agentes existentes y online), topo sort, ejecución
  con paralelismo por niveles, templating (reemplazo simple de
  `{{input.X}}` / `{{nodeId.output}}` — regex, sin librería), abort.
- El Orchestrator recibe una interfaz para correr un prompt contra un
  agente (inyectada desde `core.ts`) — NO importa adapters directamente.
- **Aceptación**: test con 2-3 agentes `local-process` (o un fake del
  runner inyectado) cubriendo: cadena secuencial, fan-out/fan-in paralelo,
  falla de nodo aborta el run, ciclo rechazado al validar.

### WU-17 — Persistencia + API

- Tablas de §7.4, handlers en `core.ts` para el contrato de §7.5,
  espejo en `frontend/src/lib/api.ts`. `workflow.run` ejecuta vía WU-16 y
  persiste `workflow_runs`.
- **Aceptación**: test E2E por la API: save → list → run → eventos de nodo
  → done con outputs; sobrevive reinicio (workflows persisten).

### WU-18 — Canvas editor (React Flow)

- Cargar la skill `react-flow-canvas` ANTES de empezar. No inventar API de
  React Flow — verificar contra la skill/docs.
- Reemplazar el stub de `WorkflowCanvas.tsx`: lista de workflows (crear/
  renombrar/borrar), canvas con nodos custom (input/agent/output), agregar
  nodo agent eligiendo de los agentes registrados, editar prompt template
  en un panel lateral al seleccionar nodo, conectar edges, guardar
  (`workflow.save` — incluir posiciones). Validación visual mínima: warning
  si un nodo agent no tiene template o agente.
- **Aceptación**: crear un workflow de 3 nodos, guardarlo, recargar la app,
  reabrirlo intacto (posiciones incluidas). Frontend build verde.

### WU-19 — Ejecución desde el canvas

- Botón Run (pide los inputs declarados por el nodo `input` en un modal),
  colorear nodos por estado en vivo (`workflow.node.status`), panel de
  resultados al terminar (outputs + error por nodo), botón Abort.
- **Aceptación**: workflow de 2 agentes docker-local en cadena corre de
  punta a punta con estados visibles y output final renderizado.

---

## 8. FASE 6 — Hardening (backlog ordenado)

- **WU-20 — Auth del WS (precondición de `apps/web`)**: token compartido
  generado por el Core al primer arranque (persistido en data dir), exigido
  como query param/header en el handshake WS; el shell Tauri lo lee y lo
  pasa al frontend. Localhost sin token sigue OK en dev (env flag).
- **WU-21 — Accesibilidad**: items del sidebar navegables por teclado
  (`role`, `tabIndex`, Enter/Space), focus trap + restauración en `Modal`,
  `aria-label` en cards del wizard y botones de ícono. Aprovechar para
  limpiar el anti-pattern de `App.tsx` (`agent.removed`): `setSelectedId`
  llamado dentro del updater de `setAgents` (rompe si StrictMode vuelve), y
  actualizar el comment de `main.tsx` que justifica StrictMode-off citando
  xterm (xterm ya no existe).
- **WU-22 — Shutdown limpio del sidecar**: en `apps/desktop/src-tauri/src/lib.rs`
  guardar el `Child` del sidecar y matarlo en el evento de cierre de
  ventana/app (skill `tauri-shell-sidecar`). Limpia también los 2 warnings
  de imports sin usar.
- **WU-23 — Multi-conversación**: con WU-06 hecho, agregar lista de
  conversaciones por agente en el panel (sidebar interno o dropdown):
  retomar cualquier sesión pasada, no solo la última. Incluir: refrescar
  la lista de sesiones tras una reconexión al Core (hoy solo se pide
  on-select, así que sesiones nuevas acumuladas offline no aparecen hasta
  cambiar de agente y volver).

---

## 9. Definición de "terminado" (por WU y global)

Un WU está terminado cuando:
1. Los 4 gates de §0.4 pasan.
2. Los criterios de aceptación del WU se verificaron CORRIENDO el sistema
   (no solo unit tests) — igual que se hizo con docker-local y el chat E2E.
3. Tipos espejados core↔frontend (§0.6).
4. Si el WU cambió comportamiento o descubrió un gotcha: actualizar la
   sección de estado de `docs/handoff-flue-integration.md` (apéndice corto,
   no reescribir) y guardar el hallazgo en memoria del proyecto.
5. PR con conventional commits; si supera ~400 líneas, dividir en PRs
   encadenados.

**Al cerrar cada fase**: smoke manual del flujo completo
(deploy → chat → stop → reconnect) para confirmar que no hay regresión del
camino feliz ya verificado.
