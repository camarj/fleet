# ADR-5 — Reconcile con prune + guards de defensa en profundidad

## Contexto

El Core sincroniza el directorio remoto del Org registry en su DB local y expone
las operaciones de org por la Gateway API, que el frontend consume.

## Decisión

**Reconcile + prune.** `reconcile()` hace pull del directorio remoto y lo
concilia en la DB local. La *prune hard rule* elimina localmente los agentes org
que ya no están en el directorio. El estado resultante se emite como `org.status`.

**Guards en el Core (defensa en profundidad).** Las invariantes se aplican en la
capa de la Gateway API, no solo en la UI, y a veces en dos capas. Por ejemplo, al
compartir un agente:

- no se puede compartir un agente org (es de solo-conexión, no eres el dueño);
- el target debe ser enrutable (ORG-06, validado en el Core *y* en `OrgManager`);
- no se puede compartir un agente protegido por token (ORG-07).

## Por qué

El registry remoto es la fuente de verdad, así que conciliar —incluido el prune—
mantiene la vista local correcta. Aplicar los guards en el Core garantiza las
invariantes aunque el frontend falle o sea sorteado.

## Limitación conocida (G1)

ORG-07 es *best-effort*: solo puede verificar el token de un agente que esté
registrado en memoria en la sesión actual. Un agente protegido por token pero
*offline* (aún no reconectado) puede compartirse sin detección. Es una limitación
asumida de G1 (`core.ts`).

Referenciado en `packages/core/src/org/org-manager.ts`,
`packages/core/src/org/registry.ts` y `packages/core/src/core.ts`.
