/**
 * org/ module barrel.
 *
 * PR1a-i exports: interface types + OrgStore.
 * PR1a-ii will add: GitHubRegistry (the gh-backed OrgRegistry implementation).
 * PR1b will add: OrgManager (state machine + reconcile).
 */

export * from "./registry.js";
export * from "./org-store.js";
