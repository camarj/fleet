/**
 * DeployProgress — a minimal modal that shows a redeploy in flight: the current
 * step, the live command log, and the final result. It reuses the same deploy
 * state and CSS classes as the DeployWizard's last step, but without the wizard
 * form (a redeploy already has all its inputs from the original deploy).
 */

import { useEffect, useRef } from "react";
import { Modal } from "../Modal/Modal";

interface Props {
  agentName: string;
  deployStatus: string | null;
  deployError: string | null;
  deployLog: string[];
  /** Source features that did NOT convert to Flue, reported after conversion. */
  deployUnmapped: { kind: string; name: string; reason: string }[];
  /** True once the redeploy finished (registered or errored) — lets the user close. */
  done: boolean;
  onClose: () => void;
}

export function DeployProgress({
  agentName,
  deployStatus,
  deployError,
  deployLog,
  deployUnmapped,
  done,
  onClose,
}: Props): React.JSX.Element {
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [deployLog]);

  const footer = (
    <button className="btn-primary" onClick={onClose} disabled={!done}>
      {done ? "Close" : "Redeploying…"}
    </button>
  );

  return (
    <Modal title={`Redeploy — ${agentName}`} onClose={onClose} footer={footer} dismissable={done}>
      <div className="wizard-result">
        {deployError ? (
          <div className="deploy-error">{deployError}</div>
        ) : done ? (
          <div className="result-ok">✓ Agent redeployed and connected.</div>
        ) : (
          <div className="deploy-running">
            <span className="spinner" /> {deployStatus ?? "starting"}…
          </div>
        )}
        {deployUnmapped.length > 0 && (
          <details className="deploy-unmapped">
            <summary>
              ⚠ This agent loses {deployUnmapped.length} feature
              {deployUnmapped.length === 1 ? "" : "s"} when converted to Flue.
            </summary>
            <ul>
              {deployUnmapped.map((u, i) => (
                <li key={`${u.kind}-${u.name}-${i}`}>
                  <strong>{u.name}</strong> ({u.kind}) — {u.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        {deployLog.length > 0 && (
          <pre className="deploy-log" ref={logRef}>
            {deployLog.join("\n")}
          </pre>
        )}
      </div>
    </Modal>
  );
}
