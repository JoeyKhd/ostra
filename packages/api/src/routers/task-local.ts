import type { OrganizationId, TaskId } from "@ostra/protocol";

import type { ApiDeps } from "../trpc/context.ts";
import { prStateOf } from "./task-extras.ts";

// F-028, F-103 (ticket 39; ADR 0051, "Taking a task local"): what "Take it local" shows. The
// `ostra checkout` line with the task's key (or ID), the install's address for the login line, and,
// per repo, the plain git commands for a member who would rather not use the CLI. ostra hands out
// branch names and no token: git uses the member's own access.

/** A branch name safe to paste in a shell: as is when it has only common characters, else single-quoted. */
export const shellWord = (value: string): string => (/^[A-Za-z0-9._/@:+-]+$/.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`);

export const loadLocalView = async (
  deps: ApiDeps,
  task: { readonly id: TaskId; readonly organizationId: OrganizationId; readonly ticketKey: string | null; readonly shortKey: string },
  caller: { readonly userId: string },
) => {
  const { db, ports, settings } = deps;
  const [repos, sessions] = await Promise.all([
    db.taskRepo.findMany({
      where: { taskId: task.id, organizationId: task.organizationId },
      orderBy: { createdAt: "asc" },
      select: { branchName: true, baseBranch: true, state: true, headSha: true, prNumber: true, prUrl: true, repo: { select: { fullName: true } } },
    }),
    db.cliSession.count({ where: { userId: caller.userId, revokedAt: null, expiresAt: { gt: new Date(ports.clock.now()) } } }),
  ]);
  // The CLI takes a ticket key, a task ID or a task's URL; a ticket task is named by its key.
  const ref = task.ticketKey ?? task.id;
  const serverUrl = settings.publicUrl.replace(/\/+$/, "");
  return {
    ref,
    /** The one line: `ostra checkout OST-142`. */
    checkoutCommand: `ostra checkout ${shellWord(ref)}`,
    /** The login line for a machine that has never signed in. */
    loginCommand: `ostra login --server ${shellWord(serverUrl)}`,
    /** The panel's address (`OSTRA_PUBLIC_URL`). */
    serverUrl,
    /** The member has a CLI session that still works, so the login hint is not shown. */
    hasCliSession: sessions > 0,
    repos: repos.map((repo) => ({
      fullName: repo.repo.fullName,
      branch: repo.branchName,
      baseBranch: repo.baseBranch,
      /** Whether anything was pushed: with none, there is no branch on the host to fetch yet. */
      pushed: repo.headSha !== null && repo.state !== "no_branch",
      pr: repo.prNumber === null || repo.prUrl === null ? null : { number: repo.prNumber, url: repo.prUrl, state: prStateOf(repo.state) },
      /** The plain git commands, run inside a clone of the repo. */
      gitCommands: [`git fetch origin ${shellWord(repo.branchName)}`, `git switch ${shellWord(repo.branchName)}`],
    })),
  };
};
