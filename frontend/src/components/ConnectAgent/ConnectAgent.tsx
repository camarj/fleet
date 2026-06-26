/**
 * ConnectAgent — modal to attach an already-running agent by URL. A kind toggle
 * picks the protocol: a native **Flue** agent (`agent.connectFlue`) or a
 * third-party **A2A** agent (`agent.connectA2a`, pivote A2). Success arrives as
 * `agent.registered` (handled by App.tsx, which closes this modal). Errors arrive
 * as the generic `error` event and are threaded in via the `error` prop — for A2A
 * this includes the routability guard ("must be a public URL").
 *
 * NOTE: `instanceId` is omitted from the form. The API accepts it but it is
 * optional and not needed for the common "attach a named agent" case.
 */

import { useEffect, useState } from "react";
import type { AgentKind } from "../../lib/api";
import { Modal } from "../Modal/Modal";

interface Props {
  connected: boolean;
  /**
   * Send the connect request for the chosen kind. Returns true if the WS message
   * was enqueued, false when the client is not yet connected.
   */
  onConnect: (kind: AgentKind, baseUrl: string, agentName: string, token?: string) => boolean;
  onClose: () => void;
  /**
   * A Core error message that arrived while waiting for a connect response.
   * The parent sets this via the generic `error` event; the modal surfaces it.
   */
  error: string | null;
}

export function ConnectAgent({ connected, onConnect, onClose, error }: Props): React.JSX.Element {
  const [kind, setKind] = useState<AgentKind>("flue");
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
    const sent = onConnect(kind, baseUrl.trim(), agentName.trim(), token.trim() || undefined);
    if (!sent) {
      setLocalError("Not connected to the Core — reconnecting. Try again in a moment.");
    } else {
      setConnecting(true);
    }
  }

  return (
    <Modal
      title={kind === "a2a" ? "Register an A2A agent" : "Connect a Flue agent"}
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
      <div className="wizard-field">
        <label>Protocol</label>
        <div className="connect-kind-toggle" role="radiogroup" aria-label="Agent protocol">
          <button
            type="button"
            role="radio"
            aria-checked={kind === "flue"}
            className={`btn-ghost ${kind === "flue" ? "selected" : ""}`}
            onClick={() => setKind("flue")}
            disabled={connecting}
          >
            Flue
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={kind === "a2a"}
            className={`btn-ghost ${kind === "a2a" ? "selected" : ""}`}
            onClick={() => setKind("a2a")}
            disabled={connecting}
          >
            A2A
          </button>
        </div>
      </div>

      <p className="settings-note">
        {kind === "a2a"
          ? "Register a third-party agent that speaks A2A by its endpoint URL. It must be reachable at a public URL — a local/private host is rejected."
          : "Attach an already-running Flue agent to Fleet by its HTTP base URL. The agent must be reachable from this machine."}
      </p>

      <div className="wizard-field">
        <label htmlFor="connect-base-url">{kind === "a2a" ? "A2A endpoint URL" : "Base URL"}</label>
        <input
          id="connect-base-url"
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={kind === "a2a" ? "https://agent.example.com/a2a" : "http://localhost:3000"}
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
