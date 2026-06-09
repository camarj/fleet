/**
 * Settings — provider API keys, stored server-side in the Core's secure store.
 * The value is never persisted in the frontend; only the set provider IDs come
 * back (shown with a ✓).
 */

import { useState } from "react";
import { Modal } from "../Modal/Modal";
import { PROVIDER_IDS } from "../../lib/providers";

const PROVIDERS = PROVIDER_IDS;

interface Props {
  connected: boolean;
  secretsProviders: string[];
  onSetSecret: (provider: string, apiKey: string) => void;
  onClose: () => void;
}

export function Settings({ connected, secretsProviders, onSetSecret, onClose }: Props): React.JSX.Element {
  const [keyProvider, setKeyProvider] = useState<string>("anthropic");
  const [apiKey, setApiKey] = useState("");

  function save(): void {
    if (keyProvider && apiKey.trim()) {
      onSetSecret(keyProvider, apiKey.trim());
      setApiKey("");
    }
  }

  return (
    <Modal title="Settings — API keys" onClose={onClose} footer={<button className="btn-primary" onClick={onClose}>Done</button>}>
      <p className="settings-note">
        Keys are stored server-side in the Core and used when deploying agents. They are never saved in the app.
      </p>
      <div className="wizard-field">
        <label>Provider key</label>
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
          <button className="btn-primary" onClick={save} disabled={!connected || !apiKey.trim()}>
            Save
          </button>
        </div>
      </div>
      <div className="settings-keys">
        {PROVIDERS.map((p) => (
          <span key={p} className={`key-chip${secretsProviders.includes(p) ? " set" : ""}`}>
            {p} {secretsProviders.includes(p) ? "✓" : "—"}
          </span>
        ))}
      </div>
    </Modal>
  );
}
