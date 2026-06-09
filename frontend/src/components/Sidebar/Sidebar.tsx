/**
 * Sidebar — the fleet. Lists the deployed agents and exposes two actions:
 * open the Deploy wizard (convert + deploy a Claude Code project as a Flue agent)
 * and open Settings (provider API keys). The actual forms live in their modals.
 */

import { useState } from "react";
import type { AgentSummary } from "../../lib/api";
import { Modal } from "../Modal/Modal";

interface Props {
  agents: AgentSummary[];
  selectedId: string | null;
  connected: boolean;
  secretsProviders: string[];
  onSelect: (id: string) => void;
  onOpenDeploy: () => void;
  onRedeploy: (id: string) => void;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  agents,
  selectedId,
  connected,
  secretsProviders,
  onSelect,
  onOpenDeploy,
  onRedeploy,
  onStop,
  onDelete,
  onOpenSettings,
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
        />
      </div>

      <ul className="agent-list">
        {agents.map((a) => (
          <li
            key={a.id}
            className={`agent ${a.id === selectedId ? "selected" : ""}`}
            onClick={() => onSelect(a.id)}
          >
            <div className="agent-name">
              {a.name}
              <span className={`badge ${a.online ? "online" : ""}`}>{a.online ? "online" : "offline"}</span>
            </div>
            <div className="agent-meta">{a.model}</div>
            <div className="agent-actions">
              {a.redeployable && (
                <button
                  className="btn-ghost agent-redeploy"
                  disabled={!connected}
                  title="Rebuild and deploy this agent again (picks up new API keys/settings)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRedeploy(a.id);
                  }}
                >
                  ↻ Redeploy
                </button>
              )}
              {a.online && (
                <button
                  className="btn-ghost agent-stop"
                  disabled={!connected}
                  title="Stop this agent's runtime (keeps registration for redeploy)"
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
        <button className="btn-ghost settings-cta" onClick={onOpenSettings}>
          ⚙ Settings
          {secretsProviders.length > 0 && <span className="keys-count"> ({secretsProviders.length})</span>}
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
