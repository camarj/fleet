/**
 * DeployWizard — a step-by-step modal to deploy a Claude Code project as a Flue
 * agent: Project → Model → Target → Review & Deploy. Replaces the old all-at-once
 * sidebar form. Folder selection (button + drag) only yields a real path in the
 * Tauri desktop shell.
 */

import { useEffect, useRef, useState } from "react";
import type { DeployTarget } from "../../lib/api";
import { Modal } from "../Modal/Modal";
import { isTauri, onDirectoryDrop, pickDirectory } from "../../lib/dialog";
import { PROVIDER_CATALOG, modelsFor } from "../../lib/providers";

const CUSTOM = "__custom__";

const DEPLOY_TARGETS: { value: DeployTarget; label: string; hint: string }[] = [
  { value: "docker-local", label: "Docker — local", hint: "Run a container on this machine." },
  { value: "fly", label: "Docker — Fly.io", hint: "Deploy to Fly.io (needs FLY_API_TOKEN)." },
  { value: "github", label: "Git repo — self-host", hint: "Push a repo to deploy on Coolify / Dokploy." },
  { value: "cloudflare", label: "Cloudflare Workers", hint: "Deploy as a Worker (needs CLOUDFLARE_API_TOKEN)." },
];

const STEPS = ["Project", "Model", "Target", "Deploy"] as const;

interface Props {
  connected: boolean;
  deployStatus: string | null;
  deployError: string | null;
  deployArtifact: { url: string; message: string } | null;
  deployLog: string[];
  onDeploy: (req: { sourceDir: string; provider?: string; model?: string; target: DeployTarget }) => void;
  onClose: () => void;
}

