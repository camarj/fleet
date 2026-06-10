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
              {a.name}
              <span className={`badge ${a.online ? "online" : ""}`}>{a.online ? "online" : "offline"}</span>
            </div>
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
                  title="Stop this agent's runtime (keeps registration for redeploy)"
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
        {agents.length === 0 && <li className="empty">No agents yet — deploy one below</li>}
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
        </Modal>
      )}
    </aside>
  );
}
