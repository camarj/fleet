/**
 * Sidebar — the fleet. Lists the deployed agents and holds the one action that
 * brings a new one in: DEPLOY a local Claude Code project as a Flue agent
 * (choose folder → pick provider/model → pick where to deploy → Deploy). Also
 * holds the provider API-key settings (stored server-side, never persisted here).
 */

import { useState } from "react";
import type { AgentSummary, DeployTarget } from "../../lib/api";
import { isTauri, pickDirectory } from "../../lib/dialog";

const PROVIDERS = ["anthropic", "openai", "openrouter", "cloudflare"] as const;

/** The four deploy forms offered in the UI (local-process stays test-only). */
const DEPLOY_TARGETS: { value: DeployTarget; label: string; hint: string }[] = [
  { value: "docker-local", label: "Docker — local", hint: "Run a container on this machine." },
  { value: "fly", label: "Docker — Fly.io", hint: "Deploy to Fly.io (needs FLY_API_TOKEN)." },
  { value: "github", label: "Git repo — self-host", hint: "Push a repo to deploy on Coolify / Dokploy." },
  { value: "cloudflare", label: "Cloudflare Workers", hint: "Deploy as a Worker (needs CLOUDFLARE_API_TOKEN)." },
];

interface Props {
  agents: AgentSummary[];
  selectedId: string | null;
  connected: boolean;
  secretsProviders: string[];
  deployStatus: string | null;
  deployError: string | null;
  deployArtifact: { url: string; message: string } | null;
  onSelect: (id: string) => void;
  onDeploy: (req: { sourceDir: string; provider?: string; model?: string; target: DeployTarget }) => void;
  onSetSecret: (provider: string, apiKey: string) => void;
}

export function Sidebar({
  agents,
  selectedId,
  connected,
  secretsProviders,
  deployStatus,
  deployError,
  deployArtifact,
  onSelect,
  onDeploy,
  onSetSecret,
}: Props): React.JSX.Element {
  // Deploy form
  const [sourceDir, setSourceDir] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [target, setTarget] = useState<DeployTarget>("docker-local");
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

  const activeTarget = DEPLOY_TARGETS.find((t) => t.value === target);

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

      <div className="sidebar-form">
        {/* ── Deploy a Claude Code project as a Flue agent ── */}
        <div className="deploy-card">
          <div className="deploy-title">Deploy a Claude Code agent</div>

          {/* Step 1 — choose the project folder */}
          <button className="folder-btn" onClick={browse} disabled={deploying}>
            <span className="folder-icon">📁</span>
            {sourceDir ? "Change folder" : "Choose project folder"}
          </button>
          {sourceDir && (
            <code className="folder-path" title={sourceDir}>
              {sourceDir}
            </code>
          )}
          {!isTauri() && (
            <input
              className="folder-input"
              value={sourceDir}
              onChange={(e) => setSourceDir(e.target.value)}
              placeholder="…or type the project path"
              disabled={deploying}
            />
          )}

          {/* Step 2 — provider / model (optional) */}
          <div className="row">
            <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={deploying}>
              <option value="">Model: keep source</option>
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

          {/* Step 3 — where to deploy */}
          <select
            className="target-select"
            value={target}
            onChange={(e) => setTarget(e.target.value as DeployTarget)}
            disabled={deploying}
          >
            {DEPLOY_TARGETS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {activeTarget && <div className="target-hint">{activeTarget.hint}</div>}

          <button
            className="deploy-btn"
            onClick={deploy}
            disabled={!connected || deploying || !sourceDir.trim()}
          >
            {deploying ? "Deploying…" : "Deploy"}
          </button>

          {deployStatus && <div className="deploy-status">{deployStatus}</div>}
          {deployError && <div className="deploy-error">{deployError}</div>}
          {deployArtifact && (
            <div className="deploy-artifact">
              <a href={deployArtifact.url} target="_blank" rel="noreferrer">
                {deployArtifact.url}
              </a>
              <span>{deployArtifact.message}</span>
            </div>
          )}
        </div>

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
      </div>
    </aside>
  );
}
