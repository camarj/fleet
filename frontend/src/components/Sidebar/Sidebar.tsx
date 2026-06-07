/**
 * Sidebar — the fleet. Lists agents from the registry and lets you bring one in
 * (connect a remote agent over A2A by URL, or launch a local agent over ACP by path).
 */

import { useState } from "react";
import type { AgentSummary } from "../../lib/api";

interface Props {
  agents: AgentSummary[];
  selectedId: string | null;
  connected: boolean;
  onSelect: (id: string) => void;
  onConnectA2A: (url: string) => void;
  onLaunchAcp: (cwd: string) => void;
}

export function Sidebar({ agents, selectedId, connected, onSelect, onConnectA2A, onLaunchAcp }: Props): React.JSX.Element {
  const [url, setUrl] = useState("http://127.0.0.1:8080");
  const [cwd, setCwd] = useState("");

  function connect(): void {
    if (url.trim()) onConnectA2A(url.trim());
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
              <span className={`badge kind ${a.kind}`}>{a.kind}</span>
              <span className={`badge ${a.online ? "online" : ""}`}>{a.online ? "online" : "offline"}</span>
            </div>
            <div className="agent-meta">{a.model}</div>
          </li>
        ))}
        {agents.length === 0 && <li className="empty">No agents yet</li>}
      </ul>

      <div className="sidebar-form">
        <label>Connect A2A agent</label>
        <div className="row">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://agent.example.com" />
          <button onClick={connect} disabled={!connected || !url.trim()}>
            Add
          </button>
        </div>
        <label>Launch ACP agent</label>
        <div className="row">
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/local/agent" />
          <button onClick={() => cwd && onLaunchAcp(cwd)} disabled={!connected || !cwd}>
            Launch
          </button>
        </div>
      </div>
    </aside>
  );
}
