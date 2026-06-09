# Continuación — próxima sesión (Fleet / gaps)

> Punto de retomada al cierre de la sesión 2026-06-09. Leé esto primero, después
> el plan maestro `docs/handoff-implementacion-gaps.md` (tiene su sección
> **Estado / Progreso** al inicio y TODAS las decisiones de arquitectura ya
> tomadas, WU por WU).

## Dónde quedamos

- **F0 + F1 + F2 COMPLETOS y MERGEADOS** a `main` vía **PR #3** (merge commit
  `4b315e3`, 13 commits). Fleet ya **recuerda** (DB a archivo) y **controla**
  (stop/delete, health+reconnect, connect-by-URL) sus agentes, y tiene el
  "día 2" (historial de sesiones, preflight de deploy, banner de reconexión,
  logs de deploy persistentes).
- **Verificado a mano en la app nativa** por el usuario: ciclo de vida (F1) y
  persistencia + día 2 (F0/F2). Todo OK.
- Los 4 gates verdes en cada WU (core test, core typecheck, converter test,
  frontend build).

## Cómo trabajamos (mantener este flujo)

- **Modelo de delegación**: el orquestador (modelo fuerte) escribe la spec de
  cada WU desde el handoff maestro, la delega a un subagente **Sonnet** que
  implementa + corre los gates + commitea (conventional commits, SIN atribución
  de IA), y el orquestador **verifica de forma independiente** (gates + espejo
  `api.ts` core↔frontend + revisión de refactors). El usuario NO escribe código;
  el orquestador NO escribe código ni commitea.
- **Ramas**: una rama por WU, apiladas linealmente; al cerrar un bloque de fases
  se abre **un PR épico** contra `main` (no PRs encadenados — el usuario está
  solo y los commits ya vienen limpios y verificados).
- **Flujo de PR**: directo con `gh`, sin "issue-first" (el usuario va en modo
  velocidad). Si cambia, adoptar la skill `branch-pr`.

## Gotchas de dev (ya nos mordieron — no repetir)

- El Core importa el converter desde `dist`: tras tocar `packages/converter`,
  `pnpm --filter @inteliside/gateway-converter build` **y** reiniciar el Core.
- Puerto 4179 ocupado al arrancar = Core fantasma (`tsx watch`) o `Fleet.app`
  empaquetada. Matarlo antes de debuggear.
- En `tauri dev` el shell NO levanta el sidecar (solo en release): correr el
  Core aparte (`pnpm core:dev`), después `pnpm desktop:dev` (este levanta su
  propio Vite en 1420 — NO correr `pnpm dev` en paralelo).
- `DatabaseSync` no crea el dir padre (ya resuelto con `mkdirSync`).
- En tests: `secrets.set` con una key dummy antes de `agent.deployFlue`
  (el guard fail-fast lo exige). `lsof -ti tcp:PORT` necesita `-sTCP:LISTEN`
  para no matar el propio proceso del test.

## Próximo paso: F3 (no necesita credenciales)

Arrancar por **WU-10** (§5 del handoff maestro):
- **WU-10 — Override de modelo honesto**: hoy `config.set` / `RunOptions.model`
  no tienen efecto real (Flue fija el modelo al convertir). Implementar
  `config → redeploy`: `config.set` marca `requiresRedeploy`, el redeploy aplica
  el override de config, y se saca el camino muerto `RunOptions.model`. Sumar UI
  de config por agente (extraer un `ModelPicker` compartido con el wizard).
- **WU-11 — Avisos de conversión**: emitir `deploy.unmapped` (hooks, MCP stdio,
  permissions, etc.) y mostrarlos como warning en el wizard; que el converter
  lea `settings.local.json` y extraiga `env` al `.env.example`.

Después de F3: **F4** queda bloqueada hasta tener `FLY_API_TOKEN` /
`CLOUDFLARE_API_TOKEN` / cuenta Coolify-Dokploy. Luego **F5** (orquestador
visual, contrato cerrado en §7 del handoff) y **F6** (hardening).

## Archivos clave

- `docs/handoff-implementacion-gaps.md` — plan maestro (decisiones + WUs).
- `docs/analisis-gaps-2026-06-09.md` — el análisis que originó el plan.
- `CLAUDE.md` — reglas del repo (incluye "Active plan", "Dev gotchas", regla 11
  del espejo api.ts).
- `.claude/skills/` — `adapter-interface`, `flue-client`, `transcript-panel`,
  `react-flow-canvas`, `tauri-shell-sidecar`.

## Pendiente menor de housekeeping

- Las ramas locales `feat/wu-01..09-*` y `feat/agent-lifecycle-and-ux` quedaron
  como checkpoints; se pueden borrar (ya están en `main`).
- Este doc y la actualización del handoff maestro quedaron SIN commitear al
  cierre — commitearlos al abrir la próxima sesión (o pedírselo a un subagente).
