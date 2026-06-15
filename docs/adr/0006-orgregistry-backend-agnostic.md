# ADR-6 — `OrgRegistry` como interfaz backend-agnóstica

> Nota: el código no cita un "ADR-6". Esta decisión existía sin numerar; se
> documenta aquí para mantener la secuencia y porque cumple los criterios de ADR.

Todas las operaciones de org se definen en la interfaz `OrgRegistry`, y las
implementaciones lanzan un `OrgError` tipado (con un `code` enumerado) en vez de
un `Error` genérico. El único backend de G1 es `GitHubRegistry` (ADR-4).

Lo elegimos así para que un futuro backend *hosted* sea un cambio de una sola
clase (ORG-11): los callers ramifican por `code` sin hacer string-matching, así
que cambiar de backend no toca la lógica del Core.

Es una decisión distinta de ADR-4: aquel define *qué* backend usamos hoy
(GitHub); este define *que el backend sea intercambiable*.

Referenciado (sin número) en `packages/core/src/org/registry.ts`.
