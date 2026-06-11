/**
 * Sidebar — the fleet. Lists the deployed agents and exposes three actions:
 * open the Deploy wizard (convert + deploy a Claude Code project as a Flue agent),
 * open the Connect modal (attach an already-running Flue agent by URL), and
 * open Settings (provider API keys). The actual forms live in their modals.
 */

import { useState } from "react";
import type { AgentSummary } from "../../lib/api";
import { Modal } from "../Modal/Modal";
import { INFRA_CREDENTIAL_IDS } from "../../lib/providers";

/** Remote targets whose deployment Fleet cannot stop — it keeps running after Stop/Delete. */
const REMOTE_KEEPS_RUNNING: ReadonlySet<string> = new Set(["fly", "cloudflare", "github"]);

interface Props {
  agents: AgentSummary[];
  selectedId: string | null;
  connected: boolean;
  secretsProviders: string[];
  onSelect: (id: string) => void;
  onOpenDeploy: () => void;
  onOpenConnect: () => void;
  onRedeploy: (id: string) => void;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenConfig: (id: string) => void;
  onOpenSettings: () => void;
  onViewDeployLog: (id: string) => void;
}

export function Sidebar({
  agents,
  selectedId,
  connected,
  secretsProviders,
  onSelect,
  onOpenDeploy,
  onOpenConnect,
  onRedeploy,
  onStop,
  onDelete,
  onOpenConfig,
  onOpenSettings,
  onViewDeployLog,
}: Props): React.JSX.Element {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const confirmDeleteAgent = agents.find((a) => a.id === confirmDeleteId) ?? null;

  function handleConfirmDelete(): void {
    if (confirmDeleteId) {
      onDelete(confirmDeleteId);
      setConfirmDeleteId(null);
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span>Fleet</span>
        <span
          className={`dot ${connected ? "online" : "offline"}`}
          title={connected ? "connected to Core" : "disconnected"}
          role="status"
          aria-label={connected ? "Connected to Core" : "Disconnected"}
        />
      </div>

      <ul className="agent-list">
        {agents.map((a) => (
          <li
            key={a.id}
            className={`agent ${a.id === selectedId ? "selected" : ""}`}
            onClick={() => onSelect(a.id)}
            role="button"
            tabIndex={0}
            aria-pressed={a.id === selectedId}
            aria-label={`Select agent ${a.name}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(a.id);
              }
            }}
          >
            <div className="agent-name">
              <span className="agent-name-text">
                {a.name}
                {a.version && <span className="agent-version">v{a.version}</span>}
              </span>
              <span className={`badge ${a.online ? "online" : ""}`}>{a.online ? "online" : "offline"}</span>
            </div>
            {a.description && (
              <div className="agent-desc" title={a.description}>
                {a.description}
              </div>
            )}
            <div className="agent-meta">
              {a.target && <span className={`agent-target ${a.target}`}>{a.target}</span>}
              {a.url && (
                <span className="agent-url" title={a.url}>
                  {a.url.replace(/^https?:\/\//, "")}
                </span>
              )}
              {a.model && <span className="agent-model">{a.model}</span>}
            </div>
            <div className="agent-actions">
              <button
                className="btn-ghost agent-config"
                disabled={!connected}
                title="Configure this agent's model"
                aria-label={`Configure model for ${a.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenConfig(a.id);
                }}
              >
                ⚙ Model
              </button>
              {a.redeployable && (
                <button
                  className="btn-ghost agent-redeploy"
                  disabled={!connected}
                  title="Rebuild and deploy this agent again (picks up new API keys/settings)"
                  aria-label={`Redeploy ${a.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRedeploy(a.id);
                  }}
                >
                  ↻ Redeploy
                </button>
              )}
              {a.redeployable && (
                <button
                  className="btn-ghost agent-deploy-log"
                  disabled={!connected}
                  title="View the log from the last deploy"
                  aria-label={`View deploy log for ${a.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewDeployLog(a.id);
                  }}
                >
                  ☰ Deploy log
                </button>
              )}
              {a.online && (
                <button
                  className="btn-ghost agent-stop"
                  disabled={!connected}
                  title={
                    a.target === "dokploy"
                      ? "Stop this agent and its remote Dokploy application (keeps registration for redeploy)"
                      : a.target && REMOTE_KEEPS_RUNNING.has(a.target)
                        ? `Disconnect this agent — the ${a.target} deployment keeps running and must be stopped manually`
                        : "Stop this agent's runtime (keeps registration for redeploy)"
                  }
                  aria-label={`Stop ${a.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStop(a.id);
                  }}
                >
                  ■ Stop
                </button>
              )}
              <button
                className="btn-ghost agent-delete"
                disabled={!connected}
                title="Permanently remove this agent from Fleet"
                aria-label={`Delete ${a.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDeleteId(a.id);
                }}
              >
                ✕ Delete
              </button>
            </div>
          </li>
        ))}
        {agents.length === 0 && (
          <li className="onboarding" role="presentation">
            <p className="onboarding-title">Welcome to Fleet</p>
            <p className="onboarding-hint">Three steps to your first agent:</p>
            <ol className="onboarding-steps">
              <li>
                <span>Add your provider API key</span>
                <button className="btn-ghost" onClick={onOpenSettings}>
                  ⚙ Open Settings
                </button>
              </li>
              <li>
                <span>Deploy a Claude Code project as a Flue agent</span>
                <button className="btn-ghost" onClick={onOpenDeploy} disabled={!connected}>
                  + Deploy agent
                </button>
              </li>
              <li>
                <span>…or connect a Flue agent that is already running</span>
                <button className="btn-ghost" onClick={onOpenConnect} disabled={!connected}>
                  ⟳ Connect agent
                </button>
              </li>
            </ol>
            <p className="onboarding-hint">Then pick the agent and chat from the Terminal tab.</p>
          </li>
        )}
      </ul>

      <div className="sidebar-actions">
        <button className="btn-primary deploy-cta" onClick={onOpenDeploy} disabled={!connected}>
          + Deploy agent
        </button>
        <button className="btn-ghost connect-cta" onClick={onOpenConnect} disabled={!connected}>
          ⟳ Connect agent
        </button>
        <button className="btn-ghost settings-cta" onClick={onOpenSettings}>
          ⚙ Settings
          {secretsProviders.filter((id) => !INFRA_CREDENTIAL_IDS.includes(id)).length > 0 && (
            <span className="keys-count"> ({secretsProviders.filter((id) => !INFRA_CREDENTIAL_IDS.includes(id)).length})</span>
          )}
        </button>
      </div>

      {confirmDeleteAgent && (
        <Modal
          title="Delete agent"
          onClose={() => setConfirmDeleteId(null)}
          dismissable
          footer={
            <>
              <button className="btn-ghost" onClick={() => setConfirmDeleteId(null)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleConfirmDelete}>
                Delete
              </button>
            </>
          }
        >
          <p>
            Delete <strong>{confirmDeleteAgent.name}</strong>? This removes it from Fleet along with
            its deploy parameters. The action cannot be undone.
          </p>
          {confirmDeleteAgent.target === "dokploy" && (
            <p className="modal-note">
              The remote Dokploy application will be stopped, but its application record, domain,
              and GitHub repo are not deleted — clean those up in Dokploy/GitHub if you want them
              gone.
            </p>
          )}
          {confirmDeleteAgent.target && REMOTE_KEEPS_RUNNING.has(confirmDeleteAgent.target) && (
            <p className="modal-note">
              ⚠ The deployment on {confirmDeleteAgent.target} keeps running (and billing) after
              this — stop it manually via the provider's dashboard or CLI.
            </p>
          )}
        </Modal>
      )}
    </aside>
  );
}
