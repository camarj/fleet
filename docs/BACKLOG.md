# Backlog unificado — Fleet (2026-06-10)

> ÚNICA lista ordenada de trabajo pendiente. Une: (a) lo que quedó abierto del
> handoff (`handoff-implementacion-gaps.md` — F4 parcial + verificaciones +
> limitaciones v1 registradas), (b) el ROADMAP (Fases 1/3/4), y (c) el análisis
> de producto `analisis-producto-2026-06-10.md` (hallazgos FLOW/DIR/ZIA).
> Los IDs referencian esos docs; el detalle vive allá. Al completar un ítem,
> marcarlo acá y actualizar la fuente correspondiente.
>
> Estado 2026-06-12: `main` = aa4199a (PR #36). F0–F6 DONE (F4: cloudflare ✓,
> dokploy ✓, fly ✓, WU-15 ✓; Coolify diferido). G1 Org Registry SHIPPED y
> verificado en vivo (PRs #24–#36). Secciones I/J/K agregadas tras la
> auditoría de profundidad 2026-06-12 (converter, memoria, orquestador).

## A. Verificaciones pendientes (cierran el handoff — primero)

| ID | Ítem | Origen | Estado |
| --- | --- | --- | --- |
| A1 | **WU-15**: swap de provider/model en vivo (cambiar modelo → redeploy → confirmar que el agente corre el nuevo). Cubre también la verificación manual pendiente de F3 (WU-10/11) | handoff §6 | ✅ VERIFICADO 2026-06-12: swap en vivo a `opencode-go/kimi-k2.6`, el agente responde identificándose como Kimi. Nota registrada: el primer mensaje tras el redeploy dio `model_error: An internal error occurred.` transitorio — origen el agente remoto (cold-start), no Fleet; Fleet lo surfaceó fielmente (`flue.ts:115`). Limitación conocida: `@flue/sdk` 0.10.1 colapsa el error estructurado `{type,message,details}` a solo `message` al re-lanzar (sdk `index.mjs:207`), así que `details` nunca llega a Fleet |
| A2 | **F5**: correr un workflow real end-to-end con ≥1 agente vivo desde el canvas | handoff §🔖 | ✅ VERIFICADO 2026-06-10: canvas → input(topic)→agent(kimi, template `{{input.topic}}`)→output; run "Ecuador"→"Quito", `workflow_runs` persistido `completed`. F5 cerrada |
| A3 | **Target `github`→Coolify**: verificación manual en vivo | handoff §6 (WU-14 parcial) | ⏸ DIFERIDO a otra etapa por decisión del usuario (2026-06-12) |
| A4 | **WU-12**: Fly.io en vivo | handoff §6 | ✅ VERIFICADO en vivo por el usuario (confirmado 2026-06-12): el deploy a Fly funcionó |

## B. Confianza operativa (Tier 1 del análisis — el producto dice la verdad)

| ID | Ítem | Origen | Esfuerzo |
| --- | --- | --- | --- |
| B1 | **Teardown/stop remoto real** (`stopDeployment()` hoy es no-op para fly/cloudflare/github/dokploy). Empezar por dokploy (`application.stop/start` ya probados). Mientras tanto: aviso honesto en los diálogos de Stop/Delete | DIR-01 + FLOW-01; extiende WU-02 (local-only fue decisión v1) | 🟡 **PR #19** (dokploy stop + diálogos honestos; review limpia, gates verdes). Falta: E2E en vivo (necesita DOKPLOY_URL/API_KEY en Settings → Infrastructure) y, a futuro, fly/cloudflare |
| B2 | **Completar tabla de precios** (3 modelos Anthropic vs 14+ providers) + override por archivo | DIR-03 / FLOW-07 | ✅ **PR #20**: tabla generada desde el catálogo pi-ai (523 modelos, 16 providers) + override `GATEWAY_PRICES_PATH`. Bonus: corrigió precio stale de opus-4-8 (15/75→5/25, verificado) |
| B3 | **Vista de uso/costo agregado** (tabla `usage` sin API de lectura): total + por agente/modelo, tab en Settings | DIR-02 / FLOW-10 | ✅ **PR #21**: `usage.summary` API + sección Usage en Settings (Today/7d/All, tabla por agente, footnote de runs sin precio). Verificado en vivo contra copia de la DB real |
| B4 | **Preservar log cuando el primer deploy falla** (hoy se descarta a propósito) | DIR-05 = limitación WU-09 aceptada en v1, ahora promovida | ✅ **PR #22**: snapshot global del último primer-deploy fallido (tabla `meta`) + API `deploy.lastFailedLog` + panel en el DeployWizard; se limpia cuando un deploy posterior tiene éxito |

## C. Pulido de flujos (Tier 2 — todo S)

| ID | Ítem | Origen | Estado |
| --- | --- | --- | --- |
| C1 | Empty state / onboarding de primer uso (3 pasos con CTAs) | FLOW-08 | ✅ **PR #23** |
| C2 | CTA "Connect" tras deploy target `github` (hoy: sidebar vacío sin siguiente paso) | FLOW-06 | ✅ **PR #23** |
| C3 | Confirmación antes de borrar un workflow | FLOW-03 | ✅ **PR #23** |
| C4 | Error visible cuando falla el guardado de config | FLOW-02 | ✅ **PR #23** |
| C5 | Mostrar `description`/`version` del agente (sidebar + AgentConfig) | FLOW-12 | ✅ **PR #23** |

## D. Capacidades (Tier 3 — M)

| ID | Ítem | Origen | Nota |
| --- | --- | --- | --- |
| D1 | ModelParameters (temperature/maxTokens/topP) en la UI — API y DB ya los soportan | FLOW-04 | |
| D2 | Historial de workflow runs (tabla `workflow_runs` sin API/UI) | FLOW-05 | |
| D3 | RunEvents por nodo durante un workflow (debug de nodos fallidos), gated con `verbose` | DIR-04 | El seam `AgentRunner.run` ya existe |
| D4 | Recovery de deploy tras reconexión del Core (hoy "Deploying…" eterno) | FLOW-11 | |
| D5 | Responder `interrupt` (approve/reject) desde el transcript | FLOW-09 | ⚠️ Verificar PRIMERO el wire real de interrupts contra `@flue/sdk` (regla #4) |

## E. Deuda v1 registrada (del handoff — baja prioridad, no bloquea)

| ID | Ítem | Origen |
| --- | --- | --- |
| E1 | Preflight `cloudflare`: `checkWrangler()` siempre ok; no avisa si falta npm | handoff §🔖 |
| E2 | `findCfOutputDir()` busca `wrangler.json`, no `.jsonc` — confirmar contra output real de `flue build` | handoff §🔖 |
| E3 | Merge de `env` settings.local sobre settings es shallow (reemplaza, no combina) | handoff WU-11 |
| E4 | MCP stdio: solo se reporta como unmapped, no se convierte | handoff WU-11 |

## F. Alcance y equipo (Tier 4 + ROADMAP F1/F3)

| ID | Ítem | Origen | Nota |
| --- | --- | --- | --- |
| F1 | `apps/web` (mismo frontend vía browser; WS auth WU-20 ya existe) | DIR-06 = ROADMAP Fase 3 | S–M |
| F2 | Windows Tauri build | ROADMAP Fase 3 | |
| F3 | Auto-updater Tauri (sin esto: version skew en el equipo) | DIR-07 | M; el grueso es signing/CI |
| F4 | Reconciliar checkboxes viejos de ROADMAP Fase 1: "E2E vs agente Flue real" (cubierto por dokploy en vivo), "Tauri build validation" (Fleet.app empaquetada existe), "SQLite app-data en build desktop" (verificar que el build usa archivo, no `:memory:`) | ROADMAP Fase 1 | Auditoría corta, probablemente solo marcar |

## G. Fase 4 ROADMAP — Organizaciones (trabajo grande → SDD)

Visión registrada en `ROADMAP.md` Fase 4 (2026-06-10): un equipo comparte sus
agentes deployados REMOTOS (los locales quedan privados); el owner crea la org
e invita miembros.

| ID | Ítem | Detalle | Dependencias |
| --- | --- | --- | --- |
| G1 | **Org registry multi-usuario** | Servicio central: organización, miembros, directorio de agentes compartidos (URL + target + config — nunca secretos). Necesita identidad real (el token WU-20 es mono-usuario) y roles owner/member | ✅ **PRs #24–#28** (SDD completo) + #29 (verify) + #30–#34 (hardening de fuego real). **VERIFICADO VIVO 2026-06-12**: org "Inteliside" (Intelliaa/fleet-org), share→join→sync→auto-connect→chat→guards. Pendiente: prueba cross-identity con compañero real. Artefactos en engram sdd/phase-4-orgs/* |
| G1.5 | **Credenciales de infra de la org** | Hoy un miembro invitado puede deployar a la infra de la empresa (Dokploy/Fly/CF) solo si recibe las credenciales por un canal externo y las carga a mano en Settings → Infrastructure (decisión G1: el registry JAMÁS transporta secretos, regla #8). Este ítem: distribución segura de credenciales de infra al unirse a la org (vault propio, o integración con un secret manager existente — diseñar con cuidado, es el problema duro de secret distribution). Confirmado como importante por el usuario 2026-06-11 | G1 |
| G2 | **Memoria/estado compartido de agentes** | Estado de conversación + gobernanza org (reglas a nivel system-prompt, conocimiento compartido). Requiere store accesible por los agentes deployados; cuidado con regla #8 y límites por target (Workers sin filesystem) | G1 |
| G3 | **Volumen de artefactos org** | Hoy los archivos que genera un agente mueren en su contenedor. Al crear la org: object store S3-compatible que los agentes montan/escriben — sobrevive redeploys, accesible a todos los miembros | G1 |
| G4 | **Browser + previewer de artefactos** | UI para listar/abrir/previsualizar lo que produjo un agente (markdown, imágenes, código), por agente y por run, leyendo de G3 | G3 |

**Diseñar con la vía zia (H) sobre la mesa**: identidad, registry y "miembro
que opera la flota" convergen con los empleados zia — no duplicar. Es trabajo
grande: arranca con `/sdd-new` cuando el usuario lo pida.

## H. Vía zia (repo `~/Documents/Proyectos/zia` — track paralelo)

| ID | Ítem | Origen | Cuándo |
| --- | --- | --- | --- |
| H1 | Tool `call_flue_agent` en zia (~80 líneas, pasa por su approval gate): empleados zia consumen especialistas deployados por Fleet | ZIA-02 | Ya — sin dependencias |
| H2 | `ApprovalView` como unión discriminada en zia + Fleet renderiza las approval cards (Fleet = superficie del jefe; zia se ahorra su web UI) | ZIA-05 | Tras H1 |
| H3 | Zia shippea gateway HTTP → `ZiaAdapter` en `foreign/` de Fleet | ZIA-01 | Cuando zia tenga HTTP |
| H4 | Agentes zia en el catálogo y el DAG de Fleet (Fleet absorbe la Fase 3 de zia: control panel + cron + multi-agente) | ZIA-07 | Tras H3 |

Rechazados (no reabrir sin nueva evidencia): Fleet deployando contenedores zia
standalone (ZIA-03), SQLite compartido entre productos (ZIA-04 — integración
SIEMPRE por API), fusionar repos, multi-protocolo A2A/ACP.

## I. Conversión COMPLETA — paridad Claude Code → Flue (investigación 2026-06-12)

> **Meta de producto (usuario, 2026-06-12)**: el agente convertido debe poder
> hacer TODO lo que hacía el original — CLI, MCP stdio, tools contra APIs. El
> reporte de pérdidas es complemento de honestidad, no la meta.
>
> **Investigación verificada** contra `@flue/sdk@0.10.1` + `@flue/runtime@0.10.1`
> + `@flue/cli@0.10.1` instalados (regla #4). Los caminos a paridad EXISTEN en
> los targets Node/Docker (docker-local, dokploy, fly, github):
>
> - **Hallazgo central**: el runtime Flue YA incluye las tools built-in
>   (`read`/`write`/`edit`/`bash`/`grep`/`glob`/`task`/`activate_skill`) en
>   cada sesión. El problema es el sandbox default: `just-bash`, un emulador
>   en memoria (~60 comandos POSIX reimplementados en TS, sin
>   `child_process`) — git/npm/npx/binarios reales NO existen ahí. Con
>   `sandbox: local()` de `@flue/runtime/node`, bash y filesystem pasan a ser
>   REALES (exec/fs sin restricción) dentro del contenedor.
> - **`defineTool.execute` corre Node puro sin sandbox** (firma verificada:
>   `execute(args, signal) => Promise<string>`) — puede usar fetch,
>   child_process, fs. Tools contra APIs = wrappers fetch.
> - **MCP stdio**: `connectMcpServer` es HTTP-only DEFINITIVO (union
>   `'streamable-http' | 'sse'`, sin variante stdio). Pero el contenedor es
>   Node 22 completo: cero bloqueo para correr el server stdio ADENTRO con un
>   bridge stdio→HTTP (supergateway o equivalente) y conectarlo por localhost.
> - **Subagentes: paridad YA lograda** — el runtime auto-cablea la tool `task`
>   cuando hay `defineAgentProfile`; el LLM la ve y delega solo. Sin trabajo.
> - **Cloudflare = excepción absoluta**: sin subprocesos ni fs (V8 Workers).
>   Solo agentes API-driven (fetch + MCP HTTP). No se miente: se documenta
>   paridad por target.

| ID | Ítem | Valor | Evidencia / detalle |
| --- | --- | --- | --- |
| I1 | **`sandbox: local()` en el agente emitido (targets Node)**: agregar el import de `@flue/runtime/node` y el campo `sandbox: local({ env: {...process.env} })` al `createAgent` emitido, gated por `target !== 'cloudflare'`. Activa shell real, fs real, y los scripts ejecutables dentro de skills. **El mejor ratio valor/esfuerzo de todo el backlog** | 🔴 ENORME | `emit.ts:138-157`; verificado `node/index.mjs:12-149` (`createLocalSessionEnv` sobre `child_process.exec` + `fs/promises`) |
| I2 | **MCP stdio dentro del contenedor**: el converter emite (a) dependencia bridge en `package.json`, (b) `start.mjs` que levanta `supergateway --stdio "<command>"` por server stdio + luego el server Flue, (c) `CMD ["node","start.mjs"]` en el Dockerfile, (d) `connectMcpServer` a `http://localhost:<port>`, (e) los env del server (p.ej. `GITHUB_TOKEN`) al `.env.example`. En CF: queda unmapped honesto | 🔴 ENORME | `McpTransport` sin stdio (`index.d.mts:33`); container Node 22 completo; hoy `emit.ts:31` filtra y `read.ts:167` descarta los env |
| I3 | **Tools de API vía `defineTool` + fetch**: emitir wrappers para integraciones HTTP del proyecto fuente que no son MCP. Funciona idéntico en CF | 🟡 | firma `ToolDefinition` en runtime d.mts:208-217; execute sin sandbox |
| I4 | **Expandir `@`-imports del CLAUDE.md** al convertir (hoy el token queda literal e inservible); reportar irresolubles | 🟡 | `read.ts:25` |
| I5 | **Slash commands → skills Flue**: `.claude/commands/` hoy ni se escanea; un command es un prompt md — mapeo natural a skill | 🟡 | `read.ts:20-61`, `types.ts:9-27` |
| I6 | **Reporte de paridad por target**: tabla honesta "qué puede este agente en este target" (CF: sin shell/fs/stdio). Incluye: itemizar hooks (evento+comando) y permissions en vez del bulto actual, y fix del bug CLI que imprime `[object Object]` (`cli.ts:45`) | 🟡 | `read.ts:44-49` |
| I7 | **Frontmatter extra de subagentes** (`tools`, `skills`, `thinkingLevel`) — `defineAgentProfile` los acepta, cablearlos | 🟢 | `read.ts:101-108` |
| I8 | **Bloque `env` de settings al factory**: el `createAgent(() => ...)` emitido no destructura `env`; cablearlo para que `env.X` exista dentro del agente | 🟢 | `emit.ts:157` |

**Slices** (PRs ≤400 líneas): **I-PR1** = I1 solo (chico, gigante — el agente
recupera las manos) → ✅ **PR #37 mergeada 2026-06-12** (plan `plans/001`,
ejecutado+revisado; pendiente verificación en vivo: agente docker-local corre
`git --version`). **I-PR2** = I2 (bridge stdio) → ✅ **PR #40 mergeada
2026-06-12** (plan `plans/004`; supergateway 3.4.3 pinneado; pendiente
aceptación en vivo: docker-local con server stdio → tools usables en chat).
**I-PR3** = I3+I4+I5+I8. **I-PR4** = I6+I7 (honestidad y detalles). Skills y
subagentes ya están en paridad — sin trabajo extra.

## J. Memoria y estado compartido (auditoría + verificación 2026-06-12 — eleva y destraba G2)

> Requerimiento del usuario confirmado como fundamental (2026-06-12): contexto
> compartido de sesión entre agentes + memoria entre sesiones. Estado real: NO
> implementado — Fleet guarda transcripts solo para la UI y nunca los reenvía
> al agente (`core.ts:656` manda solo el mensaje actual); entre nodos de un
> workflow solo viaja texto interpolado. **Hallazgo clave**: el runtime Flue YA
> persiste el historial server-side (`SessionData` por `instanceId`, en el
> `data/flue.db` del agente) — y Fleet lo descarta en cada reconexión porque
> genera un `instanceId` aleatorio. Decisión del usuario: usar sistemas de
> memoria existentes (p.ej. Engram), NO construir uno desde cero.
>
> **Engram cloud VERIFICADO 2026-06-12** (binario 1.15.10 + repo
> `github.com/Gentleman-Programming/engram`): el claim del usuario es correcto
> — Engram NO es solo local. Existe `engram cloud serve`: imagen Docker
> `ghcr.io/gentleman-programming/engram:latest` (amd64+arm64), Postgres 16+,
> auth por bearer token (`ENGRAM_CLOUD_TOKEN` + admin token + JWT), dashboard
> web, allowlist de proyectos, deployable en **Dokploy**/Coolify/VPS — o sea,
> en la MISMA infra que Fleet ya sabe operar. Matiz de arquitectura: el MCP de
> Engram sigue siendo stdio-only; el patrón es local-first — cada nodo corre
> `engram mcp` local y SINCRONIZA con el cloud por HTTP (push/pull,
> `ENGRAM_CLOUD_AUTOSYNC=1`). Para un agente deployado: el contenedor empaqueta
> el binario engram + `engram mcp` como server stdio del agente (requiere I2) +
> autosync contra el Engram cloud de la org. La distribución del token converge
> exactamente con G1.5.

| ID | Ítem | Detalle | Dependencias |
| --- | --- | --- | --- |
| J1 | **instanceId estable por agente** | ✅ **PR #38 mergeada 2026-06-12** (plan `plans/002`): columna `agents.flue_instance_id`, los 3 sitios de reconexión reutilizan el id, deploy = época nueva (overwrite). Pendiente aceptación en vivo: chatear → reiniciar Core → el agente recuerda | Ninguna |
| J2 | **Pasar `session` en el invoke** | El payload Flue soporta `session?: string` (default `"default"`); Fleet nunca lo manda (`flue.ts:101-106`). Mapear conversaciones Fleet (WU-23) ↔ sesiones nombradas Flue para threading real server-side | J1 |
| J3 | **Decidir replay vs server-side** | Con J1+J2, el agente recuerda solo. Verificar contra el wire real (regla #4) si hace falta replay de transcripts desde el Core en algún caso (p.ej. agente redeployado pierde su flue.db) — el seam es `core.ts:656` + `RunInput.context` (existe en `neutral.ts:30`, hoy sin uso) | J1, J2 |
| J4 | **Memoria compartida vía Engram cloud (arquitectura verificada)** | (a) Deployar `engram cloud serve` (Docker + Postgres) en la infra de la org — Fleet ya sabe deployar a Dokploy; (b) el converter empaqueta el binario engram en la imagen y corre `engram mcp` como server stdio del agente (vía el bridge de I2), con el perfil de tools de memoria; (c) `engram cloud config` + `enroll` + `ENGRAM_CLOUD_AUTOSYNC=1` con el token de la org → todos los agentes (remotos y locales) leen/escriben la MISMA memoria por proyecto. Diseñar con SDD (qué se comparte, scoping por proyecto/org, qué pasa en CF donde no hay stdio) | I2; token → G1.5 |
| J5 | **Contexto compartido entre agentes (workflows + org)** | Hoy solo interpolación de texto entre nodos (`orchestration/index.ts:146-152`). Con J4, los nodos de un workflow comparten memoria Engram por proyecto — el output estructurado de un agente queda consultable por el siguiente, más allá del texto interpolado. Gobernanza org (reglas system-prompt, conocimiento compartido) = G2 propiamente; respetar regla #8 (el registry jamás transporta secretos). Diseñar con SDD; converge con G3 (object store) | J4 |

**Nota**: J1–J3 NO dependen de organizaciones — son mejoras del flujo single-user
que destraba la auditoría. J4–J5 requieren decisión de arquitectura (SDD).

## K. Orquestador production-grade (auditoría 2026-06-12)

> El motor DAG y el canvas funcionan (F5 ✓, smoke en vivo ✓), pero solo se
> probaron con demos. 9 gaps de robustez encontrados con evidencia, 3
> bloqueantes para uso real. Lo diseñado-fuera de v1 a propósito (ciclos,
> condicionales, retries, RunEvents por nodo = D3) NO está acá — esto es lo
> que falta SIN decisión registrada.

| ID | Ítem | Sev | Evidencia |
| --- | --- | --- | --- |
| K1 | **Timeout por nodo y por run**: un agente colgado congela el run para siempre (el await solo termina por completion, fallo de hermano o abort manual) | 🔴 | `orchestration/index.ts:211` |
| K2 | **Atribución de uso/costo de workflow runs**: `#agentRunner()` no crea sesión ni registra usage; la columna `run_id` de `usage` nunca se puebla → `usage.summary` (B3) ciego a la orquestación | 🔴 | `core.ts:472-493`, `core.ts:642` |
| K3 | **Límite de tamaño de outputs**: acumulación `text +=` sin tope, frame WS único, `outputs_json` sin guard, `<pre>` sin truncar | 🔴 | `core.ts:479`, `db.ts:517`, `WorkflowCanvas.tsx:355` |
| K4 | **Runs `running` huérfanos tras crash/restart del Core**: la fila queda así para siempre; el constructor no reconcilia | 🟡 | `db.ts:506-513`, `core.ts:100-112` |
| K5 | **Historial de runs write-only** (absorbe D2): `workflow_runs` guarda todo pero no hay API de lectura ni UI — al cerrar el tab los outputs se pierden | 🟡 | `api.ts` (no existe `workflow.runs`) |
| K6 | **Sin guard de runs concurrentes del mismo workflow**: N `workflow.run` simultáneos arrancan todos, sin cola ni aviso | 🟡 | `server.ts:68`, `core.ts:92` |
| K7 | **`{{input.TYPO}}` inyecta `""` silencioso**: `validateWorkflow()` valida refs `{{nodeId.output}}` pero no claves `{{input.X}}` contra los input nodes declarados | 🟡 | `orchestration/index.ts:90-99,142-152` |
| K8 | **Race del botón Abort**: activo antes de recibir `runId`; click en esa ventana = no-op silencioso | 🟢 | `WorkflowCanvas.tsx:215-227` |
| K9 | **Orden de merge multi-rama**: el output concatena por orden alfabético de node-ID, sin forma de especificar orden semántico | 🟢 | `orchestration/index.ts:215-220` |
| K10 | **Piloto con un proceso REAL del negocio** (gate de salida — definición del usuario 2026-06-12): NO cuenta "un agente genera texto y se lo pasa a otro". Cuenta: un proceso real de Inteliside, multi-agente, donde los agentes usan tools reales (post I-PR1: shell/APIs/MCP) y el output final es algo que el negocio usaría tal cual. Candidato natural: pipeline de contenido con el agente `contenido` ya deployado (investigar fuentes → redactar → revisar → publicar vía API/MCP). El caso concreto lo elige el usuario al arrancar K10. Lo que falle alimenta K1–K9 e I. Sin este gate, ni K ni I se declaran listos | — | criterio de aceptación |

**Slices sugeridos**: **K-PR1 robustez de ejecución** = K1 + K4 + K6 → ✅
**PR #39 mergeada 2026-06-12** (plan `plans/003`; pendiente aceptación en vivo:
workflow contra contenedor apagado falla con timeout). **K-PR2 observabilidad**
= K2 + K5 (con D2) + K3. **K-PR3 UX/validación** = K7 + K8 + K9. **K10** corre
después de K-PR1/2 como verificación en vivo.

## Orden sugerido de ejecución

(Actualizado 2026-06-12 — A, B, C y G1 cerrados; el frente es paridad + memoria
+ orquestador real: I/J/K.)

1. **I-PR1** (`sandbox: local()`) — el agente convertido recupera shell y
   filesystem REALES con un cambio chico. El mejor valor/esfuerzo del backlog.
2. **J1 → J2** (instanceId estable + `session`) — memoria entre sesiones
   usando lo que Flue ya persiste server-side. Esfuerzo S.
3. **K-PR1** (timeouts + reconciliación + guard de concurrencia) — el
   orquestador deja de ser demo.
4. **I-PR2** (bridge MCP stdio in-container) — completa la paridad Node y
   habilita Engram dentro del agente.
5. **J4 con SDD** (Engram cloud en la infra de la org + agentes que
   sincronizan) — la memoria compartida real; el token converge con G1.5.
6. **K-PR2** (costos + historial + límites) → **K10** (piloto con proceso
   real del negocio — gate de salida de I y K).
7. **I-PR3/I-PR4**, **J3/J5**, **K-PR3**; luego **G1.5**, **D**, **F**, **H**
   oportunistas. A3 (Coolify) diferido a otra etapa.
