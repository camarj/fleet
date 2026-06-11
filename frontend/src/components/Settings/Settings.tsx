/**
 * Settings — provider API keys and infrastructure credentials, stored
 * server-side in the Core's secure store. Values are never persisted in the
 * frontend; only the set ids come back (shown with a ✓).
 */

import { useEffect, useState } from "react";
import { Modal } from "../Modal/Modal";
import { PROVIDER_IDS } from "../../lib/providers";
import type { AgentSummary, OrgMember, UsageAgentSummary, UsageTotals } from "../../lib/api";
import { OrgSection } from "./OrgSection";
import type { OrgStatus } from "./OrgSection";

const PROVIDERS = PROVIDER_IDS;

/** A usage.summary response held in App state and rendered by the Usage section. */
export interface UsageSummaryData {
  since: string | null;
  rows: UsageAgentSummary[];
  totals: UsageTotals;
}

type UsagePeriod = "today" | "7d" | "all";

/** Inclusive ISO lower bound for a period, or null for all time. */
function periodSince(period: UsagePeriod): string | null {
  if (period === "all") return null;
  if (period === "7d") return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
}

function formatCost(costUsd: number | null, unpricedRuns: number): string {
  if (costUsd === null) return "—";
  const cost = `$${costUsd.toFixed(4)}`;
  return unpricedRuns > 0 ? `${cost}*` : cost;
}

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
  usage: UsageSummaryData | null;
  onRequestUsage: (since: string | null) => void;
  onSetSecret: (provider: string, apiKey: string) => void;
  onClose: () => void;
  // ── Org registry (G1) ──
  orgStatus: OrgStatus | null;
  orgMembers: OrgMember[];
  orgError: { message: string; requestType?: string } | null;
  agents: AgentSummary[];
  onCreateOrg: (repo: string, name: string) => void;
  onJoinOrg: (repo: string) => void;
  onLeaveOrg: () => void;
  onSyncOrg: () => void;
  onRequestMembers: () => void;
  onShareAgent: (agentId: string) => void;
  onUnshareAgent: (agentId: string) => void;
}

export function Settings({
  connected,
  secretsProviders,
  usage,
  onRequestUsage,
  onSetSecret,
  onClose,
  orgStatus,
  orgMembers,
  orgError,
  agents,
  onCreateOrg,
  onJoinOrg,
  onLeaveOrg,
  onSyncOrg,
  onRequestMembers,
  onShareAgent,
  onUnshareAgent,
}: Props): React.JSX.Element {
  const [keyProvider, setKeyProvider] = useState<string>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [infraValues, setInfraValues] = useState<Record<string, string>>({});
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriod>("7d");

  // Fetch on open and whenever the period changes.
  useEffect(() => {
    if (connected) onRequestUsage(periodSince(usagePeriod));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onRequestUsage is a stable closure over the client
  }, [connected, usagePeriod]);

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
    <Modal title="Settings" onClose={onClose} footer={<button className="btn-primary" onClick={onClose}>Done</button>}>
      <p className="settings-note">
        Keys are stored server-side in the Core and used when deploying agents. They are never saved in the app.
      </p>

      {/* ── Usage ─────────────────────────────────────────────── */}
      <h3 className="settings-section-title">Usage</h3>
      <div className="usage-toolbar">
        <select value={usagePeriod} onChange={(e) => setUsagePeriod(e.target.value as UsagePeriod)} aria-label="Usage period">
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="all">All time</option>
        </select>
        {usage && (
          <span className="usage-totals">
            {formatTokens(usage.totals.totalTokens)} tok · {formatCost(usage.totals.costUsd, usage.totals.unpricedRuns)} ·{" "}
            {usage.totals.runs} run{usage.totals.runs === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {usage && usage.rows.length > 0 ? (
        <>
          <table className="usage-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Model</th>
                <th className="num">In</th>
                <th className="num">Out</th>
                <th className="num">Cost</th>
                <th className="num">Runs</th>
              </tr>
            </thead>
            <tbody>
              {usage.rows.map((r) => (
                <tr key={`${r.agentId}/${r.model}`}>
                  <td>{r.agentName}</td>
                  <td>{r.model}</td>
                  <td className="num">{formatTokens(r.inputTokens)}</td>
                  <td className="num">{formatTokens(r.outputTokens)}</td>
                  <td className="num">{formatCost(r.costUsd, r.unpricedRuns)}</td>
                  <td className="num">{r.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {usage.totals.unpricedRuns > 0 && (
            <p className="settings-note">
              * {usage.totals.unpricedRuns} run{usage.totals.unpricedRuns === 1 ? "" : "s"} with no price for the model —
              not included in the cost.
            </p>
          )}
        </>
      ) : (
        <p className="settings-note">{usage ? "No usage recorded in this period." : "Loading usage…"}</p>
      )}

      {/* ── Provider keys ─────────────────────────────────────── */}
      <h3 className="settings-section-title">API keys</h3>
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

      {/* ── Organization ──────────────────────────────────────── */}
      <h3 className="settings-section-title">Organization</h3>
      <OrgSection
        connected={connected}
        orgStatus={orgStatus}
        orgMembers={orgMembers}
        orgError={orgError}
        agents={agents}
        onCreateOrg={onCreateOrg}
        onJoinOrg={onJoinOrg}
        onLeaveOrg={onLeaveOrg}
        onSyncOrg={onSyncOrg}
        onRequestMembers={onRequestMembers}
        onShareAgent={onShareAgent}
        onUnshareAgent={onUnshareAgent}
      />
    </Modal>
  );
}
