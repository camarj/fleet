# ADR-7 — `OrgManager` como seam de pruebas

`OrgManager` depende de la interfaz `OrgRegistry`, no de su implementación. En
tests, un `FakeRegistry` reemplaza a `GitHubRegistry`, de modo que la máquina de
estados y el algoritmo de reconcile se prueban sin ningún proceso `gh` ni acceso
a red. El ejecutor de `gh` (`GhExecFn`) también es inyectable.

Lo elegimos así para tener tests unitarios deterministas y rápidos del subsistema
de organizaciones sin tocar GitHub.

Referenciado en `packages/core/src/org/org-manager.ts` y
`packages/core/src/org/github-registry.ts`.
