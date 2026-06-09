/**
 * TerminalPanel — live agent session rendered as a React transcript.
 *
 * Replaces the xterm.js renderer with a linear, top-to-bottom conversation
 * flow styled after Claude Code: no chat bubbles, dark terminal-like,
 * markdown-rendered assistant turns, auto-growing textarea input.
 *
 * Event wiring is preserved exactly from the original xterm version:
 *   GatewayClient WS → client.on(ServerEvent) → session.event → RunEvent
 *
 * The frontend NEVER talks to an agent directly — only through the Core
 * over WebSocket (Gateway API). See CLAUDE.md rule #2.
 *
 * WU-06: `applyEvent` is a pure reducer shared by live streaming and history
 * replay. The streaming / thinking block IDs are derived from the blocks array
 * itself (no external refs), so both paths produce identical output.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { GatewayClient } from "../../lib/gatewayClient";
import type { AgentSummary, RunEvent, ServerEvent } from "../../lib/api";

// ── Block types ───────────────────────────────────────────────────────────────

interface UserBlock {
  id: string;
  kind: "user";
  text: string;
}

interface AssistantBlock {
  id: string;
  kind: "assistant";
  text: string;
  streaming: boolean;
}

interface ToolBlock {
  id: string;
  kind: "tool";
  callId: string;
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  resultReady: boolean;
}

interface SubagentBlock {
  id: string;
  kind: "subagent";
  action: "start" | "end";
  name: string;
}

interface InterruptBlock {
  id: string;
  kind: "interrupt";
  reason: string;
  payload?: Record<string, unknown>;
}

/** Activated by Flue `thinking.*` events (other standards never emit them). */
interface ThinkingBlock {
  id: string;
  kind: "thinking";
  text: string;
  done: boolean;
  startedAt: number;
}

/** Flue MCP tool call — a `tool_*` whose name was `mcp__<server>__<tool>`. */
interface McpBlock {
  id: string;
  kind: "mcp";
  callId: string;
  server: string;
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  resultReady: boolean;
  isError: boolean;
}

/** Flue skill invocation — an `operation` with operationKind "skill". */
interface SkillBlock {
  id: string;
  kind: "skill";
  opId: string;
  name: string;
  done: boolean;
  isError: boolean;
  durationMs?: number;
}

/** Flue context compaction — `compaction_*` events. */
interface MemoryBlock {
  id: string;
  kind: "memory";
  reason: string;
  done: boolean;
  messagesBefore?: number;
  messagesAfter?: number;
  durationMs?: number;
}

interface ErrorBlock {
  id: string;
  kind: "error";
  text: string;
}

export type TranscriptBlock =
  | UserBlock
  | AssistantBlock
  | ToolBlock
  | SubagentBlock
  | InterruptBlock
  | ThinkingBlock
  | McpBlock
  | SkillBlock
  | MemoryBlock
  | ErrorBlock;

// ── Usage / cost types ────────────────────────────────────────────────────────

interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  costUsd: number | null;
}

interface SessionTotals {
  tokens: number;
  costUsd: number;
  hasPricedData: boolean;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  client: GatewayClient;
  agent: AgentSummary | null;
  connected: boolean;
  /** Called when the user clicks "Redeploy" in the offline banner. Same path as Sidebar's Redeploy. */
  onRedeploy?: (agentId: string) => void;
}

// ── Block ID generator ────────────────────────────────────────────────────────

let _seq = 0;
function nextId(): string {
  return String(++_seq);
}

// ── Block-array helpers ───────────────────────────────────────────────────────

/** Scan backwards for the most recent open streaming assistant block. */
function findStreamingBlockId(blocks: TranscriptBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === "assistant" && b.streaming) return b.id;
  }
  return null;
}

/** Scan backwards for the most recent incomplete thinking block. */
function findOpenThinkingBlockId(blocks: TranscriptBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === "thinking" && !b.done) return b.id;
  }
  return null;
}

// ── Pure event reducer ────────────────────────────────────────────────────────

