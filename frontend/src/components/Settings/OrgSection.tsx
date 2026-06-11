/**
 * OrgSection — Organization Registry section rendered inside Settings.
 *
 * Unbound: offers Create (repo + name) and Join (repo) org actions.
 * Bound: shows org info, member list, Sync / Leave controls, and per-agent
 * share toggles for locally owned agents.
 *
 * Share-toggle state for the owner's own agents is tracked locally /
 * optimistically. It is NOT persisted across Settings modal opens (G1
 * limitation — the backend does not yet return owned shares in sharedAgentIds;
 * sharedAgentIds is received-only from the directory and skips same-id
 * collisions via the C1 reconcile guard).
 */
import { useState, useRef, useEffect } from "react";
import type { AgentSummary, OrgMember, OrgStatus } from "../../lib/api";

/** Non-routable deploy targets that cannot be shared in the org registry (ORG-06). */
const NON_ROUTABLE: ReadonlySet<string | null> = new Set([
  "docker-local",
  "local-process",
  null,
]);

interface Props {
  connected: boolean;
  /** null = initial state (org.status response not yet received). */
  orgStatus: OrgStatus | null;
  /** null = org.members response not yet received; [] = loaded but empty. */
  orgMembers: OrgMember[] | null;
  orgError: { message: string; requestType?: string } | null;
  /** All agents in the fleet — filtered internally to origin:"local" for the share list. */
  agents: AgentSummary[];
  onCreateOrg: (repo: string, name: string) => void;
  onJoinOrg: (repo: string) => void;
  onLeaveOrg: () => void;
  onSyncOrg: () => void;
  onRequestMembers: () => void;
  onShareAgent: (agentId: string) => void;
  onUnshareAgent: (agentId: string) => void;
}

