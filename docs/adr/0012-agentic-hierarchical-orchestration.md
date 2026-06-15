# ADR-12 — Orquestación agéntica jerárquica (revisa la regla DAG-only)

> **Status**: accepted (2026-06-15). Revisa la regla #10 de `CLAUDE.md`.
> Implementación pendiente (issue #53).

## Contexto

Hasta ahora la orquestación era **DAG-only**: el Core ejecutaba un grafo
declarativo de nodos fijos (`input`/`agent`/`output`), sin un coordinador que
razonara sobre qué agente usar ni cómo sintetizar. El objetivo de producto es que
el operador describa un objetivo y el sistema decida cómo cumplirlo con varios
agentes especializados.

## Decisión

Se añade un **Orchestrator agéntico**: un agente coordinador (con razonamiento
propio) que recibe un objetivo, descubre las Capabilities de los Agents
registrados (vía sus Agent Cards), **delega** tareas a ellos y sintetiza el
resultado. La topología es **jerárquica (hub-and-spoke)**: los Agents delegados
**no se comunican entre sí**, solo a través del Orchestrator — lo que preserva
trazabilidad y gobernanza.

El **Workflow DAG declarativo** actual se **conserva** como modo alternativo para
flujos deterministas; el modo se elige por flujo.

## Por qué

- Un coordinador con razonamiento resuelve objetivos abiertos que un DAG fijo no
  puede expresar (qué agente, cuándo, cómo combinar).
- La topología jerárquica (vs. peer-to-peer) mantiene un único punto de
  coordinación: más fácil de observar, auditar y gobernar.
- Conservar el DAG evita perder lo que ya funciona para flujos deterministas.

## Costura de implementación

Reutiliza el seam existente: el `Orchestrator` ya recibe un `AgentRunner`
inyectado y el motor neutral. El modo agéntico se añade junto al DAG, no en lugar
de él.

## Alternativas rechazadas

- **Peer-to-peer** (agentes que se descubren y delegan entre sí): rechazado en
  v1 — más difícil de gobernar y observar; la coordinación central es el patrón
  que el producto quiere.
- **Seguir DAG-only**: rechazado — no expresa delegación dinámica ni objetivos
  abiertos.

## Consecuencias

- La regla #10 de `CLAUDE.md` ("orchestration DAG-only") queda revisada.
- Aparece un nuevo lenguaje de dominio: Orchestrator (agéntico), Delegation,
  Capability, Agent Card (ver `CONTEXT.md`).
