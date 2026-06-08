# Handoff — Integrar el convertidor + traza (sobre Flue) en Fleet

> **Para el equipo de Fleet.** Plan de integración para que tomen el control.
> Fecha: 2026-06-08. Referencia archivos reales de este repo (`vigia-agents`) y
> respeta sus fronteras (`CLAUDE.md`, `ARCHITECTURE.md`). Lo de Flue está
> verificado contra flueframework.com/docs; lo de Fleet por exploración del repo.

## Contexto y decisión

Se unifican los proyectos dentro del monorepo de Fleet y **se cambia el motor del
agente de DeepAgents (Python) a Flue (TypeScript)**. Objetivo del producto:
**convertir un agente local de Claude Code en un agente Flue containerizable
(Docker) / deployable en Cloudflare, con proveedor y modelo elegibles al
convertir (e intercambiables después), que streamee a Fleet todo el ciclo de
vida en tiempo real** (texto, tool, MCP, memoria, skill, subagente, thinking)
para renderizarlo.

> **Feature central del convertidor:** un agente de Claude Code está atado a
> Anthropic. Al convertirlo a Flue, el convertidor **permite elegir el proveedor
> y el modelo** del agente que se deployará (ej. pasarlo a `openai/…`,
> `google/…`, `openrouter/…`). El modelo del Claude Code original es solo el
> default; el agente Flue resultante es multi-proveedor.

### Por qué Flue (verificado en docs)

- **TypeScript**, corre en Node (>=22.18) **y Cloudflare Workers** → unifica TODO
  el stack (Fleet TS + convertidor TS + agente TS). Adiós Python en un repo TS.
- Paridad con lo que daba DeepAgents: `defineTool()` (tools), `defineAgentProfile()`
  + `session.task()` (subagentes), `connectMcpServer()` (MCP), **skills `SKILL.md`
  igual que Claude Code**, model specifier `anthropic/claude-…` `openai/…` (swap),
  `thinkingLevel` (thinking de primera clase).
- **Espeja la arquitectura de Claude Code** → como la fuente del convertidor ES
  Claude Code, la conversión es **casi 1:1** (desaparecen las impedancias que
  teníamos con DeepAgents).
- Streaming/observabilidad nativos (`observe()`, REST `/runs/<id>/stream`,
  SSE/WS) → no hay que escribir un server de traza propio; se mapea el de Flue.

### Riesgo asumido (se decidió migrar ya, sin spike previo)

- Flue es **Experimental**, v0.10.0, ~3-4 semanas, **romperá APIs antes del 1.0**.
  Mitigación: **fijar versión** de `@flue/runtime` y esperar churn.
- **El formato exacto del stream `/runs/<id>/stream` NO está documentado.** Es la
  dependencia central. → **WS0 lo desbloquea antes que nada.**
- Backing: señales apuntan al **equipo de Astro** (`github.com/withastro/flue`);
  una fuente dijo Anthropic (parece confusión). **Confirmar quién lo respalda.**

### Qué se da de baja

- El proyecto DeepAgents previo (Shipyard / `vivero_agents`,
  `github.com/camarj/shipyard`) y sus 27 references quedan **obsoletos como
  código**. Sobreviven las ideas (fachada neutral, patrón convertidor).

## Respeto de fronteras (no negociable)

- `packages/core` sigue **puro** (no crea agentes — regla de Fleet). El convertidor
  es **workspace aparte** (`packages/converter`). El frontend solo habla con core.
- Amendment de docs (lo hace Fleet): `ARCHITECTURE.md` → "el *core* no crea agentes;
  el repo aloja además el convertidor como workspace separado".

## Arquitectura integrada

```
 packages/converter (TS)                      packages/core/src/adapters/flue.ts (NUEVO adapter)
   lee agente Claude Code                       habla el protocolo de Flue (HTTP/SSE/WS)
   → emite agente Flue (TS, ~1:1)               mapea eventos Flue → neutral RunEvent
        │                                      packages/core/src/neutral.ts (EXTENDER)
        ▼ docker build / cloudflare deploy     frontend/.../TerminalPanel.tsx (activar blocks + mcp/mem/skill)
   agente Flue sirviendo su stream ──HTTP/SSE──►  Fleet conecta y renderiza la traza
```

## Workstreams

### WS0 — De-riesgar el stream de Flue (BLOQUEANTE, primero)
- Fijar versión de `@flue/runtime`. Construir un agente Flue trivial.
- **Determinar el formato exacto de eventos** de `/runs/<id>/stream` (leer
  source/probar) o, si no sirve, usar `observe()` callbacks + exponer SSE propio.
  Documentar el wire resultante. Confirmar que da granularidad: text delta, tool
  call/result, thinking, operation boundaries, subagente.
- Confirmar Docker + Cloudflare reales y el backing/cadencia de releases.

### WS1 — Template de agente Flue (esqueleto TS, assets del convertidor)
- Esqueleto Flue fijo (la "fachada" que el convertidor copia): `createAgent()`
  base, layout de `src/skills/`, wiring de tools/subagentes/MCP, server de
  prompts (HTTP/SSE), `Dockerfile` + config Cloudflare (`wrangler`).
