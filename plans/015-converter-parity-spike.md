# Plan 015 (SPIKE): Diseñar la paridad completa Claude Code → Flue (I-PR3 / I-PR4)

> **Executor instructions**: Este es un plan de INVESTIGACIÓN + DISEÑO + UN
> prototipo pequeño. NO implementes I3–I8 completos. Tu entregable es un
> documento de diseño y un prototipo verificable de un solo item. Sigue los
> pasos y respeta las STOP conditions. Al terminar, actualiza la fila de este
> plan en `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5ee2124..HEAD -- packages/converter docs/BACKLOG.md`
> Si el converter cambió mucho, revisa que los gaps de "Current state" siguen
> vigentes antes de invertir tiempo.

## Status

- **Priority**: P2
- **Effort**: M (spike acotado; la implementación posterior es aparte)
- **Risk**: MED (algunos paths dependen de APIs experimentales de @flue)
- **Depends on**: none
- **Category**: direction (feature) / migration
- **Planned at**: commit `5ee2124`, 2026-06-14

## Why this matters

El objetivo de producto de Fleet es que **el agente convertido pueda hacer todo
lo que hacía el proyecto Claude Code original**. Hoy la conversión es parcial:
hay capacidades que se pierden silenciosamente o quedan inertes. La
investigación ya existe en `docs/BACKLOG.md` (sección I, "Conversión COMPLETA —
paridad Claude Code → Flue"), pero no está convertida en un diseño accionable ni
priorizada en slices. Este spike produce ese diseño para que la implementación
(I-PR3 / I-PR4) sea ejecutable por un modelo más simple, con la API de `@flue`
ya verificada.

## Current state

Los gaps de paridad (según `docs/BACKLOG.md` sección I — trátalos como **leads a
verificar**, confirma cada `file:line` tú mismo):

| Item | Gap | Lead (verificar) | Slice |
|------|-----|------------------|-------|
| I3 | Tools de API vía `defineTool` + `fetch`: emitir wrappers para integraciones HTTP del proyecto fuente que no son MCP | firma `ToolDefinition` en runtime `.d.mts` ~208-217 | I-PR3 |
| I4 | Expandir los `@`-imports del `CLAUDE.md` al convertir (hoy el token queda literal e inservible); reportar los irresolubles | `packages/converter/src/read.ts:~25` | I-PR3 |
| I5 | Slash commands → skills Flue: `.claude/commands/` hoy ni se escanea; un command es un prompt `.md` → mapeo natural a skill | `read.ts:~20-61`, `types.ts:~9-27` | I-PR3 |
| I8 | Bloque `env` de settings al factory: el `createAgent(() => ...)` emitido no destructura `env`; cablearlo para que `env.X` exista dentro del agente | `packages/converter/src/emit.ts:~157` | I-PR3 |
| I6 | Reporte de paridad por target (tabla honesta "qué puede este agente en este target"); itemizar hooks (evento+comando) y permissions; arreglar bug CLI que imprime `[object Object]` | `cli.ts:~45`, `read.ts:~44-49` | I-PR4 |
| I7 | Frontmatter extra de subagentes (`tools`, `skills`, `thinkingLevel`) — `defineAgentProfile` los acepta; cablearlos | `read.ts:~101-108` | I-PR4 |

- El converter es **determinístico, sin LLM** (ver `docs/adr/0010-deterministic-converter.md`) — cualquier diseño debe seguir siéndolo.
- Targets: el reporte de paridad importa porque Cloudflare Workers no tiene
  shell/fs/stdio (ver `emit.ts` comentarios sobre `unmapped` y CF).
- Convenciones del converter: `read.ts` parsea el proyecto a un `ClaudeProject`
  (tipos en `types.ts`); `emit.ts` produce los `FlueFile`s; `write.ts` los
  escribe. La paridad se logra extendiendo read (capturar más) + emit (producir
  el equivalente Flue).

## Commands you will need

| Purpose                 | Command                                                       | Expected |
|-------------------------|--------------------------------------------------------------|----------|
| Tests converter         | `pnpm --filter @inteliside/gateway-converter test`           | exit 0   |
| Typecheck converter     | `pnpm --filter @inteliside/gateway-converter typecheck`      | exit 0   |
| Inspeccionar API Flue   | leer los `.d.mts` de `node_modules/@flue/runtime` y `@flue/sdk` | —      |

## Suggested executor toolkit

- Usa el skill `flue-client` (y sus `references/flue-wire.md` / `flue-authoring.md`)
  para verificar las APIs de `@flue` ANTES de diseñar — regla #4 del repo:
  "Never invent Flue wire behavior".
- Si `context7` está disponible, consulta la doc de Flue para `defineTool`,
  `defineAgentProfile` y skills.

## Scope

**In scope** (entregables del spike):
- `docs/converter-parity-design.md` (crear) — el documento de diseño.
- UN prototipo pequeño y verificable de **I8** (env wiring) — el más acotado y
  autocontenido — en `packages/converter/src` + su test, SOLO si pasa typecheck
  y tests. Si el prototipo se complica, déjalo como pseudo-código en el doc y
  marca el item como "pendiente de implementación".

**Out of scope**:
- Implementar I3, I4, I5, I6, I7 completos. Eso son los PRs I-PR3/I-PR4 reales,
  que se planifican por separado a partir de este diseño.
- Cambiar el comportamiento determinístico del converter.

## Git workflow

- Branch: `spike/015-converter-parity`
- Commits: `docs(converter): parity design (I-PR3/I-PR4 spike)` y, si hay
  prototipo, `feat(converter): wire settings env into emitted factory (I8)`
- No push/PR salvo que el operador lo pida.

## Steps

### Step 1: Verificar cada gap contra el código real

Para cada item (I3–I8), abre el `file:line` indicado y confirma que el gap sigue
existiendo. Anota en el doc el estado real (citando el código actual). Si alguno
ya está resuelto, márcalo como hecho y exclúyelo.

**Verify**: tienes una lista confirmada de gaps vigentes con evidencia `file:line`.

### Step 2: Verificar las APIs de `@flue` necesarias

Para cada item, localiza la API de Flue que produce el equivalente:
- I3 → la firma exacta de `defineTool` / `ToolDefinition` (params, execute).
- I5 → cómo se define una skill en Flue (formato `SKILL.md`, ubicación).
- I7 → qué campos acepta `defineAgentProfile` (`tools`, `skills`, `thinkingLevel`).
- I8 → cómo el factory `createAgent(() => ...)` recibe/expone `env`.

Cita la fuente (archivo `.d.mts` con línea, o la referencia del skill `flue-client`).

**Verify**: cada item tiene su API de destino documentada y verificada (no inventada).

### Step 3: Escribir `docs/converter-parity-design.md`

Estructura:
- Una sección por item (I3–I8): qué se captura hoy, qué se pierde, la API Flue de
  destino, el cambio concreto en `read.ts`/`emit.ts`/`types.ts`, y casos límite
  (p.ej. `@`-imports circulares o inexistentes en I4; commands con argumentos en I5).
- Definición de los dos slices: **I-PR3 = I3+I4+I5+I8**, **I-PR4 = I6+I7**, cada
  uno con un tamaño estimado y orden sugerido.
- Una sección "Preguntas abiertas" con lo que requiera decisión humana (p.ej.
  ¿los slash commands con argumentos se mapean a skills o se reportan como
  unmapped? ¿el reporte de paridad I6 va al stdout del CLI, a un archivo, o a la
  Gateway API?).
- Un fixture propuesto: un proyecto Claude Code de prueba con `@`-imports, un
  tool HTTP, un slash command y un subagente con frontmatter extra, para validar
  la conversión completa cuando se implemente.

**Verify**: el doc existe y cubre los 6 items + slices + preguntas abiertas.

### Step 4 (opcional): Prototipo de I8 (env wiring)

Solo si es acotado: implementa que el `env` del settings del proyecto fuente se
destructure/exponga en el factory emitido (`emit.ts:~157`), con un test en
`packages/converter/test/` que convierta un proyecto con un bloque `env` y
verifique que el archivo emitido referencia `env.X`.

**Verify**: `pnpm --filter @inteliside/gateway-converter test` y `typecheck`
exit 0. Si no llegas a un prototipo limpio, déjalo como pseudo-código en el doc
(no rompas la suite).

## Test plan

- Spike: la "prueba" principal es el documento de diseño revisable.
- Si se hace el prototipo I8: un test nuevo en `packages/converter/test/` que
  siga el patrón de `packages/converter/test/convert.test.ts`.

## Done criteria

- [ ] `docs/converter-parity-design.md` existe con una sección por I3–I8, los dos
      slices definidos, y preguntas abiertas
- [ ] Cada item tiene la API de Flue de destino verificada (no inventada), con
      cita de fuente
- [ ] El fixture de prueba está especificado (aunque no implementado)
- [ ] (Si se hizo) el prototipo de I8 pasa `test` + `typecheck` del converter
- [ ] El comportamiento del converter sigue siendo determinístico
- [ ] Fila de este plan actualizada en `plans/README.md`

## STOP conditions

- Una API de Flue que un item necesita NO existe o es inestable en la versión
  instalada (`@flue/runtime` / `@flue/sdk` 0.10.x): documéntalo como bloqueante
  en "Preguntas abiertas" y NO inventes el wire (regla #4).
- El prototipo de I8 requiere cambios fuera de `packages/converter`: déjalo como
  diseño y reporta.
- Descubres que un gap ya fue resuelto: márcalo hecho y sigue con el resto.

## Maintenance notes

- Este diseño alimenta dos PRs futuros (I-PR3, I-PR4). Cuando se implementen,
  cada uno debe cerrar su parte del fixture de prueba.
- El reporte de paridad por target (I6) es especialmente valioso para Cloudflare
  (sin shell/fs/stdio): mantenerlo honesto evita prometer capacidades que el
  target no tiene.
