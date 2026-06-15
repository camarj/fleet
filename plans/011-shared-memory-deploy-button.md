# Plan 011: Botón UI para desplegar el servidor de memoria compartida (orgMemory.deployServer)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP condition" occurs, stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5ee2124..HEAD -- frontend/src/App.tsx frontend/src/components/Settings/OrgSection.tsx frontend/src/lib/api.ts`
> If any changed, compare the "Current state" excerpts against live code before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW (UI puramente aditiva)
- **Depends on**: none
- **Category**: direction (feature)
- **Planned at**: commit `5ee2124`, 2026-06-14

## Why this matters

El backend de la memoria compartida (J4 / Engram) está **completo**: el request
`orgMemory.deployServer` y los eventos `orgMemory.progress/log/deployed/error`
existen tanto en el Core (`packages/core/src/api.ts`) como en los tipos del
frontend (`frontend/src/lib/api.ts:306`). Pero **ningún componente lo invoca**:
no hay forma de desplegar el servidor Engram de la org desde la UI. La memoria
compartida es inalcanzable para el usuario final aunque el código la soporte.
Este plan añade el disparador en la sección Organization de Settings.

## Current state

Todo lo necesario YA existe en los tipos; solo falta la UI que lo use.

- `frontend/src/lib/api.ts` (ya definido, NO modificar):
  - Request: `| { type: "orgMemory.deployServer"; orgSlug?: string; allowedProjects?: string[] };` (línea ~306)
  - Eventos servidor: `orgMemory.progress` (`{ step, detail? }`), `orgMemory.log`
    (`{ lines: string[] }`), `orgMemory.deployed` (`{ composeId, composeName, reused }`),
    `orgMemory.error` (`{ message }`) (líneas ~415-420).
- `frontend/src/App.tsx` — patrones a imitar:
  - Envío de requests: `client.send({ type: "org.sync" })`.
  - Handler ejemplo (línea ~278):
    ```ts
    const handleSyncOrg = () => {
      setOrgError(null);
      client.send({ type: "org.sync" });
    };
    ```
  - Manejo de eventos entrantes: cadena `if/else if (e.type === "...")` (líneas
    ~222-242). Ej.:
    ```ts
    } else if (e.type === "org.synced") {
      setOrgStatus((prev) => (prev ? { ...prev, lastSyncedAt: e.at } : prev));
    } else if (e.type === "org.error") {
      setOrgError({ message: e.message, requestType: e.requestType });
    }
    ```
  - `OrgSection` se renderiza con callbacks como props (línea ~442:
    `onSyncOrg={handleSyncOrg}`).
- `frontend/src/components/Settings/OrgSection.tsx`:
  - Recibe callbacks en `Props` (líneas 23-39).
  - El estado **bound** (líneas 246-379) muestra info de la org, Sync/Leave,
    Members, y "Share your agents". El rol está en `orgStatus.role`
    (`"owner" | "member"`).
  - Patrón de botón de acción: ver `onSyncOrg` (líneas 272-275) y los botones
    `btn-ghost`/`btn-primary`.

## Commands you will need

| Purpose         | Command                                               | Expected |
|-----------------|-------------------------------------------------------|----------|
| Install         | `pnpm install`                                        | exit 0   |
| Build frontend  | `pnpm --filter @inteliside/gateway-frontend build`    | exit 0   |
| Dev (manual)    | `pnpm --filter @inteliside/gateway-frontend dev`      | sirve en :1420 |

## Suggested executor toolkit

- Si está disponible, usa el skill `transcript-panel`/`react-flow-canvas` solo
  como referencia de convenciones React del repo; este plan no las necesita.

## Scope

**In scope**:
- `frontend/src/App.tsx` (handler + manejo de eventos + pasar props)
- `frontend/src/components/Settings/OrgSection.tsx` (nueva sección UI)

**Out of scope** (NO tocar):
- `frontend/src/lib/api.ts` — los tipos YA existen; no los toques.
- `packages/core/**` — el backend ya está completo. Si crees que falta algo en
  el Core, es una STOP condition (no es así según el commit planeado).
- La regla #11 de `CLAUDE.md` (espejar api.ts) NO aplica aquí porque no se
  modifica ninguna API.

## Git workflow

- Branch: `feat/011-shared-memory-deploy-button`
- Commit: `feat(frontend): add shared-memory (Engram) deploy button to org settings`
- No push/PR salvo que el operador lo pida.

## Steps

### Step 1: Estado y handler en App.tsx

Añade estado para el progreso del deploy (imitando `orgError`/`orgStatus`):

```ts
const [orgMemoryStatus, setOrgMemoryStatus] = useState<
  { state: "idle" | "deploying" | "done" | "error"; detail?: string }
>({ state: "idle" });
```

Añade el handler (junto a `handleSyncOrg`):

```ts
const handleDeployOrgMemory = () => {
  setOrgMemoryStatus({ state: "deploying" });
  client.send({ type: "orgMemory.deployServer" }); // orgSlug por defecto = org actual
};
```

**Verify**: `pnpm --filter @inteliside/gateway-frontend build` → exit 0.

### Step 2: Manejar los eventos orgMemory.* entrantes

