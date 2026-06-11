/**
 * AgentConfig — per-agent configuration modal. Today it carries the model
 * override. Because Flue bakes the model at convert time, saving a new model
 * doesn't change a running agent: the Core reports `requiresRedeploy`, and this
 * modal then offers a "Redeploy to apply" action (the honest path).
 */

import { useState } from "react";
import type { AgentSummary } from "../../lib/api";
import { Modal } from "../Modal/Modal";
import { ModelPicker } from "../ModelPicker/ModelPicker";
import { splitSpecifier } from "../../lib/providers";

interface Props {
  agent: AgentSummary;
  connected: boolean;
  /** True after a save when the change needs a redeploy to take effect. */
  requiresRedeploy: boolean;
  /** True while a save is in flight (waiting for config.updated). */
  saving: boolean;
  /** Error from the last save attempt, or null. Shown inside the modal. */
  saveError: string | null;
  onSave: (modelSpecifier: string | null) => void;
  onRedeploy: () => void;
  onClose: () => void;
}

export function AgentConfig({
  agent,
  connected,
  requiresRedeploy,
  saving,
  saveError,
  onSave,
  onRedeploy,
  onClose,
}: Props): React.JSX.Element {
  const initial = splitSpecifier(agent.model);
  const [pick, setPick] = useState(initial);
  // Whether the picker changed since the last save — hides the stale redeploy CTA.
  const [dirty, setDirty] = useState(false);

  function save(): void {
    setDirty(false);
    const specifier = pick.provider && pick.model ? `${pick.provider}/${pick.model}` : null;
    onSave(specifier);
  }

  const showRedeployCta = requiresRedeploy && !dirty;

  const footer = (
    <>
      <button className="btn-ghost" onClick={onClose}>
        Close
      </button>
      <button className="btn-primary" onClick={save} disabled={!connected || saving}>
        {saving ? "Saving…" : "Save"}
      </button>
    </>
  );

  return (
    <Modal title={`Configure — ${agent.name}`} onClose={onClose} footer={footer} dismissable>
      <div className="wizard-field">
        {agent.description && <p className="agent-config-desc">{agent.description}</p>}
        {agent.version && (
          <div className="review-row">
            <span>Version</span>
            <code>{agent.version}</code>
          </div>
        )}
        <div className="review-row">
          <span>Current model</span>
          <code>{agent.model || "keep source"}</code>
        </div>

        <ModelPicker
          initialProvider={initial.provider}
          initialModel={initial.model}
          onChange={(next) => {
            setPick(next);
            setDirty(true);
          }}
        />

        <div className="folder-hint">
          {pick.provider
            ? "The agent will run this provider + model after a redeploy."
            : "“Keep source” clears the override and uses the project’s original model."}
        </div>

        {saveError && (
          <div className="deploy-error" role="alert">
            Failed to save: {saveError}
          </div>
        )}

        {showRedeployCta && (
          <div className="config-redeploy">
            <span>Saved. This change needs a redeploy to take effect.</span>
            <button
              className="btn-primary"
              onClick={onRedeploy}
              disabled={!connected || !agent.redeployable}
              title={agent.redeployable ? "Rebuild the agent with the new model" : "This agent has no stored deploy to repeat"}
            >
              ↻ Redeploy to apply
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
