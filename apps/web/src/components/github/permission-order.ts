// The order the panel lists an App's permissions in (github.md): the manifest's own order first,
// then any other permission A–Z. The manifest's list comes from `@ostra/adapter-github` through
// `github.appRequest` on the page that has no App yet; a connected App's permissions are what
// GitHub reports, so this order is the one place the names are written in the panel.
const manifestOrder = ["contents", "pull_requests", "checks", "actions", "issues", "statuses", "metadata"] as const;

const rank = (name: string): number => {
  const index = manifestOrder.findIndex((known) => known === name);
  return index === -1 ? manifestOrder.length : index;
};

/** `[name, level]` pairs, the manifest's permissions first in its order, then the rest A–Z. */
export const orderPermissions = (permissions: Readonly<Record<string, string>>): readonly (readonly [string, string])[] =>
  Object.entries(permissions).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
