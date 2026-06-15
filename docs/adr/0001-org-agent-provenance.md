# ADR-1 — Provenance de un agente vía fila `org_agents`

La presencia de una fila en la tabla `org_agents` es la única fuente de verdad
del origen de un agente: si existe la fila, el agente proviene del Org registry;
si no, es local. Es simétrico con cómo `getDeploy`/`hasDeploy` identifican los
despliegues locales.

Lo elegimos así para evitar un campo `origin` duplicado que pudiera
desincronizarse: una sola tabla de provenance manda.

Referenciado en `packages/core/src/state/db.ts` y `packages/core/src/core.ts`.
