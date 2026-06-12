/**
 * App — the three-zone shell: Sidebar (fleet) + Terminal panel + Workflow canvas
 * (Phase 2 stub). Holds the single GatewayClient and routes top-level events.
 */

import { useEffect, useRef, useState } from "react";
import { GatewayClient } from "./lib/gatewayClient";
import type { AgentSummary, FailedDeploy, OrgMember, OrgStatus, PreflightCheck, ServerEvent } from "./lib/api";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel/TerminalPanel";
import { WorkflowCanvas } from "./components/WorkflowCanvas/WorkflowCanvas";
import { DeployWizard } from "./components/DeployWizard/DeployWizard";
import { DeployProgress } from "./components/DeployProgress/DeployProgress";
import { Settings, type UsageSummaryData } from "./components/Settings/Settings";
import { ConnectAgent } from "./components/ConnectAgent/ConnectAgent";
import { AgentConfig } from "./components/AgentConfig/AgentConfig";
import { Modal } from "./components/Modal/Modal";

const GATEWAY_BASE_URL = import.meta.env.VITE_GATEWAY_URL ?? "ws://127.0.0.1:4179";

async function fetchGatewayToken(): Promise<string | null> {
  // Tauri injects __TAURI_INTERNALS__; absent in plain browser dev.
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const token = await invoke<string | null>("gateway_token");
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function resolveGatewayUrl(): Promise<string> {
  const token = await fetchGatewayToken();
  if (!token) return GATEWAY_BASE_URL;
  const url = new URL(GATEWAY_BASE_URL);
  url.searchParams.set("token", token);
  return url.toString();
}

export function App(): React.JSX.Element {
  const clientRef = useRef<GatewayClient | null>(null);
  if (!clientRef.current) clientRef.current = new GatewayClient(resolveGatewayUrl);
  const client = clientRef.current;

  const [connected, setConnected] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"terminal" | "canvas">("terminal");
  const [secretsProviders, setSecretsProviders] = useState<string[]>([]);
  const [usageSummary, setUsageSummary] = useState<UsageSummaryData | null>(null);
  const [deployStatus, setDeployStatus] = useState<string | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployArtifact, setDeployArtifact] = useState<{ url: string; message: string } | null>(null);
  const [deployLog, setDeployLog] = useState<string[]>([]);
  /** Source features that didn't convert to Flue, reported by the last deploy. */
  const [deployUnmapped, setDeployUnmapped] = useState<{ kind: string; name: string; reason: string }[]>([]);
  const [deployOpen, setDeployOpen] = useState(false);
  /** The most recent first-deploy failure persisted by the Core (null = none). */
  const [lastFailedDeploy, setLastFailedDeploy] = useState<FailedDeploy | null>(null);
  const [preflightChecks, setPreflightChecks] = useState<PreflightCheck[] | null>(null);
  /** GitHub owners the authenticated user can push repos to. null = not yet fetched. */
  const [githubOwners, setGithubOwners] = useState<string[] | null>(null);
  const [redeployingId, setRedeployingId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  /** True while we're waiting for agent.registered or error in response to agent.connectFlue. */
  const connectPendingRef = useRef(false);
  /** The agentId whose config modal is currently open, or null. */
  const [configAgentId, setConfigAgentId] = useState<string | null>(null);
  /** Ref mirror of configAgentId for the once-registered event handler. */
  const configAgentIdRef = useRef<string | null>(null);
  /** Whether the last saved config needs a redeploy to take effect. */
  const [configRequiresRedeploy, setConfigRequiresRedeploy] = useState(false);
  /** True while a config.set is in flight (waiting for config.updated). */
  const [configSaving, setConfigSaving] = useState(false);
  /** Error returned by the Core for the last config.set, shown inside the modal. */
  const [configError, setConfigError] = useState<string | null>(null);
  /** Ref mirror of configSaving for the once-registered error handler. */
  const configSavingRef = useRef(false);
  /** The agentId whose deploy log modal is currently open, or null. */
  const [deployLogViewId, setDeployLogViewId] = useState<string | null>(null);
  /** The last deploy log fetched from the Core (null = not yet fetched or no log). */
  const [deployLastLog, setDeployLastLog] = useState<string | null | undefined>(undefined);
  /** Error returned by the Core for the in-flight deploy.lastLog request, if any. */
  const [deployLogError, setDeployLogError] = useState<string | null>(null);
  /** True while we're waiting for deploy.lastLog or error in response to a log request. */
  const deployLogPendingRef = useRef(false);
  // ── Org registry (G1) ──────────────────────────────────────────────────────
  /** Current org binding state. null = not yet received from Core. */
  const [orgStatus, setOrgStatus] = useState<OrgStatus | null>(null);
  /** null = org.members response not yet received (distinguishes unloaded from empty). */
  const [orgMembers, setOrgMembers] = useState<OrgMember[] | null>(null);
  const [orgError, setOrgError] = useState<{ message: string; requestType?: string } | null>(null);

  function resetDeploy(): void {
    setDeployStatus(null);
    setDeployError(null);
    setDeployArtifact(null);
    setDeployLog([]);
    setDeployUnmapped([]);
  }

  function setSaving(v: boolean): void {
    configSavingRef.current = v;
    setConfigSaving(v);
  }

  function openConfig(id: string): void {
    setConfigAgentId(id);
    configAgentIdRef.current = id;
    setConfigRequiresRedeploy(false);
    setSaving(false);
    setConfigError(null);
  }

  function closeConfig(): void {
    setConfigAgentId(null);
    configAgentIdRef.current = null;
    setConfigRequiresRedeploy(false);
    setSaving(false);
    setConfigError(null);
  }

  function handleSaveConfig(modelSpecifier: string | null): void {
    if (!configAgentId) return;
    setSaving(true);
    setConfigError(null);
    const sent = client.send({ type: "config.set", agentId: configAgentId, modelSpecifier });
    if (!sent) {
      setSaving(false);
      setConfigError("Not connected to the Core — reconnecting. Try again in a moment.");
    }
  }

  function handleRedeploy(id: string): void {
    resetDeploy();
    setDeployStatus("starting");
    setRedeployingId(id);
    const sent = client.send({ type: "agent.redeploy", agentId: id });
    if (!sent) setDeployError("Not connected to the Core — reconnecting. Try again in a moment.");
  }

  function handleConnect(baseUrl: string, agentName: string, token?: string): boolean {
    setConnectError(null);
    const sent = client.send({ type: "agent.connectFlue", baseUrl, agentName, token });
    if (sent) connectPendingRef.current = true;
    return sent;
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
        // Close the connect modal on successful registration (covers both deploy and connect paths).
        if (connectPendingRef.current) {
          connectPendingRef.current = false;
          setConnectOpen(false);
          setConnectError(null);
        }
      } else if (e.type === "agent.updated") {
        setAgents((prev) => upsertAgent(prev, e.agent));
      } else if (e.type === "agent.removed") {
        setAgents((prev) => prev.filter((a) => a.id !== e.agentId));
      } else if (e.type === "secrets.status") {
        setSecretsProviders(e.providers);
      } else if (e.type === "usage.summary") {
        setUsageSummary({ since: e.since, rows: e.rows, totals: e.totals });
      } else if (e.type === "deploy.progress") {
        setDeployStatus(e.detail ? `${e.step} — ${e.detail}` : e.step);
        setDeployError(null);
      } else if (e.type === "deploy.log") {
        setDeployLog((prev) => [...prev.slice(-400), ...e.lines]);
      } else if (e.type === "deploy.unmapped") {
        setDeployUnmapped(e.items);
      } else if (e.type === "deploy.artifact") {
        // A deploy with no running agent (e.g. github) — surface the artifact URL.
        setDeployStatus(null);
        setDeployError(null);
        setDeployArtifact({ url: e.url, message: e.message });
      } else if (e.type === "deploy.error") {
        setDeployStatus(null);
        setDeployError(e.message);
      } else if (e.type === "deploy.preflight") {
        setPreflightChecks(e.checks);
      } else if (e.type === "deploy.githubOwners") {
        setGithubOwners(e.owners);
      } else if (e.type === "config.updated") {
        // Only react to the agent whose config modal is open (handler is registered once).
        if (configAgentIdRef.current === e.agentId) {
          setConfigRequiresRedeploy(e.requiresRedeploy);
          configSavingRef.current = false;
          setConfigSaving(false);
        }
      } else if (e.type === "deploy.lastLog") {
        deployLogPendingRef.current = false;
        setDeployLastLog(e.log);
      } else if (e.type === "deploy.lastFailedLog") {
        setLastFailedDeploy(e.failed);
      } else if (e.type === "error" && connectPendingRef.current) {
        // Surface connect failures inside the modal rather than silently dropping them.
        connectPendingRef.current = false;
        setConnectError(e.message);
      } else if (e.type === "error" && deployLogPendingRef.current) {
        // Surface log-fetch failures inside the log modal instead of leaving it loading forever.
        deployLogPendingRef.current = false;
        setDeployLogError(e.message);
      } else if (e.type === "error" && configSavingRef.current) {
        // A config.set failed (e.g. the agent was deleted) — stop the spinner
        // and surface the error inside the modal instead of dropping it.
        configSavingRef.current = false;
        setConfigSaving(false);
        setConfigError(e.message);
      } else if (e.type === "org.status") {
        setOrgStatus((prev) => ({
          bound: e.bound,
          orgName: e.orgName,
          repo: e.repo,
          myLogin: e.myLogin,
          role: e.role,
          sharedAgentIds: e.sharedAgentIds,
          // Preserve lastSyncedAt across org.status updates (it arrives via org.synced).
          lastSyncedAt: prev?.lastSyncedAt,
        }));
        // Do NOT clear orgError here — a stale error must stay visible until the
        // user sends a new org.* request. Background syncs must not eat it.
        if (!e.bound) setOrgMembers(null); // reset to unloaded on unbind
      } else if (e.type === "org.members") {
        setOrgMembers(e.members);
      } else if (e.type === "org.synced") {
        setOrgStatus((prev) => (prev ? { ...prev, lastSyncedAt: e.at } : prev));
      } else if (e.type === "org.error") {
        setOrgError({ message: e.message, requestType: e.requestType });
      }
    });
    // Refresh lists on every (re)connect; reflect live connection state.
    const offStatus = client.onStatus((c) => {
      setConnected(c);
      if (c) {
        client.send({ type: "agents.list" });
        client.send({ type: "secrets.list" });
        client.send({ type: "org.status" });
      }
    });
    client.connect();
    return () => {
      offMsg();
      offStatus();
    };
  }, [client]);

  // ── Org registry handlers ─────────────────────────────────────────────────
  function handleCreateOrg(repo: string, name: string): void {
    setOrgError(null);
    client.send({ type: "org.create", repo, name });
  }

  function handleJoinOrg(repo: string): void {
    setOrgError(null);
    client.send({ type: "org.join", repo });
  }

  function handleLeaveOrg(): void {
    setOrgError(null);
    client.send({ type: "org.leave" });
  }

  function handleSyncOrg(): void {
    setOrgError(null);
    client.send({ type: "org.sync" });
  }

  function handleShareAgent(agentId: string): void {
    setOrgError(null);
    client.send({ type: "org.share", agentId });
  }

  function handleUnshareAgent(agentId: string): void {
    setOrgError(null);
    client.send({ type: "org.unshare", agentId });
  }

  function handleRequestMembers(): void {
    setOrgError(null);
    client.send({ type: "org.members" });
  }

  // Keep the selection valid: if the selected agent disappears (deleted,
  // removed on reconnect), fall back to the first remaining agent. Pure +
  // idempotent, so it is StrictMode-safe.
  useEffect(() => {
    if (selectedId !== null && !agents.some((a) => a.id === selectedId)) {
      setSelectedId(agents[0]?.id ?? null);
    }
  }, [agents, selectedId]);

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
          // Refresh the persisted first-deploy failure so the wizard can offer its log.
          client.send({ type: "deploy.lastFailedLog" });
          setDeployOpen(true);
        }}
        onOpenConnect={() => {
          setConnectError(null);
          setConnectOpen(true);
        }}
        onRedeploy={handleRedeploy}
        onStop={(id) => {
          const sent = client.send({ type: "agent.stop", agentId: id });
          if (!sent) setDeployError("Not connected to the Core — reconnecting. Try again in a moment.");
        }}
        onDelete={(id) => {
          const sent = client.send({ type: "agent.delete", agentId: id });
          if (!sent) setDeployError("Not connected to the Core — reconnecting. Try again in a moment.");
        }}
        onOpenConfig={openConfig}
        onOpenSettings={() => setSettingsOpen(true)}
        onViewDeployLog={(id) => {
          setDeployLastLog(undefined); // reset while loading
          setDeployLogError(null);
          setDeployLogViewId(id);
          deployLogPendingRef.current = true;
          client.send({ type: "deploy.lastLog", agentId: id });
        }}
      />
      <main className="main">
        {!connected && (
          <div className="connection-banner" role="status" aria-live="polite">
            <span className="connection-banner-dot" aria-hidden="true" />
            Reconnecting to Fleet Core…
          </div>
        )}
        <div className="tabs">
          <button className={`tab ${view === "terminal" ? "active" : ""}`} onClick={() => setView("terminal")}>
            Terminal
          </button>
          <button className={`tab ${view === "canvas" ? "active" : ""}`} onClick={() => setView("canvas")}>
            Workflows
          </button>
        </div>
        {view === "terminal" ? (
          <TerminalPanel client={client} agent={selected} connected={connected} onRedeploy={handleRedeploy} />
        ) : (
          <WorkflowCanvas client={client} agents={agents} connected={connected} />
        )}
      </main>

      {deployOpen && (
        <DeployWizard
          connected={connected}
          deployStatus={deployStatus}
          deployError={deployError}
          deployArtifact={deployArtifact}
          deployLog={deployLog}
          deployUnmapped={deployUnmapped}
          preflightChecks={preflightChecks}
          githubOwners={githubOwners}
          lastFailedDeploy={lastFailedDeploy}
          onPreflight={(params) => {
            setPreflightChecks(null); // clear while the check runs
            client.send({ type: "deploy.preflight", ...params });
          }}
          onRequestGithubOwners={() => {
            client.send({ type: "deploy.githubOwners" });
          }}
          onOpenConnect={() => {
            setDeployOpen(false);
            setPreflightChecks(null);
            resetDeploy();
            setConnectError(null);
            setConnectOpen(true);
          }}
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
            setPreflightChecks(null);
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
          deployUnmapped={deployUnmapped}
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
          usage={usageSummary}
          onRequestUsage={(since) => client.send({ type: "usage.summary", since })}
          onSetSecret={(provider, apiKey) => client.send({ type: "secrets.set", provider, apiKey })}
          onClose={() => {
            setSettingsOpen(false);
            // Drop the snapshot so the next open shows "Loading…" instead of stale data.
            setUsageSummary(null);
          }}
          orgStatus={orgStatus}
          orgMembers={orgMembers}
          orgError={orgError}
          agents={agents}
          onCreateOrg={handleCreateOrg}
          onJoinOrg={handleJoinOrg}
          onLeaveOrg={handleLeaveOrg}
          onSyncOrg={handleSyncOrg}
          onRequestMembers={handleRequestMembers}
          onShareAgent={handleShareAgent}
          onUnshareAgent={handleUnshareAgent}
        />
      )}

      {configAgentId &&
        (() => {
          const agent = agents.find((a) => a.id === configAgentId);
          if (!agent) return null;
          return (
            <AgentConfig
              agent={agent}
              connected={connected}
              requiresRedeploy={configRequiresRedeploy}
              saving={configSaving}
              saveError={configError}
              onSave={handleSaveConfig}
              onRedeploy={() => {
                const id = configAgentId;
                closeConfig();
                handleRedeploy(id);
              }}
              onClose={closeConfig}
            />
          );
        })()}

      {connectOpen && (
        <ConnectAgent
          connected={connected}
          onConnect={handleConnect}
          onClose={() => {
            connectPendingRef.current = false;
            setConnectOpen(false);
            setConnectError(null);
          }}
          error={connectError}
        />
      )}

      {deployLogViewId && (
        <Modal
          title={`Last deploy log — ${agents.find((a) => a.id === deployLogViewId)?.name ?? deployLogViewId}`}
          onClose={() => {
            deployLogPendingRef.current = false;
            setDeployLogViewId(null);
            setDeployLastLog(undefined);
            setDeployLogError(null);
          }}
          dismissable
          footer={
            <button
              className="btn-primary"
              onClick={() => {
                deployLogPendingRef.current = false;
                setDeployLogViewId(null);
                setDeployLastLog(undefined);
                setDeployLogError(null);
              }}
            >
              Close
            </button>
          }
        >
          {deployLogError !== null ? (
            <p className="empty">Failed to load the deploy log: {deployLogError}</p>
          ) : deployLastLog === undefined ? (
            <div className="deploy-running">
              <span className="spinner" /> Loading…
            </div>
          ) : deployLastLog === null ? (
            <p className="empty">No deploy log available for this agent.</p>
          ) : (
            <pre className="deploy-log">{deployLastLog}</pre>
          )}
        </Modal>
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
