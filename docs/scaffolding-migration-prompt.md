# Prompt para el agente de código del Scaffolding (migración a A2A + ACP)

> Pegale esto al agente que desarrolla `vivero_agents`. Es self-contained.

---

## Contexto

Trabajás en el **Scaffolding de Inteliside** (Componente 1), en
`/Users/camarj/Documents/Proyectos/vivero_agents`. Hoy los agentes que genera el
template hablan un **protocolo propio** ("Inteliside Runtime Protocol", HTTP+WS).

**DECISIÓN TOMADA:** reemplazamos ese protocolo propio por **dos estándares
abiertos**, para eliminar lock-in y ganar interoperabilidad con el ecosistema:

- **A2A (Agent2Agent)** para agentes **REMOTOS / deployados** → HTTP + SSE.
  Doc oficial: https://a2a-protocol.org/latest/ (Linux Foundation, Apache 2.0).
- **ACP (Agent Client Protocol)** para agentes **LOCALES** → stdio (JSON-RPC 2.0
  newline-delimited). Doc oficial: https://agentclientprotocol.com/

El **Gateway** (Componente 2) se está construyendo en paralelo para consumir
estos dos estándares. Este documento te dice qué cambiar **y el contrato de
compatibilidad exacto** del que depende el Gateway. Respetalo al pie de la letra
en lo marcado como CONTRATO, porque si no, los dos componentes no se entienden.

## Reglas no-negociables

1. **No inventes APIs.** Verificá todo A2A/ACP contra la doc oficial y usá los
   **SDKs oficiales** donde existan (ver "Verificá esto" al final). Si algo no
   está confirmado, paralo y preguntá; no adivines.
2. **Neutralidad:** nada del motor (DeepAgents/LangGraph) puede filtrarse al cable
   ni al Agent Card. La regla de neutralidad del Contract sigue vigente.
3. **Reutilizá el mapeo de eventos que ya existe.** `runtime/protocol.py`
   (`map_engine_event`, `extract_usage`) es lógica pura y portable — NO la
   reescribas; llamala desde los dos servers nuevos.
4. **No toques el motor.** `src/agent/definition.py` (`build_agent`), `config.py`,
   `mcp.py`, `tools/`, `subagents/` quedan igual. Solo cambia la **capa que sirve**
   (`runtime/`).
5. Revisá el repo antes de cambiar y **presentá un plan corto antes de ejecutar**.

## Arquitectura objetivo (dual-stack, un solo core)

El agente pasa a tener dos entrypoints que comparten el mismo núcleo:

```
runtime/a2a_server.py   → A2A sobre HTTP+SSE   (camino DEPLOYADO/remoto; CMD del Docker)
runtime/acp_server.py   → ACP sobre stdio      (camino LOCAL; el cliente/Gateway lo lanza como subproceso)
                  ╲           ╱
        build_agent() + agent.astream_events(v2) + protocol.map_engine_event/extract_usage
```

El deployment elige el server (no sirvas los dos en un mismo proceso). El núcleo
—construir el agente y traducir los eventos del motor a la grilla neutral
(`message.delta`, `tool.call`, `tool.result`, `subagent.*`, usage)— es idéntico
para ambos.

---

## CONTRATO DE COMPATIBILIDAD con el Gateway (lo más importante)

### A2A (remoto)

- **Agent Card** (el "business card" que el Gateway lee para descubrir al agente):
  servilo en el **well-known URL** de A2A. ⚠️ VERIFICÁ la ruta exacta en la spec
  (es `/.well-known/agent-card.json` o equivalente). **Generalo desde el
  manifiesto**: `name`, `description`, `capabilities.streaming = true`, `skills`
  (derivados del manifiesto), `url`/`endpoints`, `securitySchemes`.
- Implementá: `message/send`, `message/stream` (SSE), `tasks/get`, `tasks/cancel`,
  `tasks/resubscribe` (verificá los nombres JSON-RPC exactos en §9.4 / el SDK).
- **Mapeo eventos neutrales → A2A:**
  - `message.delta` → `Message`/`Artifact` con `TextPart` por streaming SSE
  - `message.completed` → artifact/`Message` final
  - `tool.call` / `tool.result` → `DataPart` en artifact o `TaskStatusUpdate`
  - estado: `submitted → working → completed` (o `canceled` en abort, `failed` en error)
  - HITL (si aplica) → `TaskState input-required`
