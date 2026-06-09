# Análisis de gaps — Fleet más allá del handoff (2026-06-09)

> Análisis de qué falta en arquitectura, UI/UX y flujo de usuario que el
> handoff (`docs/handoff-flue-integration.md`, sección "Próxima sesión") NO
> está tomando en cuenta. Basado en exploración del código real en la rama
> `feat/flue-migration` (PR #1).

## Diagnóstico central

Fleet se define como **multiplexer + centro de operaciones** de agentes Flue.
Un centro de operaciones tiene dos obligaciones mínimas: **recordar** y
**controlar**. Hoy no cumple ninguna de las dos. El checklist del handoff
("verificar Fly/Cloudflare/github, model swap, dev DX") empuja hacia *más
targets de deploy*, cuando lo que la identidad del producto exige primero es
memoria y control sobre lo que ya deploya.

---

## 1. Arquitectura

### 1.1 La base de datos es `:memory:` por defecto (CRÍTICO)

- `packages/core/src/server.ts`: `GATEWAY_DB` defaultea a `:memory:`.
- Al reiniciar el Core se pierde TODO: agentes registrados, params de
  redeploy (tabla `deploys`), sesiones, usage.
- El botón "↻ Redeploy" recién construido depende de la tabla `deploys`…
  que se evapora al reiniciar.
- Está mencionado en el ROADMAP como nota, pero es **el bug de identidad
  del producto**. Arreglo: persistir a archivo en app-data (una línea de
  config + ruta por plataforma).

### 1.2 Sin ciclo de vida del agente deployado (CRÍTICO)

- No existe **stop / delete / disconnect** — ni en `ClientRequest`
  (`api.ts`) ni en la UI.
- No hay **health check continuo**: solo `waitReady` (60s) al arrancar. Si
  el contenedor muere, el adapter queda huérfano y el usuario se entera con
  un `model_error` críptico al chatear.
- Naming determinista `fleet-<agentName>`: dos proyectos distintos con el
  mismo slug se pisan entre sí.
- `freePort()` tiene una carrera TOCTOU (encuentra puerto, lo cierra, lo
  pasa a `docker run`) sin retry.

### 1.3 `agent.connectFlue` sin UI (CRÍTICO)

- El request existe en `api.ts` pero no hay pantalla para usarlo.
- La mitad de la propuesta de valor es "conectarse a un agente Flue ya
  deployado" (el de Fly, el del Coolify de un cliente). Hoy es imposible
  desde la interfaz.
- Consecuencia directa: aunque el deploy a Fly funcione, mañana no hay
  forma de reconectarse a ese agente.

### 1.4 Sesiones write-only y sin rejoin

- Sesiones y usage se escriben en SQLite pero no hay `sessions.list` ni
  `session.get` — la data es ilegible desde el frontend.
- Si el WS se cae a mitad de sesión, el stream sigue del lado del servidor
  y nadie lo recibe. No hay mecanismo de rejoin.
- Sin broadcast multi-cliente: los eventos de un deploy solo llegan al
  socket que lo inició.
- `session.abort` con error deja la sesión en estado "running" para
  siempre en la DB (`endSession` solo corre en `onDone`).

### 1.5 El override de modelo es decorativo

- `config.set` y `RunOptions.model` se aceptan, pero `FlueAdapter.run`
  los ignora a propósito (el modelo queda fijo al convertir — comentario en
  `flue.ts:93`).
- La API promete algo que el wire no cumple. Opciones: implementarlo como
  "config change → redeploy automático", o sacarlo de la API. **Una API que
  miente es peor que una API chica.**

### 1.6 Pérdidas silenciosas del converter

El converter manda a `unmapped[]` sin avisarle al usuario:

- **MCP servers stdio** (la MAYORÍA en proyectos Claude Code reales) —
  solo se cablean los HTTP.
- Hooks y permissions (sin equivalente Flue — esperable, pero silencioso).
- `.claude/settings.local.json` (no se lee).
- Env vars de settings (no se extraen al `.env.example`).
- CLAUDE.md anidados / imports (solo se lee el raíz).

Mínimo: el wizard debería mostrar "tu agente pierde X, Y, Z al convertirse"
antes de deployar.

### 1.7 Seguridad (precondiciones de fases futuras)

- **Sin auth en el WS** (4179): aceptable como sidecar localhost,
  **bloqueante** para `apps/web` (Fase 3). Dejarlo anotado como
  precondición, no descubrirlo ahí.
- Secrets en JSON cleartext 0600 (MVP reconocido en el código; migrar a
  keychain del OS después).
- El env-file temporal para `docker run --env-file` puede quedar en disco
  si el proceso muere entre write y delete.

### 1.8 Observabilidad

- Único log estructurado: el "listening" de arranque. Sin log file, sin
  tracing. Los `deploy.log` se streamean al frontend pero no se persisten.
- `mapFlueEvent` descarta eventos desconocidos en silencio (`default:
  return`) — si `@flue/sdk` agrega tipos nuevos, es invisible.
- `Usage.durationMs` definido pero nunca poblado (siempre NULL en DB).

---

## 2. UI/UX y flujo de usuario

### 2.1 No existe el "día 2" (CRÍTICO)

El flujo deploy→chat funciona. Pero al cerrar la app y volver mañana:

- Transcripts borrados — viven en `useState` de `TerminalPanel`; cambiar
  de agente ya los limpia (`setBlocks([])` en el effect de `agentId`).
- Agentes en "offline" sin explicación ni acción sugerida.
- Logs del deploy inaccesibles una vez cerrado el modal.
- Deploy en curso al cerrar la ventana: estado perdido, sin job tracker ni
  indicación al reconectar.

### 2.2 Podés chatear con un agente muerto

- `submit()` en `TerminalPanel` solo chequea `!agent || busy` — **no
  chequea `agent.online`**.
- Arreglo barato de alto impacto: guard de una línea + banner "agente
  offline — ¿redeploy?".

### 2.3 Sin preflight ni onboarding

- Si Docker Desktop no corre, el deploy explota en `docker build` con un
  log de error crudo. Un preflight ("Docker ✓, API key de anthropic ✓")
  antes del paso final del wizard evita la mayoría de los deploys fallidos
  de un usuario nuevo.
- Onboarding: solo "No agents yet — deploy one below". Nada explica qué es
  Fleet, qué se necesita (Docker, API keys).
- Desconexión del Core: se comunica solo con el puntito rojo del sidebar.
  Sin toast, banner ni modal.

### 2.4 Una conversación por agente, sin historial

- `sessionRef` sostiene UNA sesión por vez. Sin lista de conversaciones,
  sin "nueva conversación", sin retomar una vieja. Para un multiplexer es
  una limitación estructural.

### 2.5 Config por agente sin UI

- `config.set` / `config.updated` existen en la API; no hay pantalla.
  (Relacionado con 1.5 — resolver juntos.)

### 2.6 Browser no puede deployar

- `pickDirectory()` retorna `null` fuera de Tauri y no hay input manual de
  ruta como fallback. Aceptable si la estrategia es desktop-first, pero
  decidirlo explícitamente.

### 2.7 Accesibilidad básica

- Items del sidebar: sin `role="button"`, sin `tabIndex`, sin teclado.
- Modales sin focus trap ni restauración de foco.
- Cards de target del wizard sin `aria-label`.

### 2.8 Tauri

- `lib.rs:29`: el handle del sidecar (`_child`) se descarta — el shell no
  puede apagar el Core limpiamente al cerrar la ventana.
- Sin persistencia de tamaño/posición de ventana.

---

## 3. Prioridades recomendadas

Invertir el orden del handoff: **antes de verificar más targets, hacer que
Fleet recuerde y controle.** Verificar Fly hoy produce un agente en la nube
al que no te podés reconectar y que no podés apagar.

| # | Qué | Por qué primero |
| --- | --- | --- |
| 1 | SQLite a archivo (sacar `:memory:`) | Config mínima que arregla la identidad del producto; todo lo demás se apoya acá |
| 2 | Lifecycle: stop/delete + health check + guard de offline en la UI | Cierra el círculo deploy→operar; sin esto los targets remotos generan huérfanos |
| 3 | UI para `agent.connectFlue` | Desbloquea el valor real de verificar Fly/Cloudflare |
| 4 | Persistir transcripts + preflight del wizard | El "día 2" del usuario |
| 5 | Recién acá: verificar Fly/Cloudflare/github en vivo (el pendiente original del handoff) | Ahora sí, con un ops center de verdad detrás |

Backlog (no bloquean, anotar): API honesta de modelo (1.5), aviso de
unmapped en el wizard (1.6), auth WS como precondición de Fase 3 (1.7),
multi-conversación (2.4), accesibilidad (2.7), shutdown limpio del sidecar
(2.8).
