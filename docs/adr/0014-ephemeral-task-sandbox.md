# ADR-14 — Sandbox efímero por tarea para ejecución con filesystem

> **Status**: accepted (2026-06-15). Implementación pendiente (issue #53).

## Contexto

Cuando un Agent expone una capacidad "como servicio" (vía A2A) pero esa capacidad
necesita un filesystem escribible —clonar un repo, analizarlo, modificar
código— hace falta un entorno de ejecución real detrás de la interfaz de
servicio. "Como servicio" no significa "función sin disco": significa que la
interfaz es un servicio; por dentro, el Agent provisiona un workspace.

## Decisión

Se introduce un **Sandbox efímero por tarea**: provisionar → ejecutar la tarea
stateful → devolver el artefacto (diff/PR/logs) → destruir. Se expone tras una
interfaz `SandboxProvider` con el proveedor **intercambiable y self-hosted**;
la implementación de v1 usa **microVM (Firecracker)** — a evaluar **E2B OSS** o
**microsandbox** sobre la infraestructura propia (bare metal / Oracle Cloud).

El **workspace persistente por sesión** (Daytona/Sprites) queda **fuera de v1**;
podría declararse por Agent Card más adelante.

## Por qué

- **Menor superficie operativa**: sin estado huérfano ni costos colgando entre
  tareas.
- **Encaja con A2A**: las tareas A2A son stateful y potencialmente long-running
  por diseño; el sandbox vive lo que dura la tarea.
- **Sin vendor lock-in**: microVM self-hosted da aislamiento a nivel de kernel
  para código no confiable, en infraestructura propia.

## Alternativas rechazadas

- **Workspace persistente por sesión** en v1: más potente para coding largo, pero
  más estado que gobernar; diferido.
- **Ejecutar tools en el proceso local del Core**: rompe el aislamiento y el
  modelo "agente como servicio".
- **Contenedor de kernel compartido** (vs microVM) para código de terceros:
  aislamiento más débil; insuficiente para multitenant no confiable.

## Consecuencias

- Nueva costura `SandboxProvider` (independiente del Deploy target del Agent).
- El Sandbox (runtime de ejecución) se distingue del Agent (loop de
  razonamiento) en el glosario (`CONTEXT.md`).
