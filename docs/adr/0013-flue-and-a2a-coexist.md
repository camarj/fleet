# ADR-13 — Flue y A2A conviven (revisa la regla Flue-only)

> **Status**: accepted (2026-06-15). Revisa la regla #1 de `CLAUDE.md`
> ("Fleet is Flue-only — A2A and ACP were removed") y matiza ADR-8.
> Implementación pendiente (issue #53).

## Contexto

La arquitectura previa era **Flue-only**: A2A y ACP se habían retirado y
`FlueAdapter` era el único adapter. El pivote a orquestación distribuida (ADR-12)
necesita una capa estandarizada de coordinación agente↔agente e
interoperabilidad con agentes de terceros — justo lo que A2A provee y Flue no
fue diseñado para cubrir (Flue es runtime de un agente, no coordinación entre
agentes).

## Decisión

**A2A se reintroduce y convive con Flue**, en capas distintas:

- **Flue = runtime**: cómo corre y se sirve el agente que Baton convierte y
  despliega. Sigue siendo el camino nativo (ADR-8 intacto en eso).
- **A2A = coordinación**: cómo el Orchestrator delega a los Agents y cómo se
  incorporan agentes externos (de terceros). Cada Agent publica un Agent Card.

Se implementa un `A2aAdapter` (`kind: "a2a"`) en el directorio `foreign/` —el
placeholder ya previsto para agentes no-Flue— que traduce A2A al **neutral run
model** (ADR-3), igual que `FlueAdapter` traduce Flue. El resto del Core y el
frontend siguen viendo solo el modelo neutral.

## Por qué

- Conservar Flue protege todo el trabajo de Converter/Deployer; A2A se suma
  encima sin tirar nada — opción de menor riesgo y mayor reutilización.
- A2A estandariza capabilities y tareas stateful, y permite orquestar agentes de
  terceros (interoperabilidad).
- El neutral run model como contrato universal hace que añadir A2A no toque la
  Gateway API ni el frontend.

## Alternativas rechazadas

- **A2A reemplaza a Flue** (agentes A2A-nativos, deprecar Flue): rechazado —
  rework mayor que tira converter/deployer.
- **Seguir Flue-only**: rechazado — Flue no cubre coordinación inter-agente ni
  interop con terceros.

## Consecuencias

- La regla #1 de `CLAUDE.md` queda revisada: el sistema deja de ser Flue-only.
- `AgentKind` pasa de `"flue"` a `"flue" | "a2a"`.
- ACP sigue fuera de alcance (ver issue #53, Out of Scope).
