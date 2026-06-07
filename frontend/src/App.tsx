/**
 * App — the three-zone shell: Sidebar (fleet) + Terminal panel + Workflow canvas
 * (Phase 2 stub). Holds the single GatewayClient and routes top-level events.
 */

import { useEffect, useRef, useState } from "react";
import { GatewayClient } from "./lib/gatewayClient";
import type { AgentSummary, ServerEvent } from "./lib/api";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel/TerminalPanel";
import { WorkflowCanvas } from "./components/WorkflowCanvas/WorkflowCanvas";

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL ?? "ws://127.0.0.1:4179";

export function App(): React.JSX.Element {
  const clientRef = useRef<GatewayClient | null>(null);
  if (!clientRef.current) clientRef.current = new GatewayClient(GATEWAY_URL);
  const client = clientRef.current;

  const [connected, setConnected] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"terminal" | "canvas">("terminal");

  useEffect(() => {
    let off = (): void => {};
    client
      .connect()
      .then(() => {
        setConnected(true);
        off = client.on((e: ServerEvent) => {
          if (e.type === "agents") {
            setAgents(e.agents);
            setSelectedId((cur) => cur ?? e.agents[0]?.id ?? null);
          } else if (e.type === "agent.registered") {
            setAgents((prev) => upsertAgent(prev, e.agent));
            setSelectedId((cur) => cur ?? e.agent.id);
          }
        });
        client.send({ type: "agents.list" });
      })
      .catch(() => setConnected(false));
    return () => off();
  }, [client]);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="app">
      <Sidebar
        agents={agents}
        selectedId={selectedId}
        connected={connected}
        onSelect={setSelectedId}
        onConnectA2A={(url) => client.send({ type: "agent.connectA2A", url })}
        onLaunchAcp={(cwd) => client.send({ type: "agent.launchAcp", cwd })}
      />
      <main className="main">
        <div className="tabs">
          <button className={`tab ${view === "terminal" ? "active" : ""}`} onClick={() => setView("terminal")}>
            Terminal
          </button>
          <button className={`tab ${view === "canvas" ? "active" : ""}`} onClick={() => setView("canvas")}>
            Workflows
          </button>
        </div>
        {view === "terminal" ? <TerminalPanel client={client} agent={selected} /> : <WorkflowCanvas />}
      </main>
    </div>
  );
}

function upsertAgent(list: AgentSummary[], agent: AgentSummary): AgentSummary[] {
  const idx = list.findIndex((a) => a.id === agent.id);
  if (idx === -1) return [...list, agent];
  const next = list.slice();
  next[idx] = agent;
  return next;
}
