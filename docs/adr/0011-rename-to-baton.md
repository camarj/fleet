# ADR-11 — Renombre del producto: Fleet → Baton

> **Status**: accepted (2026-06-15). Implementación de cara al producto pendiente
> (issue #53). El renombre de paquetes npm y del repositorio es deuda aparte.

El producto pasa a llamarse **Baton**. La metáfora es la del director de
orquesta: la *batuta* dirige la orquesta igual que el Orchestrator dirige a los
Agents. El nombre encaja con el pivote a orquestación de agentes distribuidos
(ADR-12), donde "dirigir" es la función central, mientras que "Fleet" (flota)
sólo evocaba un conjunto de agentes sin coordinador.

El renombre es de **producto y glosario**: `CONTEXT.md` adopta Baton y deja Fleet
en `_Avoid_`. El código y los paquetes (`@inteliside/gateway-*`, clase
`GatewayCore`, etc.) **conservan** "fleet"/"gateway" por inercia; renombrarlos es
deuda pendiente con coste real (igual que `docker-local`), no parte de este ADR.

## Alternativas consideradas

- Mantener "Fleet": rechazado — ya no describe la capacidad central (orquestar),
  solo el conjunto de agentes.
- "Maestro"/"Conductor": rechazados por colisión de marca (Conductor = orquestador
  de workflows de Netflix; Maestro muy usado).
- "Batuta" (español): se eligió la forma inglesa **Baton** por consistencia con
  el resto de la nomenclatura técnica.