/**
 * Pure reducer: apply a single RunEvent to a transcript block array.
 *
 * Used by BOTH live streaming (via `setBlocks(prev => applyEvent(prev, ev))`)
 * and history replay (`events.reduce(applyEvent, [])`). No side effects, no
 * refs, no React state — just blocks in, blocks out.
 *
 * The streaming / thinking block IDs are derived by scanning the blocks array,
 * so React's functional-update batching guarantees correctness without external
 * state.
 */
export function applyEvent(blocks: TranscriptBlock[], event: RunEvent): TranscriptBlock[] {
  switch (event.type) {
    case "message.delta": {
      if (event.role !== "assistant") return blocks;
      const sid = findStreamingBlockId(blocks);
      if (sid) {
        return blocks.map((b) =>
          b.id === sid && b.kind === "assistant" ? { ...b, text: b.text + event.content } : b,
        );
      }
      const id = nextId();
      return [...blocks, { id, kind: "assistant", text: event.content, streaming: true }];
    }
    case "message.completed": {
      // Content was already streamed via deltas; finalize the block.
      const sid = findStreamingBlockId(blocks);
      if (!sid) return blocks;
      return blocks.map((b) =>
        b.id === sid && b.kind === "assistant" ? { ...b, streaming: false } : b,
      );
    }
    case "tool.call":
      return [
        ...blocks,
        {
          id: nextId(),
          kind: "tool" as const,
          callId: event.id,
          name: event.name,
          input: event.input,
          resultReady: false,
        },
      ];
    case "tool.result":
      return blocks.map((b) =>
        b.kind === "tool" && b.callId === event.id
          ? { ...b, result: event.output, resultReady: true }
          : b,
      );
    case "subagent.start":
      return [...blocks, { id: nextId(), kind: "subagent" as const, action: "start" as const, name: event.name }];
    case "subagent.end":
      return [...blocks, { id: nextId(), kind: "subagent" as const, action: "end" as const, name: event.name }];
    case "interrupt":
      return [
        ...blocks,
        { id: nextId(), kind: "interrupt" as const, reason: event.reason, payload: event.payload },
      ];
    case "thinking.start": {
      const id = nextId();
      return [...blocks, { id, kind: "thinking" as const, text: "", done: false, startedAt: Date.now() }];
    }
    case "thinking.delta": {
      const tid = findOpenThinkingBlockId(blocks);
      if (!tid) return blocks;
      return blocks.map((b) =>
        b.id === tid && b.kind === "thinking" ? { ...b, text: b.text + event.content } : b,
      );
    }
    case "thinking.end": {
      const tid = findOpenThinkingBlockId(blocks);
      if (!tid) return blocks;
      return blocks.map((b) =>
        b.id === tid && b.kind === "thinking"
          ? { ...b, text: event.content || b.text, done: true }
          : b,
      );
    }
    case "mcp.call":
      return [
        ...blocks,
        {
          id: nextId(),
          kind: "mcp" as const,
          callId: event.id,
          server: event.server,
          name: event.name,
          input: event.input,
          resultReady: false,
          isError: false,
        },
      ];
    case "mcp.result":
      return blocks.map((b) =>
        b.kind === "mcp" && b.callId === event.id
          ? { ...b, result: event.output, resultReady: true, isError: event.isError }
          : b,
      );
    case "skill.start":
      return [
        ...blocks,
        {
          id: nextId(),
          kind: "skill" as const,
          opId: event.id,
          name: event.name,
          done: false,
          isError: false,
        },
      ];
    case "skill.end":
      return blocks.map((b) =>
        b.kind === "skill" && b.opId === event.id
          ? { ...b, done: true, isError: event.isError, durationMs: event.durationMs }
          : b,
      );
    case "memory.start":
      return [...blocks, { id: nextId(), kind: "memory" as const, reason: event.reason, done: false }];
    case "memory.end": {
      const idx = [...blocks].reverse().findIndex((b) => b.kind === "memory" && !b.done);
      if (idx === -1) return blocks;
      const realIdx = blocks.length - 1 - idx;
      return blocks.map((b, i) =>
        i === realIdx && b.kind === "memory"
          ? {
              ...b,
              done: true,
              messagesBefore: event.messagesBefore,
              messagesAfter: event.messagesAfter,
              durationMs: event.durationMs,
            }
          : b,
      );
    }
    default:
      return blocks;
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatToolInput(input: Record<string, unknown>): string {
  if (Object.keys(input).length === 0) return "";
  const json = JSON.stringify(input);
  return json.length > 120 ? json.slice(0, 120) + "…" : json;
}

function formatToolOutput(output: unknown): string {
  if (output === null || output === undefined) return "done";
  if (typeof output === "string") return output.trim() || "done";
  const json = JSON.stringify(output);
  return json.length > 200 ? json.slice(0, 200) + "…" : json;
}

/**
 * Parse a model specifier like "anthropic/claude-sonnet-4-6" into a
 * displayable { provider, model } pair. Provider is the prefix before the
 * first "/", capitalized. If no "/" is present, provider is "—".
 */
function parseModelSpecifier(specifier: string): { provider: string; model: string } {
  if (!specifier) return { provider: "—", model: "—" };
  const slash = specifier.indexOf("/");
  if (slash === -1) return { provider: "—", model: specifier };
  const raw = specifier.slice(0, slash);
  return {
    provider: raw.charAt(0).toUpperCase() + raw.slice(1),
    model: specifier.slice(slash + 1),
  };
}

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

// ── Block renderers ───────────────────────────────────────────────────────────

function UserBlockView({ block }: { block: UserBlock }) {
  return (
    <div className="transcript-block transcript-user">
      <span className="transcript-prefix">›</span>
      <span className="transcript-user-text">{block.text}</span>
    </div>
  );
}

function AssistantBlockView({ block }: { block: AssistantBlock }) {
  return (
    <div className="transcript-block transcript-assistant">
      <div className="transcript-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {block.text || "​"}
        </ReactMarkdown>
      </div>
      {block.streaming && (
        <span className="transcript-stream-cursor" aria-hidden="true" />
      )}
    </div>
  );
}

function ToolBlockView({ block }: { block: ToolBlock }) {
  const inputStr = formatToolInput(block.input);
  const call = inputStr ? `${block.name}(${inputStr})` : `${block.name}()`;
  return (
    <div className="transcript-block transcript-tool">
      <div className="transcript-tool-call">
        <span className="transcript-prefix transcript-prefix-tool">⚙</span>
        <code className="transcript-tool-name">{call}</code>
      </div>
      <div
        className={`transcript-tool-result${!block.resultReady ? " transcript-tool-pending" : ""}`}
      >
        <span className="transcript-result-leader">└</span>
        <span className="transcript-result-text">
          {block.resultReady ? formatToolOutput(block.result) : "running…"}
        </span>
      </div>
    </div>
  );
}

function SubagentBlockView({ block }: { block: SubagentBlock }) {
  return (
    <div className="transcript-block transcript-subagent transcript-muted">
      <span className="transcript-prefix">
        {block.action === "start" ? "↳" : "↩"}
      </span>
      <span>
        subagent <strong>{block.name}</strong>{" "}
        {block.action === "start" ? "started" : "ended"}
      </span>
    </div>
  );
}

function InterruptBlockView({ block }: { block: InterruptBlock }) {
  return (
    <div className="transcript-block transcript-interrupt">
      <span className="transcript-prefix">⏸</span>
      <span>interrupt: {block.reason}</span>
    </div>
  );
}

/**
 * ThinkingBlockView — driven by Flue `thinking.*` events: animated spinner,
 * elapsed timer, and collapsible reasoning text.
 */
function ThinkingBlockView({ block }: { block: ThinkingBlock }) {
  const [elapsed, setElapsed] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (block.done) return;
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - block.startedAt) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [block.done, block.startedAt]);

  return (
    <div className="transcript-block transcript-thinking">
      <button
        className="transcript-thinking-header"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className="transcript-thinking-spinner" aria-hidden="true">✶</span>
        <span className="transcript-muted">Thinking…</span>
        {!block.done && (
          <span className="transcript-thinking-elapsed transcript-muted">
            {elapsed}s
          </span>
        )}
        <span className="transcript-thinking-toggle transcript-muted">
          {collapsed ? "▶" : "▼"}
        </span>
      </button>
      {!collapsed && block.text && (
        <div className="transcript-thinking-body transcript-muted">{block.text}</div>
      )}
    </div>
  );
}