- **CONTRATO — usage (A2A NO lleva tokens en su modelo):** poné el usage en el
  `metadata` del Message/Task **final**, bajo la clave acordada:
  ```json
  "metadata": { "inteliside/usage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "model": "anthropic/claude-sonnet-4-6" } }
  ```
  El Gateway lee esa clave para calcular costo. **La clave debe ser exactamente
  `inteliside/usage`** — si la cambiás, el Gateway no ve el costo.
- **Auth:** declará un `securityScheme` en el Agent Card. Dev/local: sin auth.
  Deployado: API-key o Bearer. (Esto es cómo el Gateway se autentica AL agente; es
  distinto de `ANTHROPIC_API_KEY`, que es del agente hacia el modelo y queda en
  env del lado del agente.)

### ACP (local)

- **Transporte:** stdio, **JSON-RPC 2.0 newline-delimited** — un mensaje por línea
  terminado en `\n`, **sin** newlines embebidos, **sin** headers Content-Length.
  El agente lee de `stdin`, escribe a `stdout`, y **solo loguea a `stderr`** (nada
  que no sea ACP válido va a stdout). El cliente (Gateway/editor) **lanza al agente
  como subproceso**.
- Implementá (Client→Agent): `initialize` (declarando `agentCapabilities`),
  `session/new`, `session/prompt` (streameando `session/update`), `session/cancel`.
  `authenticate` solo si hace falta.
- **Mapeo eventos neutrales → ACP `session/update`** (el discriminador es
  `update.type`):
  - `message.delta` → `agent_message_chunk`
  - `tool.call` → `tool_call` (status `pending`)
  - `tool.result` → `tool_call_update` (status `completed`)
  - `subagent.*` → `plan` o `agent_thought_chunk` (elegí uno y sé consistente)
  - fin de turno → respuesta de `session/prompt` con `stopReason`
    (`end_turn`/`max_tokens` → completado; `cancelled` → abortado; `refusal` → completado con nota)
- **CONTRATO — usage (ACP tampoco lo tiene):** ACP reserva claves con prefijo `_`
  para extensiones. Adjuntá el usage en `_meta` de la respuesta de `session/prompt`
  (o del update final):
  ```json
  "_meta": { "inteliside_usage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "model": "..." } }
  ```
- Si el cliente declara `clientCapabilities.fs`/`terminal`, podés usar
  `fs/read_text_file`, `fs/write_text_file`, `terminal/*` y `session/request_permission`.
  Para el MVP no es obligatorio implementarlos.

### Qué hace el Gateway de su lado (para que estemos sincronizados)

- **Remoto:** el Gateway es **cliente A2A** — lee tu Agent Card, llama
  `message/stream`, consume el SSE, `tasks/cancel` para abortar, y saca el costo de
  `metadata["inteliside/usage"]`.
- **Local:** el Gateway es **cliente ACP** — **spawnea tu `acp_server`** como
  subproceso, hace `initialize → session/new → session/prompt`, consume
  `session/update`, `session/cancel` para abortar, y saca usage de `_meta`.
- El Gateway **ya no** lee el viejo `/manifest` ni habla `/ws`. Esos se retiran.

---

## Qué cambiar (por área)

### `runtime/` (la fachada que se sirve)
- **Borrar/retirar** `runtime/server.py` (el server HTTP+WS propio) y reescribir
  como `runtime/a2a_server.py` (A2A/HTTP+SSE) + `runtime/acp_server.py` (ACP/stdio).
- **Conservar** `runtime/protocol.py` (mapeo de eventos + extract_usage) — es
  reutilizable tal cual. Si acaso, agregale helpers para emitir en formato A2A/ACP,
  pero NO toques `map_engine_event`/`extract_usage`.
- Actualizar `runtime/__init__.py` (docstring).

### Manifiesto y Contract (`packages/contract` + `contract/` vendoreado)
- El **manifiesto sigue siendo el formato de AUTORÍA** del agente (model, prompt,
  tools, skills, mcp, subagents — el wiring del motor). **El Gateway ya no lo
  consume directo** (consume el Agent Card de A2A / el `initialize` de ACP).