- Endurecer model-swap (specifier → provider) y deploy multi-target.

### WS2 — Convertidor `packages/converter` (TS, determinista, sin LLM)
- **Lector Claude Code → agente Flue** (casi 1:1):
  `CLAUDE.md`→`instructions`; `.claude/agents/*.md`→`defineAgentProfile()`;
  `.claude/skills/*`→`SKILL.md` copiados; MCP config→`connectMcpServer()`;
  settings→`model` specifier. Documentar lo que no mapea (hooks, permissions).
- **Proveedor + modelo elegibles en la conversión** (feature central): el
  convertidor acepta un specifier de destino (`anthropic/…`, `openai/…`,
  `google/…`, `openrouter/…`). Por defecto toma el modelo del agente Claude Code
  (Anthropic), pero permite **cambiar de proveedor y modelo** para el agente que
  se deployará. Valida el specifier y cablea el paquete de proveedor + el
  `apiKeyEnv` correctos en el output.
- **Emisión**: proyecto Flue autónomo (copia del template fijo + slots generados),
  listo para `docker build` / `wrangler deploy`. Salida determinista (misma
  entrada + mismo specifier → misma salida).

### WS3 — Integración en Fleet (core + frontend)
- **Nuevo adapter** `packages/core/src/adapters/flue.ts` (implementa
  `agent-adapter.ts`, junto a `a2a.ts`/`acp.ts`): cliente del protocolo Flue,
  mapea eventos → `RunEvent`. Sumar `connectFlue(url)` en `core.ts` y `kind:
  a2a|acp|flue` en `state/db.ts`.
- **Extender `neutral.ts`** `RunEvent` con `mcp.*`, `memory.*`, `skill.*`,
  `thinking.*` (texto/tool/subagent/interrupt ya existen, líneas 48-55).
- **Frontend**: activar `ThinkingBlock` (ya implementado, dormido,
  `TerminalPanel.tsx:64-265`) + render de mcp/memory/skill; espejar tipos en
  `frontend/src/lib/api.ts`.
- **Esquema compartido** opcional `packages/protocol` (TS + JSON schema del wire
  neutral), consumido por adapter + frontend.
- Docs/skills de Fleet: `.claude/skills/flue-adapter/` y `converter/`; actualizar
  `ARCHITECTURE.md`/`CLAUDE.md`/`ROADMAP.md`; reemplazar
  `docs/scaffolding-migration-prompt.md`.

### WS4 — Verificación end-to-end
Convertir un agente Claude Code real → agente Flue → `docker build`+`run` (y/o
`wrangler deploy`) → `connectFlue(url)` en Fleet → confirmar que la traza completa
**se renderiza en la UI** (`run/operation → thinking → tool/mcp/memory/skill →
results → subagent → text deltas → run_end` con usage). Luego **convertir el mismo
agente apuntando a otro proveedor** (ej. `anthropic/…` → `openai/…`) y/o cambiar el
modelo en la config, y reconfirmar que corre — prueba el feature central de
proveedor/modelo elegible.

## Orden / dependencias

**WS0 primero y bloqueante** (define el wire real de Flue). Luego **WS1**, y con el
wire claro **WS2 y WS3 en paralelo**. WS4 cierra. Ciclo de vida de contenedores
desde Fleet queda fuera de v1 (deploy manual/CI; Fleet conecta por URL).

## Archivos clave (en `vigia-agents`)

- **Nuevos**: `packages/converter/` (TS + template Flue como assets),
  `packages/core/src/adapters/flue.ts`, `packages/protocol/` (opcional),
  bloques mcp/memory/skill en `frontend/.../TerminalPanel/`.
- **Modificar**: `packages/core/src/{neutral.ts, core.ts, api.ts, state/db.ts}`,
  `frontend/src/lib/api.ts`, `ARCHITECTURE.md`, `CLAUDE.md`, `ROADMAP.md`,
  `docs/scaffolding-migration-prompt.md`.

## Verificación
1. `pnpm --filter @inteliside/gateway-core test` + typecheck verdes.
2. Tests del convertidor: convertir un fixture Claude Code y validar el agente Flue
   emitido (determinista).
3. Smoke E2E de WS4 con agente y modelo real.

## Decisiones abiertas para el equipo de Fleet
- ¿El convertidor emite un **manifiesto neutral** + agente Flue, o **Flue directo**?
  (Hoy Fleet no consume el Contract — `db.ts:2-8`.)
- Mecanismo de stream de Flue: `/runs/<id>/stream` vs `observe()` + SSE propio
  (resultado de WS0).
- Versión de `@flue/runtime` a fijar; política ante breaking changes.
- HITL (`interrupt.*`) en v1 o v2. Nombre del adapter (`flue` provisorio).

## Fuera de alcance (futuro)
Lectores Codex y Pi. A2A para orquestación agente-a-agente. Gestión de contenedores
desde Fleet. Memoria vectorial (Flue solo da persistencia de sesión; memoria por MCP).
