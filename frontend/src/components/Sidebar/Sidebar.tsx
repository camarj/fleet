/**
 * Sidebar — the fleet. Lists agents and lets you bring one in: connect a remote
 * A2A agent by URL, launch a local ACP agent by path, or DEPLOY a Claude Code
 * project as a Flue agent (convert → build → run → connect). Also holds the
 * provider API-key settings (stored server-side, never persisted here).
 */

import { useState } from "react";
import type { AgentSummary } from "../../lib/api";
import { isTauri, pickDirectory } from "../../lib/dialog";

const PROVIDERS = ["anthropic", "openai", "openrouter", "cloudflare"] as const;

interface Props {
  agents: AgentSummary[];
  selectedId: string | null;
  connected: boolean;
  secretsProviders: string[];
  deployStatus: string | null;
  deployError: string | null;
  onSelect: (id: string) => void;
  onConnectA2A: (url: string) => void;
  onLaunchAcp: (cwd: string) => void;
  onDeploy: (req: { sourceDir: string; provider?: string; model?: string; target?: "docker-local" | "local-process" }) => void;
  onSetSecret: (provider: string, apiKey: string) => void;
}

export function Sidebar({
  agents,
  selectedId,
  connected,
  secretsProviders,
  deployStatus,
  deployError,
  onSelect,
  onConnectA2A,
  onLaunchAcp,
  onDeploy,
  onSetSecret,
}: Props): React.JSX.Element {
  const [url, setUrl] = useState("http://127.0.0.1:8080");
  const [cwd, setCwd] = useState("");

  // Deploy form
  const [sourceDir, setSourceDir] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [target, setTarget] = useState<"docker-local" | "local-process">("docker-local");
  const deploying = deployStatus !== null;

  // Settings form
  const [keyProvider, setKeyProvider] = useState<string>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);

  async function browse(): Promise<void> {
    const dir = await pickDirectory();
    if (dir) setSourceDir(dir);
  }

  function deploy(): void {
    if (!sourceDir.trim()) return;
    onDeploy({
      sourceDir: sourceDir.trim(),
      provider: provider || undefined,
      model: model.trim() || undefined,
      target,
    });
  }

  function saveKey(): void {
    if (keyProvider && apiKey.trim()) {
      onSetSecret(keyProvider, apiKey.trim());
      setApiKey("");
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
              <span className={`badge kind ${a.kind}`}>{a.kind}</span>
              <span className={`badge ${a.online ? "online" : ""}`}>{a.online ? "online" : "offline"}</span>
            </div>
            <div className="agent-meta">{a.model}</div>
          </li>
        ))}
        {agents.length === 0 && <li className="empty">No agents yet</li>}
      </ul>

      <div className="sidebar-form">
        {/* ── Deploy a Claude Code project as a Flue agent ── */}
        <label>Deploy agent</label>
        <div className="row">
          <input
            value={sourceDir}
            onChange={(e) => setSourceDir(e.target.value)}
            placeholder="Claude Code project directory"
          />
          <button onClick={browse} disabled={deploying} title={isTauri() ? "Browse…" : "Type the path"}>
            {isTauri() ? "Browse…" : "—"}
          </button>
        </div>
        <div className="row">
          <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={deploying}>
            <option value="">model: keep source</option>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="model id (optional)"
            disabled={deploying}
          />
        </div>
        <div className="row">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as "docker-local" | "local-process")}
            disabled={deploying}
          >
            <option value="docker-local">Docker (local container)</option>
            <option value="local-process">Local process (dev, no Docker)</option>
          </select>
        </div>
        <button className="deploy-btn" onClick={deploy} disabled={!connected || deploying || !sourceDir.trim()}>
          {deploying ? "Deploying…" : "Deploy"}
        </button>
        {deployStatus && <div className="deploy-status">{deployStatus}</div>}
        {deployError && <div className="deploy-error">{deployError}</div>}

        {/* ── Provider API keys (stored server-side) ── */}
        <button className="settings-toggle" onClick={() => setShowSettings((s) => !s)}>
          {showSettings ? "▼" : "▶"} API keys
          {secretsProviders.length > 0 && <span className="keys-count"> ({secretsProviders.length} set)</span>}
        </button>
        {showSettings && (
          <div className="settings">
            <div className="row">
              <select value={keyProvider} onChange={(e) => setKeyProvider(e.target.value)}>
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                    {secretsProviders.includes(p) ? " ✓" : ""}
                  </option>
                ))}
              </select>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="API key"
              />
              <button onClick={saveKey} disabled={!connected || !apiKey.trim()}>
                Save
              </button>
            </div>
          </div>
        )}

        {/* ── Connect existing agents ── */}
        <label>Connect A2A agent</label>
        <div className="row">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://agent.example.com" />
          <button onClick={() => url.trim() && onConnectA2A(url.trim())} disabled={!connected || !url.trim()}>
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