export function OrgSection({
  connected,
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
  const [createRepo, setCreateRepo] = useState("");
  const [createName, setCreateName] = useState("");
  const [joinRepo, setJoinRepo] = useState("");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [membersExpanded, setMembersExpanded] = useState(false);
  /**
   * Optimistic share state for the owner's own agents.
   * Tracks which local agent ids the user has toggled to "shared" in this
   * Settings session. Resets when the Settings modal closes (G1 limitation).
   */
  const [sharedByMe, setSharedByMe] = useState<Set<string>>(new Set());

  /**
   * Tracks the in-flight share/unshare op so we can roll back on org.error.
   * Only one op can be pending at a time (share toggle is disabled while org
   * is not connected).
   */
  const pendingShareRef = useRef<{ agentId: string; action: "share" | "unshare" } | null>(null);

  // W2: Roll back the optimistic share toggle when the server rejects it.
  useEffect(() => {
    if (!orgError) return;
    const pending = pendingShareRef.current;
    if (!pending) return;
    if (orgError.requestType !== "org.share" && orgError.requestType !== "org.unshare") return;
    if (pending.action === "share") {
      // Failed share — remove the agent from the shared set.
      setSharedByMe((prev) => {
        const next = new Set(prev);
        next.delete(pending.agentId);
        return next;
      });
    } else {
      // Failed unshare — re-add the agent to the shared set.
      setSharedByMe((prev) => new Set([...prev, pending.agentId]));
    }
    pendingShareRef.current = null;
  }, [orgError]);

  // W2 (success path): clear the pending op whenever the server confirms an
  // org.status or org.synced event (orgStatus prop changes on both).
  useEffect(() => {
    pendingShareRef.current = null;
  }, [orgStatus]);

  // W5: Reset share state (and any pending op) when the org becomes unbound.
  useEffect(() => {
    if (!orgStatus?.bound) {
      setSharedByMe(new Set());
      pendingShareRef.current = null;
    }
  }, [orgStatus?.bound]);

  const localAgents = agents.filter((a) => a.origin === "local");

  function handleCreate(): void {
    if (!createRepo.trim() || !createName.trim()) return;
    onCreateOrg(createRepo.trim(), createName.trim());
    setCreateRepo("");
    setCreateName("");
  }

  function handleJoin(): void {
    if (!joinRepo.trim()) return;
    onJoinOrg(joinRepo.trim());
    setJoinRepo("");
  }

  function handleToggleShare(agentId: string): void {
    if (sharedByMe.has(agentId)) {
      pendingShareRef.current = { agentId, action: "unshare" };
      onUnshareAgent(agentId);
      setSharedByMe((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    } else {
      pendingShareRef.current = { agentId, action: "share" };
      onShareAgent(agentId);
      setSharedByMe((prev) => new Set([...prev, agentId]));
    }
  }

  function handleToggleMembers(): void {
    // Only request on the first expand (guard: null = not yet loaded).
    if (!membersExpanded && orgMembers === null) onRequestMembers();
    setMembersExpanded((v) => !v);
  }

  // Loading state — org.status not yet received from the Core.
  if (orgStatus === null) {
    return <p className="settings-note">Loading organization status…</p>;
  }

  // ── Unbound state ──────────────────────────────────────────────────────────
  if (!orgStatus.bound) {
    return (
      <>
        <p className="settings-note">
          Connect your Fleet instance to a shared agent registry backed by a
          private GitHub repository. Requires{" "}
          <code>gh</code> CLI authenticated (<code>gh auth login</code>).
        </p>

        {orgError && (
          <div className="org-error" role="alert">
            {orgError.message}
          </div>
        )}

        <p className="settings-group-label">Create an organization</p>
        <div className="wizard-field">
          <label>Registry repo (owner/name)</label>
          <input
            type="text"
            value={createRepo}
            onChange={(e) => setCreateRepo(e.target.value)}
            placeholder="myorg/fleet-registry"
          />
        </div>
        <div className="wizard-field">
          <label>Organization name</label>
          <div className="row">
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="My Team"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
            <button
              className="btn-primary"
              onClick={handleCreate}
              disabled={!connected || !createRepo.trim() || !createName.trim()}
            >
              Create
            </button>
          </div>
        </div>

        <p className="settings-group-label">Join an organization</p>
        <div className="wizard-field">
          <label>Registry repo (owner/name)</label>
          <div className="row">
            <input
              type="text"
              value={joinRepo}
              onChange={(e) => setJoinRepo(e.target.value)}
              placeholder="myorg/fleet-registry"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleJoin();
              }}
            />
            <button
              className="btn-primary"
              onClick={handleJoin}
              disabled={!connected || !joinRepo.trim()}
            >
              Join
            </button>
          </div>
        </div>
      </>
    );
  }

  // ── Bound state ────────────────────────────────────────────────────────────
  return (
    <>
      <div className="org-info-row">
        <span className="org-name">{orgStatus.orgName}</span>
        <span className={`badge${orgStatus.role === "owner" ? " org-owner" : ""}`}>
          {orgStatus.role ?? "member"}
        </span>
      </div>
      <p className="settings-note">
        Registry: <code>{orgStatus.repo}</code>
        {orgStatus.myLogin && (
          <>
            {" · "}Signed in as <strong>{orgStatus.myLogin}</strong>
          </>
        )}
        {orgStatus.lastSyncedAt && (
          <> · Last synced: {new Date(orgStatus.lastSyncedAt).toLocaleString()}</>
        )}
      </p>

      {orgError && (
        <div className="org-error" role="alert">
          {orgError.message}
        </div>
      )}

      <div className="org-actions-row">
        <button className="btn-ghost" onClick={onSyncOrg} disabled={!connected}>
          ↺ Sync now
        </button>
        {confirmLeave ? (
          <div className="org-leave-confirm">
            <span>Remove all org agents and their conversation history, and leave this organization? This cannot be undone.</span>
            <button className="btn-ghost" onClick={() => setConfirmLeave(false)}>
              Cancel
            </button>
            <button
              className="btn-danger"
              onClick={() => {
                setConfirmLeave(false);
                onLeaveOrg();
              }}
            >
              Leave
            </button>
          </div>
        ) : (
          <button
            className="btn-ghost org-leave-btn"
            onClick={() => setConfirmLeave(true)}
            disabled={!connected}
          >
            Leave org
          </button>
        )}
      </div>

      {/* ── Members ─────────────────────────────────────────────────────────── */}
      <button
        className="btn-ghost org-members-toggle"
        onClick={handleToggleMembers}
        disabled={!connected}
        aria-expanded={membersExpanded}
      >
        {membersExpanded ? "▾" : "▸"} Members
        {orgMembers !== null && orgMembers.length > 0 && ` (${orgMembers.length})`}
      </button>
      {membersExpanded && orgMembers !== null && orgMembers.length > 0 && (
        <ul className="org-members-list">
          {orgMembers.map((m) => (
            <li key={m.login} className="org-member-item">
              <span>{m.login}</span>
              <span className="badge">{m.role}</span>
            </li>
          ))}
        </ul>
      )}
      {membersExpanded && orgMembers === null && (
        <p className="settings-note">Loading members…</p>
      )}
      {membersExpanded && orgMembers !== null && orgMembers.length === 0 && (
        <p className="settings-note">No members found.</p>
      )}

      {/* ── Share agents ─────────────────────────────────────────────────────── */}
      {localAgents.length > 0 && (
        <>
          <p className="settings-group-label">Share your agents</p>
          <p className="settings-note">
            Share remote-deployed agents with org members. Local targets
            (docker-local, local-process) cannot be shared — they are not
            reachable from outside your machine.
          </p>
          <ul className="org-share-list">
            {localAgents.map((a) => {
              const nonRoutable = NON_ROUTABLE.has(a.target);
              const isShared = sharedByMe.has(a.id);
              return (
                <li key={a.id} className="org-share-item">
                  <div className="org-share-info">
                    <span className="org-share-name">{a.name}</span>
                    {a.target && (
                      <span className={`agent-target ${a.target}`}>{a.target}</span>
                    )}
                  </div>
                  <button
                    className={`btn-ghost org-share-btn${isShared ? " active" : ""}`}
                    onClick={() => handleToggleShare(a.id)}
                    disabled={!connected || nonRoutable}
                    title={
                      nonRoutable
                        ? `Cannot share — ${a.target ?? "local"} agents are not reachable from outside your machine`
                        : isShared
                          ? "Unshare this agent from the org registry"
                          : "Share this agent with org members"
                    }
                    aria-label={
                      nonRoutable
                        ? `Cannot share ${a.name} — non-routable target`
                        : isShared
                          ? `Unshare ${a.name}`
                          : `Share ${a.name}`
                    }
                  >
                    {isShared ? "Unshare" : "Share"}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