function McpBlockView({ block }: { block: McpBlock }) {
  const inputStr = formatToolInput(block.input);
  const call = inputStr ? `${block.name}(${inputStr})` : `${block.name}()`;
  return (
    <div className={`transcript-block transcript-tool transcript-mcp${block.isError ? " transcript-mcp-error" : ""}`}>
      <div className="transcript-tool-call">
        <span className="transcript-prefix transcript-prefix-tool">🔌</span>
        <span className="transcript-mcp-server">{block.server}</span>
        <code className="transcript-tool-name">{call}</code>
      </div>
      <div className={`transcript-tool-result${!block.resultReady ? " transcript-tool-pending" : ""}`}>
        <span className="transcript-result-leader">└</span>
        <span className="transcript-result-text">
          {block.resultReady ? formatToolOutput(block.result) : "running…"}
        </span>
      </div>
    </div>
  );
}

function SkillBlockView({ block }: { block: SkillBlock }) {
  return (
    <div className="transcript-block transcript-skill transcript-muted">
      <span className="transcript-prefix">{block.done ? "✦" : "✶"}</span>
      <span>
        skill <strong>{block.name}</strong> {block.done ? (block.isError ? "failed" : "done") : "running…"}
      </span>
    </div>
  );
}

function MemoryBlockView({ block }: { block: MemoryBlock }) {
  return (
    <div className="transcript-block transcript-memory transcript-muted">
      <span className="transcript-prefix">🗜</span>
      <span>
        compacting context ({block.reason})
        {block.done && block.messagesBefore != null
          ? ` — ${block.messagesBefore}→${block.messagesAfter} msgs`
          : "…"}
      </span>
    </div>
  );
}

