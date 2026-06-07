/**
 * TerminalPanel — a live agent session rendered with xterm.js.
 *
 * Owns its xterm instance (imperative). It does NOT touch agents directly: it
 * sends `session.start` to the Core and writes the streamed RunEvents it gets
 * back. One active session at a time (Phase 1 operates one agent at a time).
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { GatewayClient } from "../../lib/gatewayClient";
import type { AgentSummary, RunEvent, ServerEvent, Usage } from "../../lib/api";

interface Props {
  client: GatewayClient;
  agent: AgentSummary | null;
}

export function TerminalPanel({ client, agent }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionRef = useRef<string | null>(null);
  const pendingRef = useRef(false);
  const agentRef = useRef<AgentSummary | null>(agent);
  agentRef.current = agent;

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  // Create the terminal once.
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, monospace",
      theme: { background: "#0d1117", foreground: "#c9d1d9" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    term.writeln("Gateway terminal ready. Select an agent and send a message.");
    termRef.current = term;

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Route Gateway events into the terminal.
  useEffect(() => {
    return client.on((e: ServerEvent) => {
      const term = termRef.current;
      if (!term) return;
      switch (e.type) {
        case "session.started":
          if (pendingRef.current && agentRef.current && e.agentId === agentRef.current.id) {
            sessionRef.current = e.sessionId;
            pendingRef.current = false;
          }
          return;
        case "session.event":
          if (e.sessionId === sessionRef.current) renderEvent(term, e.event);
          return;
        case "session.done":
          if (e.sessionId !== sessionRef.current) return;
          term.writeln("");
          term.writeln(usageLine(e.usage, e.costUsd, e.status));
          sessionRef.current = null;
          setBusy(false);
          return;
        case "session.error":
          if (e.sessionId !== sessionRef.current) return;
          term.writeln(`\n[error] ${e.error.code}: ${e.error.message}`);
          sessionRef.current = null;
          setBusy(false);
          return;
        case "error":
          term.writeln(`\n[gateway] ${e.message}`);
          if (pendingRef.current) {
            pendingRef.current = false;
            setBusy(false);
          }
          return;
        default:
          return;
      }
    });
  }, [client]);

  function submit(): void {
    const term = termRef.current;
    if (!term || !agent || !input.trim() || busy) return;
    term.writeln(`\n> ${input}`);
    pendingRef.current = true;
    setBusy(true);
    try {
      client.send({ type: "session.start", agentId: agent.id, message: input });
    } catch (err) {
      term.writeln(`[gateway] ${(err as Error).message}`);
      pendingRef.current = false;
      setBusy(false);
    }
    setInput("");
  }

  function abort(): void {
    if (sessionRef.current) client.send({ type: "session.abort", sessionId: sessionRef.current });
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <span>{agent ? `${agent.name} · ${agent.model}` : "No agent selected"}</span>
        <button onClick={abort} disabled={!busy}>
          Abort
        </button>
      </div>
      <div className="terminal-surface" ref={containerRef} />
      <div className="terminal-input">
        <input
          value={input}
          placeholder={agent ? "Type a message and press Enter" : "Select an agent first"}
          disabled={!agent || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button onClick={submit} disabled={!agent || busy || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

function renderEvent(term: Terminal, ev: RunEvent): void {
  switch (ev.type) {
    case "message.delta":
      term.write(ev.content);
      return;
    case "message.completed":
      return; // already streamed via deltas
    case "tool.call":
      term.writeln(`\n  ⚙ tool ${ev.name}(${JSON.stringify(ev.input)})`);
      return;
    case "tool.result":
      term.writeln(`  ✓ ${ev.name} → ${typeof ev.output === "string" ? ev.output : JSON.stringify(ev.output)}`);
      return;
    case "subagent.start":
      term.writeln(`\n  ↳ subagent ${ev.name} started`);
      return;
    case "subagent.end":
      term.writeln(`  ↳ subagent ${ev.name} ended`);
      return;
    case "interrupt":
      term.writeln(`\n  ⏸ interrupt: ${ev.reason}`);
      return;
    default:
      return;
  }
}

function usageLine(u: Usage | null, costUsd: number | null, status: string): string {
  if (!u) return `[${status}]`;
  const cost = costUsd != null ? ` · $${costUsd.toFixed(4)}` : "";
  return `[${status}] ${u.totalTokens} tok (in ${u.inputTokens}/out ${u.outputTokens}) · ${u.model}${cost}`;
}
