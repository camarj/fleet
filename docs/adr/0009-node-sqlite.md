# ADR-9 — Almacenamiento local con `node:sqlite` (no `better-sqlite3`)

El Core usa el módulo **`node:sqlite` integrado en Node** (22.5+/24) para su store
local (`agents`, `configs`, `sessions`, `usage`, `org_agents`), en lugar de
`better-sqlite3`.

Lo elegimos así porque `better-sqlite3` no compiló, y más en general un módulo
nativo complica el empaquetado del Core como sidecar (esbuild + Node SEA): con
`node:sqlite` hay **cero build nativo**.

La consecuencia es que Fleet **requiere Node ≥ 22.18** (el built-in no existe en
versiones anteriores). Aceptable: Flue ya exige esa versión.

Referenciado en `packages/core/src/state/db.ts` y `ARCHITECTURE.md`.
