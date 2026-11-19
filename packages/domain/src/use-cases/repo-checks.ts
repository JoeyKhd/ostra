import { secretRefSchema } from "@ostra/adapter-sdk";
import type { BranchRules, CodeHostAppCredentials } from "@ostra/adapter-sdk";
import type { DbOrTx } from "@ostra/db";
import { connectionIdSchema, repoFullNameSchema, repoIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, ProjectId, RepoId } from "@ostra/protocol";

import type { Ports } from "../ports.ts";
import { BRANCH_RULES_CACHE_MS, repoBranchRulesSchema } from "../tickets/contracts.ts";
import type { BranchRuleCheck, RepoBranchRules } from "../tickets/contracts.ts";
import { installationStateSelect, installationUsable } from "../code-host/installations.ts";

// F-055, F-060, ticket 31: the two checks on a repo's default branch. They are read through the
// code host adapter when a repo is added, at a project page load (reused for 10 minutes), when a
// task starts, and when a project admin presses "Check again". The answer is kept on the `Repo`
// row (`branchRules`, `branchRulesCheckedAt`, `private`), so a use case that runs in a transaction
// reads it without a remote call. `unknown` is never an error: it warns and never refuses.

export type RepoChecked = {
  readonly repoId: RepoId;
  readonly fullName: string;
  readonly defaultBranch: string;
  /** `null` until the code host has said. */
  readonly private: boolean | null;
  /** Epoch ms of the read the rules are from, or `null` when they were never read. */
  readonly checkedAt: number | null;
  readonly rules: RepoBranchRules;
};

export type CheckRepoRulesDeps = Pick<Ports, "clock"> & {
  readonly db: DbOrTx;
  readonly adapters: Pick<Ports["adapters"], "codeHost" | "secretStore">;
};

export type CheckRepoRulesInput = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  /** Read again even within the cache window ("Check again", and a task's start). */
  readonly force: boolean;
};

const notChecked: RepoBranchRules = {
  protected: { result: "unknown", reason: "Not checked yet." },
  signedCommits: { result: "unknown", reason: "Not checked yet." },
};

/** What a stored `Repo.branchRules` holds, or the "not checked" answer. */
export const storedRepoRules = (value: unknown): RepoBranchRules => {
  const parsed = repoBranchRulesSchema.safeParse(value);
  return parsed.success ? parsed.data : notChecked;
};

const unknownRules = (reason: string): RepoBranchRules => ({
  protected: { result: "unknown", reason },
  signedCommits: { result: "unknown", reason },
});

/** The adapter's answer as the stored shape: a reason sits beside each check that isn't a plain yes. */
const rulesFromHost = (rules: BranchRules): RepoBranchRules => {
  const reason = rules.reasons.length === 0 ? undefined : rules.reasons.join(" ").slice(0, 500);
  const check = (result: boolean | "unknown"): BranchRuleCheck => (result === true || reason === undefined ? { result } : { result, reason });
  return { protected: check(rules.protected), signedCommits: check(rules.requiresSignedCommits) };
};

const credentialsOf = async (
  deps: CheckRepoRulesDeps,
  organizationId: OrganizationId,
  connectionId: ConnectionId,
): Promise<CodeHostAppCredentials | null> => {
  const connection = await deps.db.connection.findFirst({ where: { id: connectionId, organizationId, kind: "github" } });
  const ref = secretRefSchema.safeParse(connection?.privateKeySecretRef);
  if (connection === null || !ref.success) {
    return null;
  }
  const key = await deps.adapters.secretStore.get(organizationId, ref.data);
  return key.ok ? { appId: connection.appId, privateKey: key.value } : null;
};

/**
 * Reads (or reuses) the two checks of every repo of a project, and keeps them on the repo rows.
 * Never throws for the code host: a host that can't answer gives `unknown` with a reason.
 */
