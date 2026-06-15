# Baton

Baton es un orquestador de agentes distribuidos. Convierte un proyecto local de
Claude Code en un agente desplegable, lo despliega (local o remoto), y coordina
varios agentes especializados mediante un **Orchestrator** agéntico bajo una
topología jerárquica: el orquestador delega y sintetiza; los agentes no se
comunican entre sí. Conserva converter, memoria compartida y organizaciones.

> El nombre anterior del producto era **Fleet**. El código y los paquetes npm
> (`@inteliside/gateway-*`) aún usan "fleet"/"gateway" por inercia; renombrarlos
> es deuda pendiente (igual que `docker-local`).

## Language

**Baton**:
El producto completo: orquestador de agentes distribuidos (converter + deployer +
orquestación + centro de operaciones).
_Avoid_: Fleet (nombre anterior), Gateway (como nombre del sistema), vigia-agents

**Core**:
El paquete cerebro (`packages/core`). Habla con los agentes (Flue y A2A) y expone
la Gateway API al frontend. En desktop corre como sidecar.
_Avoid_: brain, Gateway

**Gateway API**:
El protocolo WebSocket entre el Frontend y el Core. Es la única frontera por la
que el frontend habla con el sistema; nunca habla Flue/A2A ni toca un agente.
_Avoid_: usar "Gateway" a secas para referirse a este protocolo o al sistema

**Converter**:
Convierte un proyecto Claude Code en un agente Flue (TypeScript) desplegable, y
emite su Agent Card. Es determinístico: no invoca ningún LLM. (Soportar proyectos
Codex es visión de roadmap, no capacidad actual.)

## Agentes

**Agent**:
Un agente desplegado y registrado en el Core: la unidad que consumes, configuras,
compartes y orquestas. Puede ser nativo (Flue) o externo (A2A).
_Avoid_: usar "agente" para la entrada del converter

**Flue**:
El estándar/runtime de agente (TypeScript, HTTP+WebSocket) al que Baton convierte
y despliega los Source projects. Es el runtime nativo; convive con A2A (Flue =
cómo corre el agente; A2A = cómo se coordina). Se habla a través del FlueAdapter.
_Avoid_: DeepAgents (estándar anterior, retirado)

**A2A** (Agent-to-Agent):
El protocolo de coordinación agente↔agente. El Orchestrator delega tareas a los
Agents vía A2A, y los Agents externos (de terceros) se incorporan por A2A. Se
habla a través del A2aAdapter. Convive con Flue, no lo reemplaza.

**Agent Card**:
El descriptor de capacidades de un Agent (metadatos sobre HTTP/JSON, conforme a
A2A): qué sabe hacer y cómo invocarlo. El Converter lo emite para los agentes que
crea; el Orchestrator lo consulta para decidir a quién delegar.

**Capability**:
Una habilidad declarada por un Agent en su Agent Card (p. ej. "clona un repo,
lo analiza y devuelve un diff"). Es la unidad por la que el Orchestrator elige
delegar.

**Source project**:
La entrada del converter: un proyecto Claude Code (`CLAUDE.md`, `.claude/...`).
Aún no es un Agent; se convierte en uno al desplegarse. Internamente `ClaudeProject`.
_Avoid_: agente claude-code, agente de entrada

**Subagent**:
Un perfil de subagente dentro de un Source project (`.claude/agents/<name>.md`).
No es un Agent ni un participante de orquestación; es parte de la definición de uno.
_Avoid_: usar "subagente" para los Agents que el Orchestrator coordina (ésos son
Agents delegados)

## Orquestación distribuida

**Orchestrator**:
El agente coordinador (con razonamiento propio) que recibe un objetivo, descubre
las Capabilities de los Agents registrados, **delega** tareas a ellos vía A2A,
observa el progreso y sintetiza el resultado final. La topología es jerárquica
(hub-and-spoke): los Agents delegados no se comunican entre sí, solo con el
Orchestrator.
_Avoid_: usar "Orchestrator" para el motor de Workflow (ése es el modo declarativo)

**Delegation**:
El acto del Orchestrator de asignar una tarea (A2A) a un Agent según su
Capability y recibir su artefacto. Toda coordinación pasa por aquí.

**Workflow**:
El modo **declarativo** de orquestación: un grafo dirigido sin ciclos (DAG) de
nodos `input`/`agent`/`output`, editable en el canvas y ejecutado de forma
determinista por el Core. Alternativa al Orchestrator agéntico para flujos fijos.
_Avoid_: pipeline, flujo

**Workflow run**:
Una ejecución concreta de un Workflow con unos inputs dados. Su historial queda
registrado.

## Ejecución

**Sandbox**:
El entorno aislado y con filesystem escribible donde un Agent ejecuta tareas que
tocan código (clonar, analizar, modificar). Es **efímero por tarea**: se
provisiona, hace el trabajo, devuelve el artefacto (diff/PR/logs) y se destruye.
Vive detrás de la interfaz de servicio del Agent.
_Avoid_: confundir el Sandbox (runtime de ejecución) con el Agent (loop de razonamiento)

**SandboxAdapter**:
La costura pluggable que provee un Sandbox (mismo patrón que el AgentAdapter). El
**default universal** es un contenedor Docker efímero (con gVisor opcional, sin
requerir KVM, convive con Dokploy); un **adapter de microVM** (Firecracker/E2B)
es opcional y se activa solo si el host expone `/dev/kvm`. El default corre en
cualquier infraestructura — requisito de un proyecto open-source.

## Conversación

**Session**:
Una conversación entre el usuario y un Agent. Empieza con `session.start`,
emite eventos en streaming (texto, thinking, tool, MCP, skill, memoria,
subagente, delegación) y termina con un estado final. Su historial queda registrado.
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
Organization lo consuma (y orqueste).

**Shared memory** (Engram):
La memoria que comparten los Agents de una Organization. La provee un servidor
Engram cloud, único por org, que Baton despliega a Dokploy; cada agente accede a
él para leer y escribir memoria común.
_Avoid_: memoria de org (informal), Engram (a secas, para la memoria)

**Origin** (`local` | `org`):
Marca el origen de un agente: quién lo posee. `local`: lo desplegaste tú y lo
controlas por completo. `org`: lo recibiste del Org registry y es de
solo-conexión (no puedes detenerlo, borrarlo, redesplegarlo ni reconfigurarlo).
Es independiente del Deploy target.
_Avoid_: owner, ownership (para esta distinción)

## Despliegue

**Deploy target**:
Dónde se despliega un agente. Es independiente del Origin (un agente `local`
puede correr en un target remoto). Valores **enrutables**: `fly`, `cloudflare`,
`dokploy`, `github`. Valores **no-enrutables**: `docker-local` (y `local-process`,
solo para tests, no se ofrece en la UI).

**Routable** (enrutable):
Propiedad de un Deploy target: el agente queda accesible por URL para otros.
Solo un agente en un target enrutable puede compartirse a una Organization
(guard ORG-06) u orquestarse de forma remota; `docker-local` nunca.

> Nota de lenguaje: **evitar "agente local" a secas** — confunde el Deploy
> target (`docker-local`) con el Origin (`local`). El identificador
> `docker-local` conserva "local" por razones históricas; renombrarlo es deuda
> pendiente (requiere migrar la columna `target` en SQLite).
