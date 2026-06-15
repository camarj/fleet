# ADR-3 — Diseño del Org registry

Decisiones de diseño del Org registry. El código las cita como sub-partes
`ADR-3a`, `ADR-3b` y `ADR-3d`.

## 3a — Formato de almacenamiento y last-write-wins

El registry guarda un archivo JSON por agente en `agents/<id>.json`. El `sha` por
archivo de la GitHub Contents API da un *last-write-wins* seguro: una escritura
contra un `sha` desactualizado se rechaza, evitando pisar cambios concurrentes.

## 3b — Máquina de estados del binding

El binding local de la Organization tiene tres estados y estas transiciones:

- `none → owner` vía `createOrg()`
- `none → member` vía `bindOrg()`
- `any → none` vía `leave()`

El rol se **deriva**, no se almacena: `owner` si `whoami === org.json.owner`,
en caso contrario `member`.

## 3d — Rol de `OrgManager`

`OrgManager` es el coordinador del subsistema: orquesta `OrgRegistry` (I/O remoto)
+ `OrgStore` (binding local) + `GatewayState` (DB). Es *data-only*; los eventos
WebSocket de la Gateway API los emite `core.ts`, no este módulo.

Referenciado en `packages/core/src/org/github-registry.ts` y
`packages/core/src/org/org-manager.ts`.