function ErrorBlockView({ block }: { block: ErrorBlock }) {
  return (
    <div className="transcript-block transcript-error">
      <span className="transcript-prefix">✖</span>
      <span>{block.text}</span>
    </div>
  );
}

// ── Cost zone ─────────────────────────────────────────────────────────────────

function CostZone({
  agentModel,
  lastUsage,
  sessionTotals,
}: {
  agentModel: string;
  lastUsage: UsageSnapshot | null;
  sessionTotals: SessionTotals;
}) {
  const { provider, model } = lastUsage
    ? parseModelSpecifier(lastUsage.model)
    : parseModelSpecifier(agentModel);

  const lastStr = lastUsage
    ? `${formatTokens(lastUsage.totalTokens)} tok · ${
        lastUsage.costUsd != null ? formatCost(lastUsage.costUsd) : "—"
      }`
    : "—";

  const sessionStr =
    sessionTotals.tokens > 0
      ? `${formatTokens(sessionTotals.tokens)} tok · ${
          sessionTotals.hasPricedData ? formatCost(sessionTotals.costUsd) : "—"
        }`
      : "—";

  return (
    <div className="cost-zone">
      <span className="cost-model">
        {provider} · {model}
      </span>
      <span className="cost-details">
        Last: {lastStr}&nbsp;&nbsp;&nbsp;Session: {sessionStr}
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function TerminalPanel({ client, agent, connected, onRedeploy }: Props): React.JSX.Element {
  const [blocks, setBlocks] = useState<TranscriptBlock[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastUsage, setLastUsage] = useState<UsageSnapshot | null>(null);
  const [sessionTotals, setSessionTotals] = useState<SessionTotals>({
    tokens: 0,
    costUsd: 0,
    hasPricedData: false,
  });
  /**
   * True while the panel is showing a replayed past session (not a live one).
   * Sending a new message clears the replay and starts a fresh session.
   */
  const [historyMode, setHistoryMode] = useState(false);

  // Session lifecycle refs (same pattern as the original xterm version).
  const sessionRef = useRef<string | null>(null);
  const pendingRef = useRef(false);
  const agentRef = useRef<AgentSummary | null>(agent);
  agentRef.current = agent;

  // Ref mirror of `busy` so event handlers in client.on (stale closure) can read it.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Guards against double-counting usage when both session.usage and
  // session.done carry usage for the same turn.
  const usageSeenThisTurnRef = useRef(false);

  // History loading: tracks which agentId we've already dispatched a sessions.list for.
  const historyRequestedForRef = useRef<string | null>(null);
  // Tracks which sessionId we've requested session.history for (to filter stale responses).
  const pendingHistorySessionRef = useRef<string | null>(null);

  // Auto-scroll.
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Textarea auto-grow.
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset all transient state when the selected agent changes.
  const agentId = agent?.id;
  useEffect(() => {
    setBlocks([]);
    setHistoryMode(false);
    setLastUsage(null);
    setSessionTotals({ tokens: 0, costUsd: 0, hasPricedData: false });
    sessionRef.current = null;
    pendingRef.current = false;
    pendingHistorySessionRef.current = null;
    usageSeenThisTurnRef.current = false;
    setBusy(false);
    // Reset the history-requested tracker so we re-request for the new agent.
    historyRequestedForRef.current = null;
  }, [agentId]);

  // Request session history when a new agent is selected (or when the
  // connection is established after the agent is already set).
  // The historyRequestedForRef guard prevents duplicate requests on reconnect.
  useEffect(() => {
    if (!agentId || !connected) return;
    if (historyRequestedForRef.current === agentId) return; // already requested
    historyRequestedForRef.current = agentId;
    client.send({ type: "sessions.list", agentId });
  }, [agentId, connected, client]);

  // Scroll to bottom on new content, unless the user has scrolled up.
  useEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [blocks]);

  // Textarea auto-grow: adjust height to content, capped by CSS max-height.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [input]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Consider "at bottom" if within 60 px of the bottom edge.
    atBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  // Wire Gateway events → transcript state.
  // `applyEvent` is a pure function defined outside this effect; the closure
  // captures only stable refs and state setters.
  useEffect(() => {
    return client.on((e: ServerEvent) => {
      switch (e.type) {
        case "session.started": {
          if (
            pendingRef.current &&
            agentRef.current &&
            e.agentId === agentRef.current.id
          ) {
            sessionRef.current = e.sessionId;
            pendingRef.current = false;
            usageSeenThisTurnRef.current = false;
          }
          return;
        }
        case "session.event": {
          if (e.sessionId !== sessionRef.current) return;
          setBlocks((prev) => applyEvent(prev, e.event));
          return;
        }
        case "session.usage": {
          if (e.sessionId !== sessionRef.current) return;
          const snap: UsageSnapshot = { ...e.usage, costUsd: e.costUsd };
          setLastUsage(snap);
          setSessionTotals((prev) => ({
            tokens: prev.tokens + e.usage.totalTokens,
            costUsd: prev.costUsd + (e.costUsd ?? 0),
            hasPricedData: prev.hasPricedData || e.costUsd != null,
          }));
          usageSeenThisTurnRef.current = true;
          return;
        }
        case "session.done": {
          if (e.sessionId !== sessionRef.current) return;
          if (e.usage) {
            const snap: UsageSnapshot = { ...e.usage, costUsd: e.costUsd };
            setLastUsage(snap);
            // Only accumulate session totals if session.usage was never fired
            // for this turn — prevents double-counting.
            if (!usageSeenThisTurnRef.current) {
              setSessionTotals((prev) => ({
                tokens: prev.tokens + e.usage!.totalTokens,
                costUsd: prev.costUsd + (e.costUsd ?? 0),
                hasPricedData: prev.hasPricedData || e.costUsd != null,
              }));
            }
          }
          // Finalize any open streaming block.
          setBlocks((prev) => {
            const sid = findStreamingBlockId(prev);
            if (!sid) return prev;
            return prev.map((b) =>
              b.id === sid && b.kind === "assistant" ? { ...b, streaming: false } : b,
            );
          });
          sessionRef.current = null;
          setBusy(false);
          return;
        }
        case "session.error": {
          if (e.sessionId !== sessionRef.current) return;
          setBlocks((prev) => {
            const finalized = (() => {
              const sid = findStreamingBlockId(prev);
              if (!sid) return prev;
              return prev.map((b) =>
                b.id === sid && b.kind === "assistant" ? { ...b, streaming: false } : b,
              );
            })();
            return [
              ...finalized,
              {
                id: nextId(),
                kind: "error" as const,
                text: `${e.error.code}: ${e.error.message}`,
              },
            ];
          });
          sessionRef.current = null;
          setBusy(false);
          return;
        }
        case "error": {
          setBlocks((prev) => [
            ...prev,
            { id: nextId(), kind: "error" as const, text: e.message },
          ]);
          if (pendingRef.current) {
            pendingRef.current = false;
            setBusy(false);
          }
          return;
        }
        case "sessions": {
          // Only handle responses for the currently-selected agent.
          // Skip if a live session is in progress (don't overwrite active transcript).
          if (e.agentId !== agentRef.current?.id) return;
          if (busyRef.current) return;
          if (e.sessions.length === 0) return;
          const mostRecent = e.sessions[0];
          if (!mostRecent) return;
          // Don't try to load a still-running session (shouldn't normally happen
          // but guard anyway — an interrupted Core restart could leave one).
          if (mostRecent.status === "running") return;
          pendingHistorySessionRef.current = mostRecent.id;
          client.send({ type: "session.history", sessionId: mostRecent.id });
          return;
        }
        case "session.history": {
          if (e.sessionId !== pendingHistorySessionRef.current) return;
          pendingHistorySessionRef.current = null;
          if (e.events.length === 0) return; // nothing to replay
          const replayedBlocks = e.events.reduce(
            (acc, ev) => applyEvent(acc, ev),
            [] as TranscriptBlock[],
          );
          setBlocks(replayedBlocks);
          setHistoryMode(true);
          if (e.usage) {
            setLastUsage({ ...e.usage, costUsd: e.costUsd });
            setSessionTotals({
              tokens: e.usage.totalTokens,
              costUsd: e.costUsd ?? 0,
              hasPricedData: e.costUsd != null,
            });
          }
          return;
        }
        default:
          return;
      }
    });
  }, [client]);

  function submit(): void {
    if (!agent || !input.trim() || busy || !agent.online) return;
    const message = input.trim();
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    if (historyMode) {
      // Viewing a past session: clear the replay and start a fresh one.
      setHistoryMode(false);
      setLastUsage(null);
      setSessionTotals({ tokens: 0, costUsd: 0, hasPricedData: false });
      setBlocks([{ id: nextId(), kind: "user", text: message }]);
    } else {
      setBlocks((prev) => [
        ...prev,
        { id: nextId(), kind: "user", text: message },
      ]);
    }

    atBottomRef.current = true;
    pendingRef.current = true;
    setBusy(true);
    try {
      client.send({ type: "session.start", agentId: agent.id, message });
    } catch (err) {
      setBlocks((prev) => [
        ...prev,
        { id: nextId(), kind: "error", text: (err as Error).message },
      ]);
      pendingRef.current = false;
      setBusy(false);
    }
  }

  function abort(): void {
    if (sessionRef.current)
      client.send({ type: "session.abort", sessionId: sessionRef.current });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  /** Clear the replayed transcript and return to the empty-state prompt. */
  function handleNewConversation(): void {
    setBlocks([]);
    setHistoryMode(false);
    setLastUsage(null);
    setSessionTotals({ tokens: 0, costUsd: 0, hasPricedData: false });
    sessionRef.current = null;
  }

  const statusLabel = connected
    ? busy
      ? "● streaming"
      : "⏺ connected"
    : "○ connecting…";

  const statusClass = connected
    ? busy
      ? "status-streaming"
      : "status-connected"
    : "status-connecting";

  return (
    <div className="terminal-panel">
      {/* ── Header ── */}
      <div className="terminal-header">
        <span className="header-agent">
          {agent ? (
            <>
              <span
                className={`header-dot ${agent.online ? "online" : "offline"}`}
              />
              {agent.name}
              {agent.model ? (
                <span className="header-model"> · {agent.model}</span>
              ) : null}
            </>
          ) : (
            "No agent selected"
          )}
        </span>
        <span className="header-right">
          {historyMode && !busy && (
            <button
              className="btn-ghost btn-new-conversation"
              onClick={handleNewConversation}
              title="Clear history and start a new conversation"
            >
              + New conversation
            </button>
          )}
          <span className={`header-status ${statusClass}`}>{statusLabel}</span>
        </span>
      </div>

      {/* ── Transcript scroll area ── */}
      <div
        className="transcript-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {blocks.length === 0 && (
          <div className="transcript-empty">
            {agent
              ? "Send a message to start."
              : "Select an agent from the sidebar."}
          </div>
        )}
        {historyMode && blocks.length > 0 && (
          <div className="transcript-history-banner">
            Past conversation — send a message to start a new one.
          </div>
        )}
        {blocks.map((block) => {
          switch (block.kind) {
            case "user":
              return <UserBlockView key={block.id} block={block} />;
            case "assistant":
              return <AssistantBlockView key={block.id} block={block} />;
            case "tool":
              return <ToolBlockView key={block.id} block={block} />;
            case "subagent":
              return <SubagentBlockView key={block.id} block={block} />;
            case "interrupt":
              return <InterruptBlockView key={block.id} block={block} />;
            case "thinking":
              return <ThinkingBlockView key={block.id} block={block} />;
            case "mcp":
              return <McpBlockView key={block.id} block={block} />;
            case "skill":
              return <SkillBlockView key={block.id} block={block} />;
            case "memory":
              return <MemoryBlockView key={block.id} block={block} />;
            case "error":
              return <ErrorBlockView key={block.id} block={block} />;
          }
        })}
      </div>

      {/* ── Offline banner (shown when agent is registered but not reachable) ── */}
      {agent && !agent.online && (
        <div className="offline-banner">
          <span className="offline-banner-text">This agent is offline.</span>
          {agent.redeployable && onRedeploy && (
            <button
              className="btn-ghost offline-banner-redeploy"
              onClick={() => onRedeploy(agent.id)}
            >
              ↻ Redeploy
            </button>
          )}
        </div>
      )}

      {/* ── Input area ── */}
      <div className="transcript-input-area">
        <div className="transcript-input-row">
          <textarea
            ref={textareaRef}
            className="transcript-textarea"
            value={input}
            placeholder={
              agent
                ? agent.online
                  ? historyMode
                    ? "Send a message to start a new conversation…"
                    : "Type a message…"
                  : "Agent is offline"
                : "Select an agent first"
            }
            disabled={!agent || busy || !agent.online}
            rows={2}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {busy ? (
            <button className="btn-secondary" onClick={abort}>
              Abort
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!agent || !input.trim() || !agent.online}
            >
              Send
            </button>
          )}
        </div>
        <div className="transcript-input-hint">
          Enter sends · Shift+Enter new line
        </div>
      </div>

      {/* ── Cost zone ── */}
      <CostZone
        agentModel={agent?.model ?? ""}
        lastUsage={lastUsage}
        sessionTotals={sessionTotals}
      />
    </div>
  );
}
