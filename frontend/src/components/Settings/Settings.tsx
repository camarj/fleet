/**
 * Settings — provider API keys and infrastructure credentials, stored
 * server-side in the Core's secure store. Values are never persisted in the
 * frontend; only the set ids come back (shown with a ✓).
 */

import { useState } from "react";
import { Modal } from "../Modal/Modal";
import { PROVIDER_IDS } from "../../lib/providers";

const PROVIDERS = PROVIDER_IDS;

interface InfraField {
  id: string;
  label: string;
  group: string;
  type: "password" | "text";
}

const INFRA_FIELDS: InfraField[] = [
  { id: "FLY_API_TOKEN",        label: "Fly.io API token (FLY_API_TOKEN)",                      group: "Fly.io",     type: "password" },
  { id: "CLOUDFLARE_API_TOKEN", label: "Cloudflare API token (CLOUDFLARE_API_TOKEN)",            group: "Cloudflare", type: "password" },
  { id: "DOKPLOY_URL",          label: "Dokploy instance URL (DOKPLOY_URL)",                     group: "Dokploy",    type: "text"     },
  { id: "DOKPLOY_API_KEY",      label: "Dokploy API key (DOKPLOY_API_KEY)",                      group: "Dokploy",    type: "password" },
  { id: "DOKPLOY_PROJECT",      label: "Dokploy project — optional (DOKPLOY_PROJECT)",           group: "Dokploy",    type: "text"     },
  { id: "DOKPLOY_GITHUB_ID",    label: "Dokploy GitHub App ID — optional (DOKPLOY_GITHUB_ID)",  group: "Dokploy",    type: "text"     },
  { id: "DOKPLOY_DOMAIN",       label: "Dokploy domain — optional (DOKPLOY_DOMAIN)",             group: "Dokploy",    type: "text"     },
];

const INFRA_GROUPS = ["Fly.io", "Cloudflare", "Dokploy"] as const;

interface Props {
  connected: boolean;
  secretsProviders: string[];
  onSetSecret: (provider: string, apiKey: string) => void;
  onClose: () => void;
}

export function Settings({ connected, secretsProviders, onSetSecret, onClose }: Props): React.JSX.Element {
  const [keyProvider, setKeyProvider] = useState<string>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [infraValues, setInfraValues] = useState<Record<string, string>>({});

  // Provider ids that have a key set. Infra ids use UPPER_SNAKE_CASE and never
  // overlap with PROVIDER_IDS (lowercase), so no extra filtering needed here.
  const secretsSet = new Set(secretsProviders);

  function save(): void {
    if (keyProvider && apiKey.trim()) {
      onSetSecret(keyProvider, apiKey.trim());
      setApiKey("");
    }
  }

  function saveInfra(id: string): void {
    // An empty value clears the stored credential (SecretsStore.set deletes on empty).
    onSetSecret(id, (infraValues[id] ?? "").trim());
    setInfraValues((prev) => ({ ...prev, [id]: "" }));
  }

  return (
    <Modal title="Settings — API keys" onClose={onClose} footer={<button className="btn-primary" onClick={onClose}>Done</button>}>
      <p className="settings-note">
        Keys are stored server-side in the Core and used when deploying agents. They are never saved in the app.
      </p>

      {/* ── Provider keys ─────────────────────────────────────── */}
      <div className="wizard-field">
        <label>Provider key</label>
        <div className="row">
          <select value={keyProvider} onChange={(e) => setKeyProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
                {secretsSet.has(p) ? " ✓" : ""}
              </option>
            ))}
          </select>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API key"
          />
          <button className="btn-primary" onClick={save} disabled={!connected || !apiKey.trim()}>
            Save
          </button>
        </div>
      </div>
      <div className="settings-keys">
        {PROVIDERS.map((p) => (
          <span key={p} className={`key-chip${secretsSet.has(p) ? " set" : ""}`}>
            {p} {secretsSet.has(p) ? "✓" : "—"}
          </span>
        ))}
      </div>

      {/* ── Infrastructure credentials ─────────────────────────── */}
      <h3 className="settings-section-title">Infrastructure</h3>
      <p className="settings-note">
        Deploy-target credentials. Each id is the env-var name; a stored value takes precedence over the exported env var.
        Leave the field empty and click Save to clear a stored value.
      </p>
      {INFRA_GROUPS.map((group) => (
        <div key={group} className="settings-infra-group">
          <p className="settings-group-label">{group}</p>
          {INFRA_FIELDS.filter((f) => f.group === group).map((field) => (
            <div key={field.id} className="wizard-field">
              <label>
                {field.label}
                {secretsSet.has(field.id) ? <span className="set-badge"> ✓</span> : null}
              </label>
              <div className="row">
                <input
                  type={field.type}
                  value={infraValues[field.id] ?? ""}
                  onChange={(e) => setInfraValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                  placeholder={field.id}
                />
                <button className="btn-primary" onClick={() => saveInfra(field.id)} disabled={!connected}>
                  Save
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </Modal>
  );
}