export function DeployWizard({
  connected,
  deployStatus,
  deployError,
  deployArtifact,
  deployLog,
  onDeploy,
  onClose,
}: Props): React.JSX.Element {
  const [step, setStep] = useState(0); // 0..3
  const [sourceDir, setSourceDir] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [customModel, setCustomModel] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  // Keep the live log scrolled to the newest line.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [deployLog]);

  function changeProvider(p: string): void {
    setProvider(p);
    const models = p ? modelsFor(p) : [];
    // Providers with no curated models (e.g. OpenCode Go) start in Custom mode.
    setCustomModel(p !== "" && models.length === 0);
    setModel(models[0] ?? "");
  }

  function changeModel(value: string): void {
    if (value === CUSTOM) {
      setCustomModel(true);
      setModel("");
    } else {
      setCustomModel(false);
      setModel(value);
    }
  }
  const [target, setTarget] = useState<DeployTarget>("docker-local");
  const [dragActive, setDragActive] = useState(false);
  const [started, setStarted] = useState(false);

  // Folder drag-and-drop (desktop shell only).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onDirectoryDrop({ onHover: setDragActive, onDrop: setSourceDir }).then((fn) => {
      if (cancelled) fn?.();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function browse(): Promise<void> {
    const dir = await pickDirectory();
    if (dir) setSourceDir(dir);
  }

  function deploy(): void {
    if (!sourceDir.trim()) return;
    setStarted(true);
    onDeploy({
      sourceDir: sourceDir.trim(),
      provider: provider || undefined,
      model: model.trim() || undefined,
      target,
    });
  }

  // Result of an in-flight deploy (step 4, after the user hit Deploy).
  const succeeded = started && !deployError && !deployArtifact && deployStatus === null;
  const finished = !!deployError || !!deployArtifact || succeeded;
  const activeTarget = DEPLOY_TARGETS.find((t) => t.value === target);

  const footer = started ? (
    <button className="btn-primary" onClick={onClose} disabled={!finished}>
      {finished ? "Done" : "Deploying…"}
    </button>
  ) : (
    <>
      <button className="btn-ghost" onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>
        {step === 0 ? "Cancel" : "Back"}
      </button>
      {step < STEPS.length - 1 ? (
        <button className="btn-primary" onClick={() => setStep(step + 1)} disabled={step === 0 && !sourceDir.trim()}>
          Next
        </button>
      ) : (
        <button className="btn-primary" onClick={deploy} disabled={!connected || !sourceDir.trim()}>
          Deploy
        </button>
      )}
    </>
  );

  return (
    <Modal title="Deploy a Claude Code agent" onClose={onClose} footer={footer} dismissable={false}>
      <ol className="wizard-steps">
        {STEPS.map((label, i) => (
          <li key={label} className={`wizard-step${i === step ? " active" : ""}${i < step ? " done" : ""}`}>
            <span className="wizard-step-num">{i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      <div className="wizard-body">
        {/* Step 1 — Project folder */}
        {step === 0 && !started && (
          <div className={`folder-drop${dragActive ? " drag-active" : ""}`}>
            <button className="folder-btn" onClick={browse}>
              <span className="folder-icon">📁</span>
              {sourceDir ? "Change folder" : "Choose project folder"}
            </button>
            {sourceDir && (
              <code className="folder-path" title={sourceDir}>
                {sourceDir}
              </code>
            )}
            <div className="folder-hint">
              {isTauri() ? "…or drag a project folder here" : "Folder selection works in the desktop app."}
            </div>
          </div>
        )}

        {/* Step 2 — Provider & model */}
        {step === 1 && !started && (
          <div className="wizard-field">
            <label>Provider</label>
            <select value={provider} onChange={(e) => changeProvider(e.target.value)}>
              <option value="">Keep source model (no change)</option>
              {PROVIDER_CATALOG.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>

            {provider && (
              <>
                <label>Model</label>
                <select value={customModel ? CUSTOM : model} onChange={(e) => changeModel(e.target.value)}>
                  {modelsFor(provider).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value={CUSTOM}>Custom…</option>
                </select>
                {customModel && (
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="model id (e.g. gpt-5.5)"
                    autoFocus
                  />
                )}
              </>
            )}

            <div className="folder-hint">
              {provider
                ? "The converted agent will use this provider + model."
                : "Leave as “keep source” to use the project’s original model."}
            </div>
          </div>
        )}

        {/* Step 3 — Target */}
        {step === 2 && !started && (
          <div className="target-cards">
            {DEPLOY_TARGETS.map((t) => (
              <button
                key={t.value}
                className={`target-card${target === t.value ? " selected" : ""}`}
                onClick={() => setTarget(t.value)}
              >
                <span className="target-card-label">{t.label}</span>
                <span className="target-card-hint">{t.hint}</span>
              </button>
            ))}
          </div>
        )}

        {/* Step 4 — Review & Deploy / progress / result */}
        {step === 3 && !started && (
          <div className="wizard-review">
            <div className="review-row">
              <span>Project</span>
              <code title={sourceDir}>{sourceDir || "—"}</code>
            </div>
            <div className="review-row">
              <span>Model</span>
              <code>{provider ? `${provider}/${model || "(default)"}` : "keep source"}</code>
            </div>
            <div className="review-row">
              <span>Target</span>
              <code>{activeTarget?.label}</code>
            </div>
            {!connected && <div className="deploy-error">Not connected to the Core.</div>}
          </div>
        )}

        {started && (
          <div className="wizard-result">
            {deployError ? (
              <div className="deploy-error">{deployError}</div>
            ) : deployArtifact ? (
              <div className="deploy-artifact">
                <div className="result-ok">✓ Repository published</div>
                <a href={deployArtifact.url} target="_blank" rel="noreferrer">
                  {deployArtifact.url}
                </a>
                <span>{deployArtifact.message}</span>
              </div>
            ) : succeeded ? (
              <div className="result-ok">✓ Agent deployed and connected.</div>
            ) : (
              <div className="deploy-running">
                <span className="spinner" /> {deployStatus ?? "starting"}…
              </div>
            )}
            {deployLog.length > 0 && (
              <pre className="deploy-log" ref={logRef}>
                {deployLog.join("\n")}
              </pre>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
