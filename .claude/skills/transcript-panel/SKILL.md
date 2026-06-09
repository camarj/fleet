---
name: transcript-panel
description: The TerminalPanel — a React transcript that renders the neutral RunEvent stream (text, thinking, tool, MCP, skill, memory, subagent) from the Core's session events. xterm.js was REMOVED; do not reintroduce it.
triggers:
  - TerminalPanel
  - transcript
  - session streaming
  - RunEvent rendering
  - terminal panel
  - chat panel
  - thinking block
---

## Purpose

`frontend/src/components/TerminalPanel/TerminalPanel.tsx` is the live agent
session UI: a linear, top-to-bottom conversation styled after Claude Code —
markdown-rendered assistant turns, collapsible thinking/tool/MCP/skill/memory
blocks, auto-growing textarea input, cost/usage footer.

> **History note:** an earlier version used xterm.js. It was REPLACED by this
> React transcript. `@xterm/*` deps may still linger in `frontend/package.json`
> as dead weight — do NOT use them or reintroduce a terminal emulator here.

## When to use

- Modifying `TerminalPanel.tsx` or block rendering
- Adding new `RunEvent` types to the renderer
- Debugging session streaming, busy state, or abort
- Session history / transcript persistence work

## Architecture

```
GatewayClient (WS to Core)
  └── client.on(ServerEvent)
        ├── session.started / session.usage / session.done / session.error
        └── session.event → RunEvent
              └── event switch → TranscriptBlock[] (React state) → block components
```

The frontend NEVER talks to an agent directly (CLAUDE.md rule #2). It renders
neutral `RunEvent`s relayed by the Core; it never sees Flue.

## Key facts (verified in code)

- Blocks are typed `TranscriptBlock` objects accumulated in `useState`;
  rendering is plain React + `react-markdown` + `remark-gfm`.
- Selecting a different agent RESETS all session state (`setBlocks([])` in the
  `agentId` effect) — transcripts are in-memory only today. The session-history
  work (handoff WU-06) refactors the event switch into a pure
  `applyEvent(blocks, event)` reducer so history replay and live streaming
  share one code path. Keep that reducer pure.
- `submit()` guards on `!agent || busy` — the offline guard (`agent.online`)
  is WU-04 of the handoff.
- Enter submits, Shift+Enter inserts newline; abort button shows while busy
  and sends `session.abort`.
- Usage/cost footer: last turn + session totals from `session.usage` /
  `session.done`.

## Block types rendered

user, assistant (markdown, streaming cursor), thinking (collapsible,
`aria-expanded`), tool call/result, mcp call/result, skill start/end,
memory (compaction), subagent start/end, interrupt, error.

## References

- `frontend/src/components/TerminalPanel/TerminalPanel.tsx` — the component
- `frontend/src/lib/api.ts` — `RunEvent` union (mirror of core `api.ts`)
- `docs/handoff-implementacion-gaps.md` §4 (WU-06) — session history plan
