# ADR-10 — El converter es determinístico (no invoca ningún LLM)

El converter (`packages/converter`) transforma un Source project (Claude Code) en
un agente Flue **sin invocar ningún LLM**: la misma entrada produce siempre la
misma salida.

Lo elegimos así por reproducibilidad y para evitar el coste, la latencia y el
no-determinismo de una llamada a un modelo en un paso que es esencialmente un
mapeo estructural. La conversión Claude Code → Flue es casi 1:1 (skills,
subagentes, MCP, instrucciones), así que una traducción determinística basta; no
hace falta "razonar".

Esto refuerza la frontera de Fleet: el Core no crea agentes ni corre modelos
inline; el converter solo traduce.

Referenciado en `ARCHITECTURE.md` y `CLAUDE.md`.
