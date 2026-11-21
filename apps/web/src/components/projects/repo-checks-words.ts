import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The two checks ostra runs on a repo's default branch (F-060, F-055; repo-checks.md), read from
// `projects.get`: is it protected, and does it require signed commits. Pure, so it's tested alone.

export type RepoDetail = RouterOutputs["projects"]["get"]["repos"][number];

/** Why a check isn't a plain yes: the host's code or ostra's, which the panel words (F-083). */
export type CheckReason = NonNullable<RepoDetail["defaultBranchProtected"]["reason"]>;

/** A check's reason in words, or the host's silence when it gave none. */
export const checkReasonText = (reason: CheckReason | null | undefined): string => (reason === null || reason === undefined ? t("repos.check.noReason") : t(`repos.reason.${reason}`));

/**
 * A repo's worst result, in this order: its installation isn't linked (F-136), signed commits
 * block, a warning, a check it couldn't make, ready.
 */
export type RepoVerdict = "notLinked" | "unsupported" | "warning" | "unknown" | "ready";

/** Whether the repo's App installation was unlinked or removed: new tasks on it wait (F-136). */
export const installationNotLinked = (repo: RepoDetail): boolean => repo.installation !== null && repo.installation.state !== "linked";

export const repoVerdict = (repo: RepoDetail): RepoVerdict => {
  if (installationNotLinked(repo)) return "notLinked";
  if (repo.signedCommitsRequired.result === true) return "unsupported";
  if (repo.defaultBranchProtected.result === false) return "warning";
  if (repo.defaultBranchProtected.result === "unknown" || repo.signedCommitsRequired.result === "unknown") return "unknown";
  return "ready";
};

const rank: Readonly<Record<RepoVerdict, number>> = { notLinked: 0, unsupported: 1, warning: 2, unknown: 3, ready: 4 };

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

/** A GitHub account's repos, in the project's order (F-136). */
export type RepoGroup = { readonly account: string; readonly kind: "organization" | "user" | null; readonly repos: readonly RepoDetail[] };

/**
 * The repos grouped by the GitHub account they're on, each group where its first repo stands
 * (F-136). One group when they're all on one account: the page then shows no group labels.
 */
export const reposByAccount = (repos: readonly RepoDetail[]): readonly RepoGroup[] => {
  const groups: { account: string; kind: "organization" | "user" | null; repos: RepoDetail[] }[] = [];
  for (const repo of repos) {
    const account = repo.installation?.accountLogin ?? repo.fullName.split("/")[0] ?? "";
    const group = groups.find((each) => each.account.toLowerCase() === account.toLowerCase());
    if (group === undefined) {
      groups.push({ account, kind: repo.installation?.accountKind ?? null, repos: [repo] });
    } else {
      group.repos.push(repo);
    }
  }
  return groups;
};

/** The account the repos live under (`acme` of `acme/calculator-web`). */
export const accountOf = (repos: readonly RepoDetail[]): string | null => repos[0]?.fullName.split("/")[0] ?? null;

/**
 * One check line under a repo. Both unknown for the same reason collapse into one line. An
 * installation that isn't linked comes first, naming its account and how it ended (F-136).
 */
export type CheckLine =
  | { readonly kind: "protected" | "notProtected" | "signedNotRequired" | "signedRequired" }
  | { readonly kind: "protectedUnknown" | "signedUnknown" | "unknown"; readonly reason: CheckReason | null }
  | { readonly kind: "notLinked"; readonly account: string; readonly how: "unlinked" | "removed" };

export const checkLines = (repo: RepoDetail): readonly CheckLine[] => {
  const installation = repo.installation;
  const notLinked: readonly CheckLine[] =
    installation === null || installation.state === "linked" ? [] : [{ kind: "notLinked", account: installation.accountLogin, how: installation.state }];
  return [...notLinked, ...branchLines(repo)];
};

const branchLines = (repo: RepoDetail): readonly CheckLine[] => {
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
