# ADR-8 — Motor de agente: Flue (TypeScript) en lugar de DeepAgents (Python)

> **Status**: accepted — revisado por **ADR-13**. Flue sigue siendo el runtime
> nativo del agente; deja de ser el *único* wire (A2A se reintroduce como capa
> de coordinación). La elección Flue-sobre-DeepAgents sigue vigente.

## Contexto

El motor de agente original era DeepAgents (Python, proyecto Shipyard /
`vivero_agents`). Convertir un proyecto Claude Code a DeepAgents arrastraba
impedancias entre dos lenguajes y dos arquitecturas distintas.

## Decisión

Cambiar el motor de agente a **Flue (TypeScript)**. El converter emite agentes
Flue; el Core habla con ellos vía `FlueAdapter`. DeepAgents queda obsoleto como
código (sobreviven las ideas: fachada neutral, patrón converter).

## Por qué

- **Unifica el stack en TypeScript**: Core + converter + agente, todo TS. Adiós a
  Python en un repo TS.
- Flue corre en **Node (≥22.18) y Cloudflare Workers**, lo que habilita el deploy
  target `cloudflare`.
- **Espeja la arquitectura de Claude Code**: como la fuente del converter ES
  Claude Code, la conversión es casi 1:1 (skills `SKILL.md`, subagentes, MCP,
  thinking de primera clase, model specifier multi-proveedor).
- **Streaming/observabilidad nativos**: se mapea el stream de Flue al neutral run
  model en vez de escribir un servidor de traza propio.

## Riesgo asumido

Se decidió migrar sin spike previo. Flue era experimental (v0.10.x) y podía
romper APIs antes de 1.0. Mitigación: fijar la versión de `@flue/runtime` y
absorber el churn.

Fuente: `docs/handoff-flue-integration.md`.
