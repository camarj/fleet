# Backlog unificado — Fleet (2026-06-10)

> ÚNICA lista ordenada de trabajo pendiente. Une: (a) lo que quedó abierto del
> handoff (`handoff-implementacion-gaps.md` — F4 parcial + verificaciones +
> limitaciones v1 registradas), (b) el ROADMAP (Fases 1/3/4), y (c) el análisis
> de producto `analisis-producto-2026-06-10.md` (hallazgos FLOW/DIR/ZIA).
> Los IDs referencian esos docs; el detalle vive allá. Al completar un ítem,
> marcarlo acá y actualizar la fuente correspondiente.
>
> Estado: `main` = 83c419b (PR #18 mergeada). F0–F3, F5, F6 DONE; F4 parcial.

## A. Verificaciones pendientes (cierran el handoff — primero)

| ID | Ítem | Origen | Estado |
| --- | --- | --- | --- |
| A1 | **WU-15**: swap de provider/model en vivo (cambiar modelo → redeploy → confirmar que el agente corre el nuevo). Cubre también la verificación manual pendiente de F3 (WU-10/11) | handoff §6 | 🟡 Mecánica del swap VERIFICADA en vivo 2026-06-10 (docker-local, anthropic→opencode-go: Configure→Save→Redeploy→el agente responde como Kimi; WU-10 y WU-11 confirmados en la UI). Falta la pata "ambos providers responden": la key `anthropic` del secrets store es inválida (401 directo contra la API) — reponer key y chatear una vez |
| A2 | **F5**: correr un workflow real end-to-end con ≥1 agente vivo desde el canvas | handoff §🔖 | ✅ VERIFICADO 2026-06-10: canvas → input(topic)→agent(kimi, template `{{input.topic}}`)→output; run "Ecuador"→"Quito", `workflow_runs` persistido `completed`. F5 cerrada |
| A3 | **Target `github`→Coolify**: verificación manual en vivo | handoff §6 (WU-14 parcial) | Necesita instancia Coolify |
| A4 | **WU-12**: Fly.io en vivo | handoff §6 | ⛔ BLOQUEADO — cuenta marcada high-risk (PR #14 dejó el error visible) |

## B. Confianza operativa (Tier 1 del análisis — el producto dice la verdad)

| ID | Ítem | Origen | Esfuerzo |
| --- | --- | --- | --- |
| B1 | **Teardown/stop remoto real** (`stopDeployment()` hoy es no-op para fly/cloudflare/github/dokploy). Empezar por dokploy (`application.stop/start` ya probados). Mientras tanto: aviso honesto en los diálogos de Stop/Delete | DIR-01 + FLOW-01; extiende WU-02 (local-only fue decisión v1) | 🟡 **PR #19** (dokploy stop + diálogos honestos; review limpia, gates verdes). Falta: E2E en vivo (necesita DOKPLOY_URL/API_KEY en Settings → Infrastructure) y, a futuro, fly/cloudflare |
| B2 | **Completar tabla de precios** (3 modelos Anthropic vs 14+ providers) + override por archivo | DIR-03 / FLOW-07 | ✅ **PR #20**: tabla generada desde el catálogo pi-ai (523 modelos, 16 providers) + override `GATEWAY_PRICES_PATH`. Bonus: corrigió precio stale de opus-4-8 (15/75→5/25, verificado) |
| B3 | **Vista de uso/costo agregado** (tabla `usage` sin API de lectura): total + por agente/modelo, tab en Settings | DIR-02 / FLOW-10 | ✅ **PR #21**: `usage.summary` API + sección Usage en Settings (Today/7d/All, tabla por agente, footnote de runs sin precio). Verificado en vivo contra copia de la DB real |
| B4 | **Preservar log cuando el primer deploy falla** (hoy se descarta a propósito) | DIR-05 = limitación WU-09 aceptada en v1, ahora promovida | ✅ **PR #22**: snapshot global del último primer-deploy fallido (tabla `meta`) + API `deploy.lastFailedLog` + panel en el DeployWizard; se limpia cuando un deploy posterior tiene éxito |

## C. Pulido de flujos (Tier 2 — todo S)

| ID | Ítem | Origen |
| --- | --- | --- |
| C1 | Empty state / onboarding de primer uso (3 pasos con CTAs) | FLOW-08 |
| C2 | CTA "Connect" tras deploy target `github` (hoy: sidebar vacío sin siguiente paso) | FLOW-06 |
| C3 | Confirmación antes de borrar un workflow | FLOW-03 |
| C4 | Error visible cuando falla el guardado de config | FLOW-02 |
| C5 | Mostrar `description`/`version` del agente (sidebar + AgentConfig) | FLOW-12 |

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
| G1 | **Org registry multi-usuario** | Servicio central: organización, miembros, directorio de agentes compartidos (URL + target + config — nunca secretos). Necesita identidad real (el token WU-20 es mono-usuario) y roles owner/member | Primero de la fase — el resto depende de la org |
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

## Orden sugerido de ejecución

1. **A1** (verifica F3+F4 de una) → **A2** (cierra F5) — baratas, cierran el handoff.
2. **B1–B4** — el bloque de mayor leverage del análisis.
3. **C1–C5** en una o dos PRs chicas de UX.
4. **H1** en paralelo cuando se quiera tocar zia (esfuerzo S, valor inmediato).
5. **D**, luego **F**, y **G** cuando se decida arrancar organizaciones.
6. A3/A4 quedan oportunistas (dependen de Coolify / desbloqueo de Fly).
