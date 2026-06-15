# ADR-2 — `origin` se deriva, no se almacena

La Gateway API expone `origin: "local" | "org"` por cada agente para que el
frontend sepa cuáles son de solo-conexión. Ese valor se calcula en tiempo de
lectura a partir de la fila `org_agents` (ADR-1): `"org"` si la fila existe,
`"local"` si no. No es una columna almacenada.

Es la consecuencia directa de ADR-1: un único lugar de verdad, sin un segundo
campo que pueda desincronizarse.

Referenciado en `packages/core/src/api.ts` y `packages/core/test/org.test.ts`.
