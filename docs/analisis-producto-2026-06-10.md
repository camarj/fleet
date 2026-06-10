# Análisis de producto — Fleet como herramienta interna + integración zia (2026-06-10)

> Análisis a nivel de PRODUCTO (no de implementación): qué le falta a Fleet
> para ser genuinamente provechoso como herramienta de consumo interno, dónde
> los flujos de usuario pierden coherencia, y cómo el proyecto **zia**
> (`~/Documents/Proyectos/zia`, agentes-empleado) complementa el producto.
> Sucede a `docs/analisis-gaps-2026-06-09.md` (ya consumido por el handoff
> F0–F6). Basado en `main` = 83c419b (post PR #18). Cada hallazgo cita
> evidencia en código; los hallazgos clave fueron verificados a mano.

## Diagnóstico central

Fleet ya cumple su promesa técnica: convertir → deployar (5 targets, dokploy
verificado en vivo) → conectar → chatear → orquestar. El gap de producto ya no
es de *capacidad* sino de **confianza y visibilidad operativa**: el operador no
puede confiar en lo que el botón dice que hace (stop/delete no apagan infra
remota), no puede ver lo que el sistema ya sabe (costo agregado, historial de
runs de workflows, parámetros de modelo — todo está en SQLite sin superficie de
lectura), y el momento de mayor fricción (un deploy que falla) es justo donde
menos información recibe. El patrón dominante: **el backend captura datos que
la UI nunca muestra**. Son gaps baratos — la mayoría es exponer lo que ya
existe.

Sobre zia: hoy es pre-alpha con un core real (runtime pi.dev + approval flow +
persistencia, ~900 tests verdes) pero **sin capa de red ni contenedores** (no
hay gateways HTTP, ni Dockerfile, ni web UI, ni control panel). La integración
correcta no es fusionar: es que **Fleet sea el centro de operaciones que zia no
tiene planeado construir hasta su Fase 3**, y que los empleados zia consuman
especialistas deployados por Fleet como tools. Hay un primer paso de esfuerzo S
con valor inmediato (ZIA-02).

---

## 1. Flujos de usuario — coherencia (verificados)

Resumen del walkthrough completo de la UI (`frontend/src`) contra la API del
Core (`packages/core/src/api.ts`):

| # | Hallazgo | Impacto | Esfuerzo | Confianza |
|---|---|---|---|---|
| FLOW-01 | **Stop/Delete dejan la infra remota corriendo y facturando, sin avisar** — `core.ts:434-449` lo documenta como fuera de scope v1; el diálogo de delete no lo menciona (`Sidebar.tsx:196-202`) | El control primario del producto miente para 3 de 5 targets | S (aviso) / M (teardown real, ver DIR-01) | ALTA |
| FLOW-02 | Falla de guardado de config es silenciosa — `App.tsx:193-199` solo apaga el spinner; `AgentConfig.tsx` no tiene slot de error | Usuario cree que guardó y no | S | ALTA |
| FLOW-03 | Borrar workflow no pide confirmación — `WorkflowCanvas.tsx:154-162`, botón ✕ junto a Run, sin soft-delete | Un click destruye el grafo, sin recuperación | S | ALTA |
| FLOW-04 | `ModelParameters` (temperature/maxTokens/topP) existen en API y DB pero la UI nunca los manda — `App.tsx:116` envía solo `modelSpecifier`; `db.ts:230-241` persiste `parameters_json` | No se puede tunear un agente sin tocar código | M | ALTA (verificado) |
| FLOW-05 | Historial de runs de workflows se persiste (`workflow_runs`, `db.ts:345-359`) pero no hay API ni UI para leerlo | Imposible debuggear o comparar runs pasados | M | ALTA (verificado) |
| FLOW-06 | Tras deploy target `github`, pantalla de éxito sin CTA para conectar — el usuario queda en sidebar vacío (`DeployWizard.tsx:316-324`, `App.tsx:164-169`) | Abandono en el primer uso del target | S | ALTA |
| FLOW-07 | Tabla de precios = 3 modelos Anthropic (`pricing.ts:20-24`) vs 14+ providers ofrecidos — costo "—" para casi todo | La feature de costo no aplica a la mayoría de agentes | S | ALTA (verificado) |
| FLOW-08 | Sin empty state / onboarding de primer uso — solo "No agents yet" (`Sidebar.tsx:167`) | Rampa inicial innecesariamente empinada para el equipo | S | ALTA |
| FLOW-09 | El evento `interrupt` se renderiza (`TerminalPanel.tsx:433-439`) pero no existe vía para responderlo (sin `interrupt.respond` en la API) | Sesión muerta si un agente pide aprobación; solo queda Abort | M | ALTA — ⚠️ antes de implementar, verificar contra `@flue/sdk` el wire real de interrupts (regla #4) |
| FLOW-10 | Uso/costo agregado en SQLite (`usage`, `db.ts:104-116`) sin API ni vista — solo costo de la sesión actual | No se puede responder "¿cuánto gastamos hoy / por agente?" | M | ALTA (verificado) |
| FLOW-11 | Reconexión del Core en medio de un deploy deja el wizard en "Deploying…" para siempre — los eventos de deploy no son re-jugables (`App.tsx:58,201-208`) | Estado huérfano tras crash/restart del Core | M | ALTA |
| FLOW-12 | `description` y `version` del agente viajan en `AgentSummary` pero ningún componente los muestra | Con varios agentes no hay forma de distinguirlos más allá del nombre | S | ALTA |

**Coherencia general**: los flujos núcleo (deploy → connect → chat) son sólidos
y los espejos `api.ts` están alineados. Las fallas se concentran en
**transiciones** (post-deploy github, reconexión, errores silenciosos) y en el
**canvas de workflows**, que es el área que más datos escribe y menos expone.

## 2. Dirección — gaps operativos para uso interno diario

| # | Hallazgo | Evidencia | Esfuerzo | Notas |
|---|---|---|---|---|
| DIR-01 | **Teardown/stop real de infra remota** | `flue-deployer.ts:597` `stopDeployment()` es no-op para fly/cloudflare/github/dokploy | M por target | Dokploy ya tiene `application.stop/start` probados en `#runDokploy`; fly = `flyctl apps suspend`; CF = `wrangler deployments deactivate`. Es EL gap de confianza diaria |
| DIR-02 | **Dashboard de uso/costo agregado** (= FLOW-10) | tabla `usage` completa, cero API de lectura | S–M | Un `GROUP BY agent_id, model` + tab "Usage" en Settings |
| DIR-03 | **Completar tabla de precios** (= FLOW-07) | `pricing.ts` comenta "configurable later" | S | Poblar providers del catálogo + override por archivo |
| DIR-04 | **RunEvents por nodo en workflows** | `api.ts:155` y `orchestration/index.ts:12` lo declaran explícitamente como "later concern" | M | Sin esto, debuggear un workflow fallido = re-correrlo a ciegas. Gate con `verbose` para no saturar el WS |
| DIR-05 | **Preservar el log cuando el primer deploy falla** | `core.ts:299-305`: "the log is intentionally dropped" si falla antes de registrar el agente | S | El momento de mayor fricción del producto es donde menos info se da |
| DIR-06 | **apps/web (Fase 3)** | `apps/web/package.json` = stub explícito; el frontend no tiene imports Tauri (salvo branch en `lib/dialog.ts`) | S–M | Desbloquea Windows/browser para el equipo; el WS auth de WU-20 ya existe |
| DIR-07 | **Auto-updater Tauri** | `Cargo.toml` sin `tauri-plugin-updater` | M | Sin esto cada release = distribuir el .app a mano → version skew en el equipo |

**No auditado en esta pasada**: churn de git vs cobertura de tests, composición
del bundle, pipeline de packaging Tauri end-to-end, accesibilidad más allá de
WU-21.

---

## 3. Zia — qué es y cómo aporta a Fleet

### 3.1 Estado real de zia (verificado contra código, no contra sus docs)

**Implementado y testeado** (~900 tests verdes): el core del agente
(`packages/core/agent.ts` envuelve pi.dev `createAgentSessionRuntime`) con
approval gate fail-closed, presupuesto mensual, fallback de modelos y slash
commands; `packages/callbacks` (clasificador de POLICIES.md
trivial/medio/alto + cola de aprobación + audit log SQLite); `packages/tools`
(registry + adapter MCP real que spawnea servers + builtins); persistencia
SQLite FTS5 (schema v5); memoria (file y sqlite-fts); 11 providers LLM. El
único camino end-to-end que funciona hoy es el **TUI local** (`pnpm tui
agents/<ficha>`) + modo print/RPC por stdin/stdout.

**NO existe** (verificado): gateways de red (email/Slack/HTTP — solo
primitivas; `gateways/src/index.ts`: "GatewayRunner exported from PR B
onward"), `apps/agent-web-ui`, `apps/control-panel`, `packages/cron`, y **cero
Dockerfiles/compose** — el modelo "un contenedor por empleado" del README es
aspiracional hoy.

### 3.2 El encaje de producto

Zia y Fleet son complementarios por diseño, no competidores:

- **Zia aporta lo que Fleet no tiene**: agentes con identidad (ficha en git:
  SOUL/POLICIES/profile.yaml), jefe humano y **approval flow** — gobernanza de
  acciones externas. Fleet opera agentes; zia define *empleados*.
- **Fleet aporta lo que zia tiene en Fase 3 y no construyó**: deploy
  multi-target, catálogo/lifecycle de agentes, panel de operación, costo/uso,
  orquestación DAG. El HANDOFF de zia ya nombra a Fleet como su orquestador de
  Fase 2 ("Fleet is a CLIENT of zia's gateway API").

### 3.3 Hallazgos de integración (orden recomendado)

| # | Integración | Esfuerzo | Cuándo | Veredicto |
|---|---|---|---|---|
| ZIA-02 | **Tool `call_flue_agent` en zia**: un `defineTool()` (~60–100 líneas, lado zia) que invoca el HTTP de un agente Flue deployado por Fleet (`agents.invoke` mode:stream, mismo wire que `FlueAdapter`). El empleado zia delega en especialistas deployados, sujeto a su propio approval gate (POLICIES.md puede clasificarlo medio/alto) | S | **Ya** — no depende de nada | La vía rápida a la visión "empleados que usan especialistas". Valor inmediato, cero cambio en Fleet |
| ZIA-05 | **Fleet como superficie de aprobación del jefe**: zia extiende `ApprovalView` a unión discriminada (tool / ficha-diff / policy-change — su propio HANDOFF lo pide antes de P0-2); Fleet renderiza esas cards en el transcript. Evitaría que zia construya `agent-web-ui` | S (zia) + M (Fleet) | Tras ZIA-02 | Diferenciador único: ningún otro ops center renderiza approvals de empleados |
| ZIA-01 | **`ZiaAdapter` en `foreign/`**: requiere que zia shippee primero su gateway HTTP (GatewayRunner + transporte). El stream de pi.dev mapea limpio al RunEvent neutral (`message_update`→delta, `tool_execution_*`→tool, `compaction_*`→memory) | L (2 fases, repos distintos) | Cuando zia tenga HTTP | El placeholder `foreign/` existe exactamente para esto. Riesgo: estabilidad del wire pi.dev entre versiones |
| ZIA-07 | **Fleet absorbe la Fase 3 de zia** (control panel + cron + multi-agente): los agentes zia entran al catálogo y al DAG de Fleet como participantes junto a los Flue | L | Tras ZIA-01 | El movimiento estratégico: zia descarta construir su ops UI redundante |
| ZIA-06 | Ficha (`profile.yaml`: bosses, llm.available, budget) como fuente de `AgentInfo`/config en Fleet | S | Con ZIA-01 | Confianza MEDIA — depende del protocolo de discovery que zia aún no diseñó |
| ZIA-03 | Fleet deployando contenedores zia | — | **Refutado como feature standalone** | Sin ZiaAdapter sería un contenedor huérfano sin superficie en Fleet; además zia no tiene Dockerfile. Solo tiene sentido después de ZIA-01 |
| ZIA-04 | Compartir SQLite entre productos | — | **Anti-feature — política** | Ambos tienen tabla `sessions` con semánticas distintas; "memory" significa cosas diferentes en cada uno. Integración SIEMPRE por API, nunca por DB compartida |

**Interacción con ROADMAP Fase 4 (orgs)**: la visión org (agentes remotos
compartidos, memoria compartida, volumen de artefactos) y la vía zia convergen
— un empleado zia es el caso de uso natural de "miembro que opera la flota
compartida". Conviene diseñar la Fase 4 con ZIA-01/07 sobre la mesa para no
duplicar registry/identidad.

---

## 4. Backlog propuesto (priorizado por leverage)

**Tier 1 — Confianza operativa (el producto dice la verdad):**
1. DIR-01 teardown/stop remoto real (empezar por dokploy: API ya probada) + mientras tanto FLOW-01 (aviso honesto en diálogos) — S+M
2. DIR-03/FLOW-07 tabla de precios completa — S
3. DIR-02/FLOW-10 vista de uso/costo agregado — S–M
4. DIR-05 preservar log de deploy fallido — S

**Tier 2 — Pulido de flujos (todo S):**
5. FLOW-08 empty state primer uso · 6. FLOW-06 CTA conectar post-github ·
7. FLOW-03 confirmar delete de workflow · 8. FLOW-02 error visible en config ·
9. FLOW-12 mostrar description/version

**Tier 3 — Capacidades (M):**
10. FLOW-04 ModelParameters en UI · 11. FLOW-05 historial de workflow runs ·
12. DIR-04 RunEvents por nodo · 13. FLOW-11 recovery de deploy tras reconexión ·
14. FLOW-09 responder interrupts (verificar wire Flue primero)

**Tier 4 — Alcance y equipo:**
15. DIR-06 apps/web · 16. DIR-07 auto-updater

**Vía zia (paralela, no compite con los tiers):**
- Z1. ZIA-02 tool `call_flue_agent` (repo zia) — S, valor inmediato
- Z2. ZIA-05 ApprovalView union (zia) + cards en Fleet
- Z3. ZIA-01 gateway HTTP zia → `ZiaAdapter` → Z4. ZIA-07 catálogo + DAG

## 5. Considerado y rechazado

- **Fusionar zia dentro del monorepo de Fleet**: productos con ciclos de vida
  y públicos distintos (zia es open-source); la frontera correcta es el
  adapter (`foreign/`) y el API.
- **ZIA-03 standalone** y **ZIA-04 DB compartida**: ver tabla §3.3.
- **Soporte multi-protocolo genérico (A2A/ACP)**: ya removido por decisión de
  arquitectura; nada en este análisis lo reabre.