export const checkProjectRepos = async (deps: CheckRepoRulesDeps, input: CheckRepoRulesInput): Promise<readonly RepoChecked[]> => {
  const { organizationId, projectId } = input;
  const now = deps.clock.now();
  const rows = await deps.db.repo.findMany({ where: { organizationId, projectId }, include: { ...installationStateSelect }, orderBy: { createdAt: "asc" } });
  const checked: RepoChecked[] = [];
  // One `listRepos` per installation answers `private` for all of its repos.
  const listed = new Map<string, ReadonlyMap<string, boolean>>();

  for (const row of rows) {
    const repoId = repoIdSchema.parse(row.id);
    const fresh = row.branchRulesCheckedAt !== null && now - row.branchRulesCheckedAt.getTime() < BRANCH_RULES_CACHE_MS;
    if (!input.force && fresh) {
      checked.push({
        repoId,
        fullName: row.fullName,
        defaultBranch: row.defaultBranch,
        private: row.private,
        checkedAt: row.branchRulesCheckedAt?.getTime() ?? null,
        rules: storedRepoRules(row.branchRules),
      });
      continue;
    }

    // Milestone 4 (F-136, ADR 0065): nothing is minted through an installation that isn't linked.
    if (!installationUsable(row.installation)) {
      checked.push({
        repoId,
        fullName: row.fullName,
        defaultBranch: row.defaultBranch,
        private: row.private,
        checkedAt: row.branchRulesCheckedAt?.getTime() ?? null,
        rules: unknownRules("The repo's GitHub installation isn't linked, so the branch could not be checked."),
      });
      continue;
    }
    const app = await credentialsOf(deps, organizationId, connectionIdSchema.parse(row.connectionId));
    if (app === null) {
      checked.push({
        repoId,
        fullName: row.fullName,
        defaultBranch: row.defaultBranch,
        private: row.private,
        checkedAt: row.branchRulesCheckedAt?.getTime() ?? null,
        rules: unknownRules("GitHub is not connected, so the branch could not be checked."),
      });
      continue;
    }

    let isPrivate = row.private;
    if (!listed.has(row.installationId)) {
      const repos = await deps.adapters.codeHost.listRepos(app, row.installationId);
      listed.set(row.installationId, repos.ok ? new Map(repos.value.map((repo) => [repo.hostRepoId, repo.private] as const)) : new Map());
    }
    const privateNow = listed.get(row.installationId)?.get(row.hostRepoId);
    if (privateNow !== undefined) {
      isPrivate = privateNow;
    }

    const answer = await deps.adapters.codeHost.readBranchRules(
      { app, installationId: row.installationId, repo: repoFullNameSchema.parse(row.fullName) },
      row.defaultBranch,
    );
    let rules: RepoBranchRules;
    let keep = true;
    if (answer.ok) {
      rules = rulesFromHost(answer.value);
    } else if (answer.error.code === "unsupported") {
      rules = unknownRules("This code host can't say whether the branch is protected.");
    } else {
      // A host that didn't answer is tried again at the next load: nothing is cached for it.
      rules = unknownRules("The code host did not answer, so the branch could not be checked.");
      keep = false;
    }
    if (keep) {
      await deps.db.repo.update({ where: { id: row.id }, data: { branchRules: rules, branchRulesCheckedAt: new Date(now), private: isPrivate } });
    } else if (isPrivate !== row.private) {
      await deps.db.repo.update({ where: { id: row.id }, data: { private: isPrivate } });
    }
    checked.push({
      repoId,
      fullName: row.fullName,
      defaultBranch: row.defaultBranch,
      private: isPrivate,
      checkedAt: keep ? now : (row.branchRulesCheckedAt?.getTime() ?? null),
      rules,
    });
  }
  return checked;
};

/** The repos of a project whose stored rules say a default branch requires signed commits (F-055). */
export const unsupportedRepos = async (db: DbOrTx, organizationId: OrganizationId, projectId: ProjectId): Promise<readonly string[]> => {
  const rows = await db.repo.findMany({ where: { organizationId, projectId }, select: { fullName: true, branchRules: true } });
  return rows.filter((row) => storedRepoRules(row.branchRules).signedCommits.result === true).map((row) => row.fullName);
};

/** The refusal's words (F-055): ostra doesn't support a repo that requires signed commits yet. */
export const signedCommitRefusal = (fullNames: readonly string[]): string =>
  `ostra doesn't support repos that require signed commits yet (${fullNames.join(", ")}): its commits aren't signed. Turn the rule off for the default branch, or use another repo.`;
