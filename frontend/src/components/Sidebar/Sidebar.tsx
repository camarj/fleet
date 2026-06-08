/**
 * Sidebar — the fleet. Lists the deployed agents and exposes two actions:
 * open the Deploy wizard (convert + deploy a Claude Code project as a Flue agent)
 * and open Settings (provider API keys). The actual forms live in their modals.
 */

import type { AgentSummary } from "../../lib/api";

interface Props {
  agents: AgentSummary[];
  selectedId: string | null;
  connected: boolean;
  secretsProviders: string[];
  onSelect: (id: string) => void;
  onOpenDeploy: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  agents,
  selectedId,
  connected,
  secretsProviders,
  onSelect,
  onOpenDeploy,
  onOpenSettings,
}: Props): React.JSX.Element {
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
    </aside>
  );
}
