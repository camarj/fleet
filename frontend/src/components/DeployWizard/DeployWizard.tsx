/**
 * DeployWizard — a step-by-step modal to deploy a Claude Code project as a Flue
 * agent: Project → Model → Target → Review & Deploy. Replaces the old all-at-once
 * sidebar form. Folder selection (button + drag) only yields a real path in the
 * Tauri desktop shell.
 */

import { useEffect, useRef, useState } from "react";
import type { DeployTarget, PreflightCheck } from "../../lib/api";
import { Modal } from "../Modal/Modal";
import { isTauri, onDirectoryDrop, pickDirectory } from "../../lib/dialog";
import { ModelPicker } from "../ModelPicker/ModelPicker";

const DEPLOY_TARGETS: { value: DeployTarget; label: string; hint: string }[] = [
  { value: "docker-local", label: "Docker — local", hint: "Run a container on this machine." },
  { value: "fly", label: "Docker — Fly.io", hint: "Deploy to Fly.io (needs FLY_API_TOKEN)." },
  { value: "github", label: "Git repo — self-host", hint: "Push a repo to deploy on Coolify / other self-hosted PaaS." },
  { value: "cloudflare", label: "Cloudflare Workers", hint: "Deploy as a Worker (needs CLOUDFLARE_API_TOKEN)." },
  { value: "dokploy", label: "Dokploy — self-host", hint: "Auto-deploy to your Dokploy instance (needs DOKPLOY_URL + DOKPLOY_API_KEY)." },
];

const STEPS = ["Project", "Model", "Target", "Deploy"] as const;

interface Props {
  connected: boolean;
  deployStatus: string | null;
  deployError: string | null;
  deployArtifact: { url: string; message: string } | null;
  deployLog: string[];
  /** Source features that did NOT convert to Flue, reported after conversion. */
  deployUnmapped: { kind: string; name: string; reason: string }[];
  /** Preflight check results (null = loading / not yet run). */
  preflightChecks: PreflightCheck[] | null;
  /** GitHub owners available to push repos to. null = not yet fetched; [] = gh unavailable. */
  githubOwners: string[] | null;
  onPreflight: (params: { provider?: string; model?: string; target: DeployTarget }) => void;
  onRequestGithubOwners: () => void;
  onDeploy: (req: { sourceDir: string; provider?: string; model?: string; target: DeployTarget; repoOwner?: string }) => void;
  onClose: () => void;
}

export function DeployWizard({
  connected,
  deployStatus,
  deployError,
  deployArtifact,
  deployLog,
  deployUnmapped,
  preflightChecks,
  githubOwners,
  onPreflight,
  onRequestGithubOwners,
  onDeploy,
  onClose,
}: Props): React.JSX.Element {
  const [step, setStep] = useState(0); // 0..3
  const [sourceDir, setSourceDir] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  /** The GitHub owner (account or org) the user picked for the pushed repo. */
  const [repoOwner, setRepoOwner] = useState<string | undefined>(undefined);

  // Keep the live log scrolled to the newest line.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [deployLog]);

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

  // Trigger preflight whenever the user enters the Review/Deploy step (step 3).
  useEffect(() => {
    if (step === 3 && !started) {
      onPreflight({ provider: provider || undefined, model: model.trim() || undefined, target });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, started]);

  // Fetch the GitHub owner list the first time github/dokploy is selected.
  useEffect(() => {
    if ((target === "github" || target === "dokploy") && githubOwners === null) {
      onRequestGithubOwners();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  async function browse(): Promise<void> {
    const dir = await pickDirectory();
    if (dir) setSourceDir(dir);
  }

  function runPreflight(): void {
    onPreflight({ provider: provider || undefined, model: model.trim() || undefined, target });
  }

  function deploy(): void {
    if (!sourceDir.trim()) return;
    setStarted(true);
    // When the target uses a pushed repo, include the chosen owner (falls back to
    // the first in the list if the user never touched the select).
    const effectiveOwner = repoOwner ?? (githubOwners?.[0]);
    onDeploy({
      sourceDir: sourceDir.trim(),
      provider: provider || undefined,
      model: model.trim() || undefined,
      target,
      repoOwner: (target === "github" || target === "dokploy") ? effectiveOwner : undefined,
    });
  }

  // Result of an in-flight deploy (step 4, after the user hit Deploy).
  const succeeded = started && !deployError && !deployArtifact && deployStatus === null;
  const finished = !!deployError || !!deployArtifact || succeeded;
  const activeTarget = DEPLOY_TARGETS.find((t) => t.value === target);

  // The Deploy button stays blocked until preflight results arrive and all pass.
  const preflightPending = preflightChecks === null;
  const anyPreflightFailed = preflightChecks !== null && preflightChecks.some((c) => !c.ok);

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
        <button
          className="btn-primary"
          onClick={deploy}
          disabled={!connected || !sourceDir.trim() || preflightPending || anyPreflightFailed}
        >
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
            <ModelPicker
              initialProvider={provider}
              initialModel={model}
              onChange={({ provider: p, model: m }) => {
                setProvider(p);
                setModel(m);
              }}
            />
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
                aria-pressed={target === t.value}
                onClick={() => setTarget(t.value)}
              >
                <span className="target-card-label">{t.label}</span>
                <span className="target-card-hint">{t.hint}</span>
              </button>
            ))}

            {/* Owner picker — only for targets that push a repo to GitHub */}
            {(target === "github" || target === "dokploy") && (
              <div className="wizard-field">
                <label htmlFor="repo-owner-select" className="wizard-field-label">
                  Push repo to
                </label>
                <select
                  id="repo-owner-select"
                  className="wizard-select"
                  value={repoOwner ?? githubOwners?.[0] ?? ""}
                  onChange={(e) => setRepoOwner(e.target.value || undefined)}
                  disabled={!githubOwners || githubOwners.length === 0}
                >
                  {!githubOwners || githubOwners.length === 0 ? (
                    <option value="">(default account)</option>
                  ) : (
                    githubOwners.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))
                  )}
                </select>
                {!githubOwners && (
                  <span className="wizard-field-hint">Loading owners…</span>
                )}
              </div>
            )}
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
            {(target === "github" || target === "dokploy") && (
              <div className="review-row">
                <span>Push to</span>
                <code>{repoOwner ?? githubOwners?.[0] ?? "(default account)"}</code>
              </div>
            )}

            {/* Preflight checklist */}
            <div className="preflight-section">
              <div className="preflight-header">
                <span className="preflight-title">Pre-deploy checks</span>
                <button className="btn-ghost preflight-recheck" onClick={runPreflight}>
                  Re-check
                </button>
              </div>
              {preflightChecks === null ? (
                <div className="preflight-loading">
                  <span className="spinner" /> Checking…
                </div>
              ) : (
                <ul className="preflight-checks">
                  {preflightChecks.map((c) => (
                    <li key={c.id} className={`preflight-check ${c.ok ? "ok" : "fail"}`}>
                      <span className="preflight-check-icon">{c.ok ? "✓" : "✗"}</span>
                      <span className="preflight-check-body">
                        <span className="preflight-check-label">{c.label}</span>
                        {c.detail && <span className="preflight-check-detail">{c.detail}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {anyPreflightFailed && (
                <div className="deploy-error preflight-block">
                  Fix the failing checks above before deploying.
                </div>
              )}
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
        )}
      </div>
    </Modal>
  );
}
