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

type TranscriptBlock =
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

  // Session lifecycle refs (same pattern as the original xterm version).
  const sessionRef = useRef<string | null>(null);
  const pendingRef = useRef(false);
  const agentRef = useRef<AgentSummary | null>(agent);
  agentRef.current = agent;

  // ID of the currently-streaming assistant block for delta appends.
  const streamingBlockIdRef = useRef<string | null>(null);
  const thinkingBlockIdRef = useRef<string | null>(null);

  // Guards against double-counting usage when both session.usage and
  // session.done carry usage for the same turn.
  const usageSeenThisTurnRef = useRef(false);

  // Auto-scroll.
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Textarea auto-grow.
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset all transient state when the selected agent changes.
  const agentId = agent?.id;
  useEffect(() => {
    setBlocks([]);
    setLastUsage(null);
    setSessionTotals({ tokens: 0, costUsd: 0, hasPricedData: false });
    sessionRef.current = null;
    pendingRef.current = false;
    streamingBlockIdRef.current = null;
    thinkingBlockIdRef.current = null;
    usageSeenThisTurnRef.current = false;
    setBusy(false);
  }, [agentId]);

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
  // applyRunEvent is defined inside the effect to avoid stale-closure issues;
  // it reads only stable refs (streamingBlockIdRef) and stable setters (setBlocks).
  useEffect(() => {
    function finalizeStreamingBlock(prevBlocks: TranscriptBlock[]): TranscriptBlock[] {
      const sid = streamingBlockIdRef.current;
      if (!sid) return prevBlocks;
      streamingBlockIdRef.current = null;
      return prevBlocks.map((b) =>
        b.id === sid && b.kind === "assistant" ? { ...b, streaming: false } : b,
      );
    }

    function applyRunEvent(ev: RunEvent): void {
      switch (ev.type) {
        case "message.delta": {
          if (ev.role !== "assistant") return;
          if (streamingBlockIdRef.current) {
            const sid = streamingBlockIdRef.current;
            setBlocks((prev) =>
              prev.map((b) =>
                b.id === sid && b.kind === "assistant"
                  ? { ...b, text: b.text + ev.content }
                  : b,
              ),
            );
          } else {
            const id = nextId();
            streamingBlockIdRef.current = id;
            setBlocks((prev) => [
              ...prev,
              { id, kind: "assistant", text: ev.content, streaming: true },
            ]);
          }
          return;
        }
        case "message.completed": {
          // Content was already streamed via deltas; just finalize the block.
          setBlocks((prev) => finalizeStreamingBlock(prev));
          return;
        }
        case "tool.call": {
          setBlocks((prev) => [
            ...prev,
            {
              id: nextId(),
              kind: "tool",
              callId: ev.id,
              name: ev.name,
              input: ev.input,
              resultReady: false,
            },
          ]);
          return;
        }
        case "tool.result": {
          setBlocks((prev) =>
            prev.map((b) =>
              b.kind === "tool" && b.callId === ev.id
                ? { ...b, result: ev.output, resultReady: true }
                : b,
            ),
          );
          return;
        }
        case "subagent.start": {
          setBlocks((prev) => [
            ...prev,
            { id: nextId(), kind: "subagent", action: "start", name: ev.name },
          ]);
          return;
        }
        case "subagent.end": {
          setBlocks((prev) => [
            ...prev,
            { id: nextId(), kind: "subagent", action: "end", name: ev.name },
          ]);
          return;
        }
        case "interrupt": {
          setBlocks((prev) => [
            ...prev,
            {
              id: nextId(),
              kind: "interrupt",
              reason: ev.reason,
              payload: ev.payload,
            },
          ]);
          return;
        }
        case "thinking.start": {
          const id = nextId();
          thinkingBlockIdRef.current = id;
          setBlocks((prev) => [
            ...prev,
            { id, kind: "thinking", text: "", done: false, startedAt: Date.now() },
          ]);
          return;
        }
        case "thinking.delta": {
          const tid = thinkingBlockIdRef.current;
          if (!tid) return;
          setBlocks((prev) =>
            prev.map((b) =>
              b.id === tid && b.kind === "thinking" ? { ...b, text: b.text + ev.content } : b,
            ),
          );
          return;
        }
        case "thinking.end": {
          const tid = thinkingBlockIdRef.current;
          thinkingBlockIdRef.current = null;
          setBlocks((prev) =>
            prev.map((b) =>
              b.id === tid && b.kind === "thinking"
                ? { ...b, text: ev.content || b.text, done: true }
                : b,
            ),
          );
          return;
        }
        case "mcp.call": {
          setBlocks((prev) => [
            ...prev,
            {
              id: nextId(),
              kind: "mcp",
              callId: ev.id,
              server: ev.server,
              name: ev.name,
              input: ev.input,
              resultReady: false,
              isError: false,
            },
          ]);
          return;
        }
        case "mcp.result": {
          setBlocks((prev) =>
            prev.map((b) =>
              b.kind === "mcp" && b.callId === ev.id
                ? { ...b, result: ev.output, resultReady: true, isError: ev.isError }
                : b,
            ),
          );
          return;
        }
        case "skill.start": {
          setBlocks((prev) => [
            ...prev,
            { id: nextId(), kind: "skill", opId: ev.id, name: ev.name, done: false, isError: false },
          ]);
          return;
        }
        case "skill.end": {
          setBlocks((prev) =>
            prev.map((b) =>
              b.kind === "skill" && b.opId === ev.id
                ? { ...b, done: true, isError: ev.isError, durationMs: ev.durationMs }
                : b,
            ),
          );
          return;
        }
        case "memory.start": {
          setBlocks((prev) => [
            ...prev,
            { id: nextId(), kind: "memory", reason: ev.reason, done: false },
          ]);
          return;
        }
        case "memory.end": {
          // Patch the most recent unfinished memory block.
          setBlocks((prev) => {
            const idx = [...prev].reverse().findIndex((b) => b.kind === "memory" && !b.done);
            if (idx === -1) return prev;
            const realIdx = prev.length - 1 - idx;
            return prev.map((b, i) =>
              i === realIdx && b.kind === "memory"
                ? {
                    ...b,
                    done: true,
                    messagesBefore: ev.messagesBefore,
                    messagesAfter: ev.messagesAfter,
                    durationMs: ev.durationMs,
                  }
                : b,
            );
          });
          return;
        }
      }
    }

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
          applyRunEvent(e.event);
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
          setBlocks((prev) => finalizeStreamingBlock(prev));
          sessionRef.current = null;
          setBusy(false);
          return;
        }
        case "session.error": {
          if (e.sessionId !== sessionRef.current) return;
          setBlocks((prev) => [
            ...finalizeStreamingBlock(prev),
            {
              id: nextId(),
              kind: "error",
              text: `${e.error.code}: ${e.error.message}`,
            },
          ]);
          sessionRef.current = null;
          setBusy(false);
          return;
        }
        case "error": {
          setBlocks((prev) => [
            ...prev,
            { id: nextId(), kind: "error", text: e.message },
          ]);
          if (pendingRef.current) {
            pendingRef.current = false;
            setBusy(false);
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
    setBlocks((prev) => [
      ...prev,
      { id: nextId(), kind: "user", text: message },
    ]);
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
        <span className={`header-status ${statusClass}`}>{statusLabel}</span>
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
                  ? "Type a message…"
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
