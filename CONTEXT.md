# Fleet

Fleet convierte un proyecto local de Claude Code en un agente Flue desplegable,
lo despliega (local o remoto), se conecta a él para consumirlo y configurarlo, y
combina varios agentes en workflows. Es un solo producto: converter + deployer +
centro de operaciones.

## Language

**Fleet**:
El producto completo. Convierte un proyecto Claude Code en un agente Flue,
lo despliega, se conecta a él y combina agentes en workflows.
_Avoid_: Gateway (como nombre del sistema), vigia-agents, Component 2

**Core**:
El paquete cerebro (`packages/core`). Habla Flue con los agentes y expone la
Gateway API al frontend. En desktop corre como sidecar.
_Avoid_: brain, Gateway

**Gateway API**:
El protocolo WebSocket entre el Frontend y el Core. Es la única frontera por la
que el frontend habla con el sistema; nunca habla Flue ni toca un agente.
_Avoid_: usar "Gateway" a secas para referirse a este protocolo o al sistema

**Converter**:
Convierte un proyecto Claude Code en un agente Flue (TypeScript) desplegable.
Es determinístico: no invoca ningún LLM. (Soportar proyectos Codex es visión de
roadmap, no capacidad actual.)

## Agentes

**Flue**:
El estándar/runtime de agente (TypeScript, HTTP+WebSocket) al que Fleet convierte
y despliega. Es el único tipo de agente con el que Fleet habla, a través del
FlueAdapter.
_Avoid_: DeepAgents (estándar anterior, retirado)


**Agent**:
El agente Flue desplegado y registrado en el Core: la unidad que consumes,
configuras, compartes y orquestas. Solo el resultado desplegado es un "Agent".
_Avoid_: usar "agente" para la entrada del converter

**Source project**:
La entrada del converter: un proyecto Claude Code (`CLAUDE.md`, `.claude/...`).
Aún no es un Agent; se convierte en uno al desplegarse. Internamente `ClaudeProject`.
_Avoid_: agente claude-code, agente de entrada

**Subagent**:
Un perfil de subagente dentro de un Source project (`.claude/agents/<name>.md`).
No es un Agent; es parte de la definición de uno.

## Conversación

**Session**:
Una conversación entre el usuario y un Agent. Empieza con `session.start`,
emite eventos en streaming (texto, thinking, tool, MCP, skill, memoria,
subagente) y termina con un estado final. Su historial queda registrado.
_Avoid_: chat, run (run es la ejecución interna; Session es la conversación)

## Organización

**Organization**:
Grupo de usuarios que comparten una misma flota de agentes. La membresía y el
directorio de agentes compartidos viven en un repo privado de GitHub.
_Avoid_: tenant, team, grupo

**Org registry**:
El directorio de agentes compartidos de una Organization, implementado como un
repo privado de GitHub: los collaborators del repo son los miembros.

**Shared agent**:
Un agente que un miembro publica al Org registry para que el resto de la
Organization lo consuma.

**Shared memory** (Engram):
La memoria que comparten los Agents de una Organization. La provee un servidor
Engram cloud, único por org, que Fleet despliega a Dokploy; cada agente accede a
él para leer y escribir memoria común.
_Avoid_: memoria de org (informal), Engram (a secas, para la memoria)

**Origin** (`local` | `org`):
Marca el origen de un agente: quién lo posee. `local`: lo desplegaste tú y lo
controlas por completo. `org`: lo recibiste del Org registry y es de
solo-conexión (no puedes detenerlo, borrarlo, redesplegarlo ni reconfigurarlo).
Es independiente del Deploy target.
_Avoid_: owner, ownership (para esta distinción)

## Orquestación

**Workflow**:
Un grafo dirigido sin ciclos (DAG) que combina varios Agents. Sus nodos son de
tipo `input`, `agent` u `output`. Se edita en el canvas y lo ejecuta el Core.
_Avoid_: pipeline, flujo

**Orchestrator**:
El motor, dentro del Core, que ejecuta un Workflow: cada nodo corre en cuanto
todas sus dependencias terminan.

**Workflow run**:
Una ejecución concreta de un Workflow con unos inputs dados. Su historial queda
registrado.

## Despliegue

**Deploy target**:
Dónde se despliega un agente. Es independiente del Origin (un agente `local`
puede correr en un target remoto). Valores **enrutables**: `fly`, `cloudflare`,
`dokploy`, `github`. Valores **no-enrutables**: `docker-local` (y `local-process`,
solo para tests, no se ofrece en la UI).

**Routable** (enrutable):
Propiedad de un Deploy target: el agente queda accesible por URL para otros.
Solo un agente en un target enrutable puede compartirse a una Organization
(guard ORG-06); `docker-local` nunca.

> Nota de lenguaje: **evitar "agente local" a secas** — confunde el Deploy
> target (`docker-local`) con el Origin (`local`). El identificador
> `docker-local` conserva "local" por razones históricas; renombrarlo es deuda
> pendiente (requiere migrar la columna `target` en SQLite).
