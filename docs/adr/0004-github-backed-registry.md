# ADR-4 — Org registry sobre GitHub: membresía en vivo, sin tokens persistidos

## Contexto

Una Organization necesita un directorio de agentes compartidos y una lista de
miembros, sin levantar un servicio backend propio (alcance G1).

## Decisión

El backend del Org registry es un **repo privado de GitHub** accedido vía `gh api`
(Contents REST). La **membresía autoritativa son los collaborators vivos del
repo**: no se mantiene un `members.json`. Fleet **nunca persiste tokens** de
GitHub.

Todo queda detrás de la interfaz `OrgRegistry`, de modo que un futuro servicio
*hosted* sería un cambio de una sola clase.

## Por qué

- Reutiliza la autenticación y el control de acceso de GitHub: collaborators =
  miembros, sin gestión de permisos propia.
- Evita operar infraestructura propia para G1.
- No almacenar tokens reduce la superficie de secretos.

## Alternativas rechazadas

- **`members.json` en el repo:** se desincroniza de los permisos reales de GitHub.
- **Servidor central propio:** demasiada infraestructura para G1.

Referenciado en `packages/core/src/org/registry.ts`,
`packages/core/src/org/github-registry.ts` y `packages/core/src/core.ts`.
