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
import { DeployWizard } from "./components/DeployWizard/DeployWizard";
import { DeployProgress } from "./components/DeployProgress/DeployProgress";
import { Settings } from "./components/Settings/Settings";

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL ?? "ws://127.0.0.1:4179";

export function App(): React.JSX.Element {
  const clientRef = useRef<GatewayClient | null>(null);
  if (!clientRef.current) clientRef.current = new GatewayClient(GATEWAY_URL);
  const client = clientRef.current;

  const [connected, setConnected] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"terminal" | "canvas">("terminal");
  const [secretsProviders, setSecretsProviders] = useState<string[]>([]);
  const [deployStatus, setDeployStatus] = useState<string | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployArtifact, setDeployArtifact] = useState<{ url: string; message: string } | null>(null);
  const [deployLog, setDeployLog] = useState<string[]>([]);
  const [deployOpen, setDeployOpen] = useState(false);
  const [redeployingId, setRedeployingId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  function resetDeploy(): void {
    setDeployStatus(null);
    setDeployError(null);
    setDeployArtifact(null);
    setDeployLog([]);
  }

  useEffect(() => {
    const offMsg = client.on((e: ServerEvent) => {
      if (e.type === "agents") {
        setAgents(e.agents);
        setSelectedId((cur) => cur ?? e.agents[0]?.id ?? null);
      } else if (e.type === "agent.registered") {
        setAgents((prev) => upsertAgent(prev, e.agent));
        setSelectedId((cur) => cur ?? e.agent.id);
        setDeployStatus(null); // a deploy that just finished
        setDeployError(null);
        setDeployArtifact(null);
      } else if (e.type === "secrets.status") {
        setSecretsProviders(e.providers);
      } else if (e.type === "deploy.progress") {
        setDeployStatus(e.detail ? `${e.step} — ${e.detail}` : e.step);
        setDeployError(null);
      } else if (e.type === "deploy.log") {
        setDeployLog((prev) => [...prev.slice(-400), ...e.lines]);
      } else if (e.type === "deploy.artifact") {
        // A deploy with no running agent (e.g. github) — surface the artifact URL.
        setDeployStatus(null);
        setDeployError(null);
        setDeployArtifact({ url: e.url, message: e.message });
      } else if (e.type === "deploy.error") {
        setDeployStatus(null);
        setDeployError(e.message);
      }
    });
    // Refresh lists on every (re)connect; reflect live connection state.
    const offStatus = client.onStatus((c) => {
      setConnected(c);
      if (c) {
        client.send({ type: "agents.list" });
        client.send({ type: "secrets.list" });
      }
    });
    client.connect();
    return () => {
      offMsg();
      offStatus();
    };
  }, [client]);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="app">
      <Sidebar
        agents={agents}
        selectedId={selectedId}
        connected={connected}
        secretsProviders={secretsProviders}
        onSelect={setSelectedId}
        onOpenDeploy={() => {
          resetDeploy();
          setDeployOpen(true);
        }}
        onRedeploy={(id) => {
          resetDeploy();
          setDeployStatus("starting");
          setRedeployingId(id);
          const sent = client.send({ type: "agent.redeploy", agentId: id });
          if (!sent) setDeployError("Not connected to the Core — reconnecting. Try again in a moment.");
        }}
        onOpenSettings={() => setSettingsOpen(true)}
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
        {view === "terminal" ? (
          <TerminalPanel client={client} agent={selected} connected={connected} />
        ) : (
          <WorkflowCanvas />
        )}
      </main>

      {deployOpen && (
        <DeployWizard
          connected={connected}
          deployStatus={deployStatus}
          deployError={deployError}
          deployArtifact={deployArtifact}
          deployLog={deployLog}
          onDeploy={(req) => {
            setDeployStatus("starting");
            setDeployError(null);
            setDeployArtifact(null);
            setDeployLog([]);
            const sent = client.send({ type: "agent.deployFlue", ...req });
            if (!sent) setDeployError("Not connected to the Core — reconnecting. Try again in a moment.");
          }}
          onClose={() => {
            setDeployOpen(false);
            resetDeploy();
          }}
        />
      )}

      {redeployingId && (
        <DeployProgress
          agentName={agents.find((a) => a.id === redeployingId)?.name ?? redeployingId}
          deployStatus={deployStatus}
          deployError={deployError}
          deployLog={deployLog}
          done={!!deployError || deployStatus === null}
          onClose={() => {
            setRedeployingId(null);
            resetDeploy();
          }}
        />
      )}

      {settingsOpen && (
        <Settings
          connected={connected}
          secretsProviders={secretsProviders}
          onSetSecret={(provider, apiKey) => client.send({ type: "secrets.set", provider, apiKey })}
          onClose={() => setSettingsOpen(false)}
        />
      )}
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