En la cadena `if/else if (e.type === ...)` (junto a `org.error`), añade:

```ts
} else if (e.type === "orgMemory.progress") {
  setOrgMemoryStatus({ state: "deploying", detail: e.step + (e.detail ? `: ${e.detail}` : "") });
} else if (e.type === "orgMemory.deployed") {
  setOrgMemoryStatus({ state: "done", detail: e.reused ? "Ya estaba desplegado (reusado)" : "Desplegado" });
} else if (e.type === "orgMemory.error") {
  setOrgMemoryStatus({ state: "error", detail: e.message });
}
```

(El evento `orgMemory.log` con `lines` es opcional de mostrar; puedes ignorarlo
o acumularlo en un `<pre>`. No es obligatorio para este plan.)

**Verify**: `pnpm --filter @inteliside/gateway-frontend build` → exit 0.

### Step 3: Pasar props a OrgSection

Donde se renderiza `<OrgSection ... />` (línea ~442), añade:

```tsx
onDeployOrgMemory={handleDeployOrgMemory}
orgMemoryStatus={orgMemoryStatus}
```

Y extiende `Props` en `OrgSection.tsx`:

```ts
onDeployOrgMemory: () => void;
orgMemoryStatus: { state: "idle" | "deploying" | "done" | "error"; detail?: string };
```

(Añade ambos a la lista de parámetros desestructurados de `OrgSection`.)

**Verify**: `pnpm --filter @inteliside/gateway-frontend build` → exit 0 (sin
errores de TS por props faltantes).

### Step 4: UI en OrgSection (estado bound, solo owner)

En el bloque **bound** (después de "Share your agents", antes del `</>` de
cierre, ~línea 377), añade una sección visible **solo si `orgStatus.role === "owner"`**
(solo el dueño despliega infraestructura de la org):

```tsx
{orgStatus.role === "owner" && (
  <>
    <p className="settings-group-label">Shared memory server</p>
    <p className="settings-note">
      Despliega el servidor de memoria compartida (Engram) de la organización.
      Los agentes de la org podrán compartir memoria a través de él.
    </p>
    <div className="org-actions-row">
      <button
        className="btn-primary"
        onClick={onDeployOrgMemory}
        disabled={!connected || orgMemoryStatus.state === "deploying"}
      >
        {orgMemoryStatus.state === "deploying" ? "Desplegando…" : "Deploy memory server"}
      </button>
    </div>
    {orgMemoryStatus.detail && (
      <p className={`settings-note${orgMemoryStatus.state === "error" ? " org-error" : ""}`}>
        {orgMemoryStatus.detail}
      </p>
    )}
  </>
)}
```

Reutiliza las clases CSS existentes (`settings-group-label`, `settings-note`,
`org-actions-row`, `btn-primary`, `org-error`) — ya están definidas y usadas en
este mismo archivo.

**Verify**: `pnpm --filter @inteliside/gateway-frontend build` → exit 0.

### Step 5: Verificación manual (si hay entorno)

Si tienes un Core corriendo y una org con rol owner: abre Settings →
Organization, confirma que aparece "Deploy memory server", púlsalo y observa que
el estado cambia a "Desplegando…" y luego a un mensaje de éxito o error. (Si no
hay entorno, omite — el build es la verificación mínima.)

## Test plan

- No hay infraestructura de tests en el frontend todavía (ver hallazgo separado
  TEST-01). Por eso la verificación principal de este plan es el **build de TS**
  (`pnpm --filter @inteliside/gateway-frontend build`) + la verificación manual
  opcional del Step 5.
- Si el plan de tests de frontend ya aterrizó cuando ejecutes esto, añade un
  test que monte `OrgSection` con `orgStatus.role==="owner"` y verifique que el
  botón "Deploy memory server" se renderiza y llama `onDeployOrgMemory` al click.

## Done criteria

- [ ] `pnpm --filter @inteliside/gateway-frontend build` exit 0
- [ ] En `OrgSection.tsx`, el botón aparece solo en estado bound y solo para
      `orgStatus.role === "owner"` (revisar el JSX)
- [ ] `App.tsx` envía `orgMemory.deployServer` al hacer click y refleja
      `orgMemory.progress/deployed/error` en el estado
- [ ] `frontend/src/lib/api.ts` NO fue modificado (`git diff --name-only`)
- [ ] Solo `App.tsx` y `OrgSection.tsx` modificados
- [ ] Fila de este plan actualizada en `plans/README.md`

## STOP conditions

- El request `orgMemory.deployServer` o los eventos `orgMemory.*` NO existen en
  `frontend/src/lib/api.ts` en el commit que tienes (drift): para y reporta — el
  backend cambió.
- Necesitas modificar `packages/core` para que el botón funcione: para y reporta
  (no debería hacer falta).

## Maintenance notes

- Si más adelante se quiere exponer `orgSlug`/`allowedProjects` como campos
  editables, añadir inputs en esta misma sección (el request ya los acepta).
- El estado `orgMemoryStatus` se reinicia al cerrar/reabrir Settings (igual que
  el resto del estado de org en G1) — aceptable para v1.
- Revisar en PR: que el botón quede deshabilitado mientras `state==="deploying"`
  para evitar dobles envíos.
