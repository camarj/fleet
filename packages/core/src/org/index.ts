/**
 * org/ module barrel.
 *
 * PR1a-i: interface types + OrgStore.
 * PR1a-ii: GitHubRegistry (the gh-backed OrgRegistry implementation) + GhExecFn seam.
 * PR1b: OrgManager (state machine + reconcile algorithm + share/unshare guards).
 */

export * from "./registry.js";
export * from "./org-store.js";
export * from "./github-registry.js";
export * from "./org-manager.js";
