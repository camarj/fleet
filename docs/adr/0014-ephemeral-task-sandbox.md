# ADR-14 — Sandbox de ejecución: `SandboxAdapter` pluggable (Docker+gVisor default, microVM opcional)

> **Status**: accepted (2026-06-15). Implementación pendiente (issue #53).

## Contexto

Cuando un Agent expone una capacidad "como servicio" (vía A2A) pero esa capacidad
necesita un filesystem escribible —clonar un repo, analizarlo, modificar
código— hace falta un entorno de ejecución real detrás de la interfaz de
servicio. "Como servicio" no significa "función sin disco": la interfaz es un
servicio; por dentro, el Agent provisiona un workspace.

Dos hechos condicionan la decisión:

1. **Baton es open-source.** No se puede asumir nada sobre el hardware del
   operador que clona el proyecto. El aislamiento por **microVM**
   (Firecracker/E2B/Kata) requiere **KVM por hardware** — es decir, bare metal o
   un servidor con virtualización expuesta. La mayoría de quienes clonen estarán
   en un VPS, una VM de Oracle o un laptop, que corren Docker pero **no** exponen
   KVM. Acoplar el sandbox a microVM impondría bare metal a todos.
2. **Nivel de confianza del código.** Para Inteliside (y el caso típico) el Agent
   ejecuta código **propio** sobre infra **propia**: el agente es un usuario, no
   un adversario. Ese tier no necesita aislamiento de microVM.

## Decisión

Introducir un **`SandboxAdapter` pluggable** — el mismo patrón que el
`AgentAdapter` del proyecto, aplicado a la capa de ejecución. La semántica es
**efímera por tarea**: provisionar → ejecutar el trabajo stateful → devolver el
artefacto (diff/PR/logs) → destruir.

- **Default universal**: contenedor **Docker efímero** por tarea, con **gVisor
  (`runsc`)** opcional cuando el host lo tiene. gVisor intercepta syscalls en
  espacio de usuario (**no requiere KVM**) y se instala como runtime alternativo
  de Docker, así que **convive con Dokploy** en el mismo servidor: Dokploy usa
  `runc` para sus apps persistentes; los sandboxes del Agent usan `runsc`. Mismo
  daemon, cero infraestructura paralela.
- **Adapter opcional de microVM** (Firecracker/E2B/Kata): se activa **solo si se
  detecta `/dev/kvm`**, para operadores con bare metal que necesiten aislamiento
  a nivel de kernel.

## Defaults seguros de fábrica

Como es open-source, quien clona no leerá el threat model antes de levantarlo. El
default debe venir seguro:

- Red **default-deny** (salidas solo por allowlist).
- Rootfs de **solo lectura**, capabilities recortadas, límites de CPU/RAM/PIDs.
- **Nunca** montar `/var/run/docker.sock` en el contenedor del Agent (escape de
  una línea).
- Workspace **efímero**, destruido al terminar la tarea.

## Por qué

- El **mínimo común denominador** (Docker, sin KVM) corre en la infra de
  cualquiera que clone Baton → es la única opción que respeta la portabilidad de
  un proyecto open-source y el principio anti-lock-in.
- gVisor da un **aislamiento intermedio** honesto (más fuerte que contenedores,
  más débil que VM) sin exigir KVM — suficiente para código propio o generado
  por LLM.
- El seam pluggable deja que el operador con KVM enchufe microVM sin tocar el
  core, y que el resto corra con el default universal.

## Convivencia con Dokploy (pregunta original)

Sí, E2B/Firecracker y Dokploy pueden coexistir en un mismo servidor, pero **el
decisor es el hardware (KVM), no Dokploy** — están en capas distintas y no pelean
por el mismo recurso. Aun así, Baton **no se acopla** a ese escenario: microVM es
un adapter opcional, no el default.

## Alternativas rechazadas

- **Acoplar a microVM (E2B/Firecracker) en v1**: rechazado — exige KVM/bare metal
  a todo el que clone; rompe la portabilidad open-source.
- **Workspace persistente por sesión** (Daytona/Sprites) en v1: diferido (más
  estado que gobernar).
- **Ejecutar tools en el proceso local del Core**: rompe el aislamiento y el
  modelo "agente como servicio".

## Consecuencias

- Nueva costura `SandboxAdapter` (independiente del Deploy target del Agent),
  con implementación Docker(+gVisor) como default y microVM como adapter opcional.
- El README debe documentar el **trust tier**: Docker(+gVisor) basta para código
  propio o generado por LLM; subir a microVM+KVM solo si el operador expone Baton
  como servicio multitenant con código no confiable de terceros.
- El Sandbox (runtime de ejecución) se distingue del Agent (loop de razonamiento)
  en el glosario (`CONTEXT.md`).
