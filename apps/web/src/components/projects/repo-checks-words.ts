import type { RouterOutputs } from "@/lib/trpc";

// The two checks ostra runs on a repo's default branch (F-060, F-055; repo-checks.md), read from
// `projects.get`: is it protected, and does it require signed commits. Pure, so it's tested alone.

export type RepoDetail = RouterOutputs["projects"]["get"]["repos"][number];

/** A repo's worst result, in this order: signed commits block, a warning, a check it couldn't make, ready. */
export type RepoVerdict = "unsupported" | "warning" | "unknown" | "ready";

export const repoVerdict = (repo: RepoDetail): RepoVerdict => {
  if (repo.signedCommitsRequired.result === true) return "unsupported";
  if (repo.defaultBranchProtected.result === false) return "warning";
  if (repo.defaultBranchProtected.result === "unknown" || repo.signedCommitsRequired.result === "unknown") return "unknown";
  return "ready";
};

const rank: Readonly<Record<RepoVerdict, number>> = { unsupported: 0, warning: 1, unknown: 2, ready: 3 };

/** The repo the panel opens on: the URL's, else the first with a problem (worst first), else the first. */
export const selectedRepo = (repos: readonly RepoDetail[], fromUrl: string | null): RepoDetail | undefined =>
  repos.find((repo) => repo.repoId === fromUrl) ??
  [...repos].sort((a, b) => rank[repoVerdict(a)] - rank[repoVerdict(b)])[0];

/** The repos that stop every task in the project: they require signed commits. */
export const unsupportedRepos = (repos: readonly RepoDetail[]): readonly RepoDetail[] => repos.filter((repo) => repoVerdict(repo) === "unsupported");

/** The repos whose default branch isn't protected: tasks still start. */
export const unprotectedRepos = (repos: readonly RepoDetail[]): readonly RepoDetail[] => repos.filter((repo) => repo.defaultBranchProtected.result === false);

/** The oldest read among the repos, for "checked 2 min ago"; null when one was never read. */
export const oldestCheck = (repos: readonly RepoDetail[]): number | null => {
  if (repos.length === 0) return null;
  let oldest = Number.POSITIVE_INFINITY;
  for (const repo of repos) {
    if (repo.checkedAt === null) return null;
    oldest = Math.min(oldest, repo.checkedAt);
  }
  return oldest;
};

/** The account the repos live under (`acme` of `acme/calculator-web`). */
export const accountOf = (repos: readonly RepoDetail[]): string | null => repos[0]?.fullName.split("/")[0] ?? null;

/** One check line under a repo. Both unknown for the same reason collapse into one line. */
export type CheckLine =
  | { readonly kind: "protected" | "notProtected" | "signedNotRequired" | "signedRequired" }
  | { readonly kind: "protectedUnknown" | "signedUnknown" | "unknown"; readonly reason: string | null };

export const checkLines = (repo: RepoDetail): readonly CheckLine[] => {
  const p = repo.defaultBranchProtected;
  const s = repo.signedCommitsRequired;
  if (p.result === "unknown" && s.result === "unknown" && p.reason === s.reason) return [{ kind: "unknown", reason: p.reason ?? null }];
  const protection: CheckLine = p.result === "unknown" ? { kind: "protectedUnknown", reason: p.reason ?? null } : { kind: p.result ? "protected" : "notProtected" };
  const signed: CheckLine = s.result === "unknown" ? { kind: "signedUnknown", reason: s.reason ?? null } : { kind: s.result ? "signedRequired" : "signedNotRequired" };
  return [protection, signed];
};

/** `2 min ago`, `just now`, `3 h ago`. */
export const checkedAge = (at: number, now: number): string => {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)} h ago` : `${String(Math.floor(hours / 24))} d ago`;
};
