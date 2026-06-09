/**
 * ConnectAgent — simple modal to attach an already-running Flue agent by URL.
 *
 * Sends `agent.connectFlue` to the Core. Success arrives as `agent.registered`
 * (handled by App.tsx, which closes this modal). Errors arrive as the generic
 * `error` event and are threaded in via the `error` prop so they appear here
 * rather than silently failing.
 *
 * NOTE: `instanceId` is omitted from the form. The API accepts it but it is
 * optional and not needed for the common "attach a named agent" case.
 */

import { useEffect, useState } from "react";
import { Modal } from "../Modal/Modal";

interface Props {
  connected: boolean;
  /**
   * Send the connect request. Returns true if the WS message was enqueued,
   * false when the client is not yet connected.
   */
  onConnect: (baseUrl: string, agentName: string, token?: string) => boolean;
  onClose: () => void;
  /**
   * A Core error message that arrived while waiting for a connect response.
   * The parent sets this via the generic `error` event; the modal surfaces it.
   */
  error: string | null;
}

export function ConnectAgent({ connected, onConnect, onClose, error }: Props): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState("");
  const [agentName, setAgentName] = useState("");
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // When the parent surfaces a Core-side error, exit the connecting state and show it.
  useEffect(() => {
    if (error) {
      setConnecting(false);
      setLocalError(error);
    }
  }, [error]);

  const canSubmit = connected && !connecting && baseUrl.trim() !== "" && agentName.trim() !== "";

  function handleSubmit(): void {
    setLocalError(null);
    const sent = onConnect(baseUrl.trim(), agentName.trim(), token.trim() || undefined);
    if (!sent) {
      setLocalError("Not connected to the Core — reconnecting. Try again in a moment.");
    } else {
      setConnecting(true);
    }
  }

  return (
    <Modal
      title="Connect a Flue agent"
      onClose={onClose}
      dismissable={!connecting}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={connecting}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSubmit} disabled={!canSubmit}>
            {connecting ? "Connecting…" : "Connect"}
          </button>
        </>
      }
    >
      <p className="settings-note">
        Attach an already-running Flue agent to Fleet by its HTTP base URL. The agent must be
        reachable from this machine.
      </p>

      <div className="wizard-field">
        <label htmlFor="connect-base-url">Base URL</label>
        <input
          id="connect-base-url"
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:3000"
          disabled={connecting}
          autoFocus
        />
      </div>

      <div className="wizard-field">
        <label htmlFor="connect-agent-name">Agent name</label>
        <input
          id="connect-agent-name"
          type="text"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="my-agent"
          disabled={connecting}
        />
      </div>

      <div className="wizard-field">
        <label htmlFor="connect-token">Token (optional)</label>
        <input
          id="connect-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Bearer token"
          disabled={connecting}
        />
      </div>

      {localError && <p className="deploy-error">{localError}</p>}
    </Modal>
  );
}