- **Bloque `runtime` del manifiesto:** sacá los `const "inteliside-runtime"` /
  `const "1"` del schema (`manifest.schema.json` y la copia vendoreada). Reemplazalo
  por una declaración neutral de qué estándares sirve, p.ej.
  `"serve": ["a2a", "acp"]`, o eliminá el bloque si no aporta.
- **Retirar** `runtime-protocol.md` y `src/protocol.ts` (el cable propio ya no
  existe). **Conservar** `capabilities.ts`, `validate.ts`, `types.ts` (actualizá
  `RuntimeContract`/los tipos para reflejar el cambio).
- Mantené la neutralidad: ni el Agent Card ni las capabilities de ACP mencionan
  DeepAgents.

### Deploy (`deploy/`)
- `Dockerfile`: `CMD` pasa a `python -m runtime.a2a_server` (el camino deployado es
  A2A). Mantené `HOST=0.0.0.0`, `PORT=8080`, expone 8080.
- `docker-compose.yml`: igual, mapea 8080.

### Skills (`templates/deepagents-python/.claude/skills/`)
- `probar-agente-local`: reescribir el test local para **ACP por stdio** (mandar
  `initialize`/`session/new`/`session/prompt` por stdin) en vez de `wscat .../ws`.
- `validar-fachada`: reescribir el checklist para validar el **Agent Card de A2A**
  (curl al well-known) + un `message/stream` SSE, en vez de `/runtime` + WS.
- `deployar-agente`: invertir la regla "ACP no aplica" — ACP **es** el camino local.
  Borrar/reescribir `references/acp-runtime-decision.md`.
- `crear-agente-deepagents`, `trabajar-con-primitivas`, `conectar-mcp-y-engram`:
  cambios menores (concernen al motor/usuario, no al cable).

### Docs (`ARCHITECTURE.md`, `CLAUDE.md`, `AGENTS.md`, `ROADMAP.md`)
- Actualizar la descripción de la fachada: "Runtime Protocol propio" → "A2A
  (remoto) + ACP (local)". Quitar la línea "NO ACP". La regla de neutralidad y la
  lista de archivos de fachada siguen válidas (cambia el contenido de `runtime/`,
  no su estatus de fachada).

---

## Verificación (Definition of Done)

- **A2A:** `curl` al Agent Card devuelve un JSON válido con `capabilities.streaming`
  y `skills`. Un `message/stream` devuelve un stream SSE de updates que termina en
  `completed`, con el usage en `metadata["inteliside/usage"]`. `tasks/cancel` aborta.
- **ACP:** piped por stdin un `initialize` + `session/new` + `session/prompt`,
  ves el stream de `session/update` y un `stopReason`, con usage en `_meta`.
- Idealmente, un camino de humo **sin API key** (un modelo/echo fake) para probar
  el transporte sin gastar tokens.
- Skills `probar-agente-local` y `validar-fachada` actualizadas y pasando.

## Verificá esto en la doc oficial (no lo des por sentado)

- A2A: la ruta exacta del **well-known Agent Card**; el nombre/uso del **SDK Python
  oficial** (p.ej. `a2a-sdk`); los strings JSON-RPC exactos de los métodos (§9.4);
  cómo el SDK emite SSE. — https://a2a-protocol.org/latest/specification/
- ACP: el **framing exacto** (newline-delimited, confirmado en `transports`); si
  existe una **lib Python** de ACP (si no, implementá el loop stdio JSON-RPC a mano,
  es chico); las shapes de `initialize`/`session/*`. —
  https://agentclientprotocol.com/protocol/v1/ (schema, transports, initialization,
  prompt-turn, content, tool-calls, file-system)

## Resumen de la frontera (lo que NO se puede romper)

| El Gateway espera… | …y vos lo entregás como |
| --- | --- |
| Descubrir un agente remoto | **Agent Card A2A** en el well-known URL |
| Invocar + streamear (remoto) | `message/stream` con SSE |
| Abortar (remoto) | `tasks/cancel` |
| Costo (remoto) | `metadata["inteliside/usage"]` |
| Descubrir/arrancar un agente local | spawnear tu `acp_server` + `initialize` |
| Invocar + streamear (local) | `session/prompt` + `session/update` |
| Abortar (local) | `session/cancel` |
| Costo (local) | `_meta.inteliside_usage` |
