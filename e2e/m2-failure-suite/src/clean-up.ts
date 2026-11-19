import { say } from "@ostra/e2e-m1/setup";
import type { DemoGitHub } from "@ostra/e2e-m1/github";
import { archiveIssue } from "@ostra/e2e-m2/linear";
import type { LinearTool } from "@ostra/e2e-m2/linear";
import { z } from "zod";

import type { World } from "./live/world.ts";

// The suite's clean-up (ticket 38): it archives the tickets the run made in OST, closes their PRs on
// test1, and deletes their branches and hidden refs. Only the run's own: a PR is the suite's when its
// body links a task on the suite's panel, and a ticket when its title starts "Failure suite:".

/** The title every ticket of the suite starts with. */
export const TICKET_PREFIX = "Failure suite:";

const gone = (promise: Promise<unknown>): Promise<boolean> =>
  promise.then(
    () => true,
    () => false,
  );

/** Closes the PRs whose body links a task on `panelUrl`, and deletes their branches and hidden refs. */
export const cleanUpRepo = async (github: DemoGitHub, panelUrl: string): Promise<{ readonly closed: number; readonly deleted: number }> => {
  const { owner, repo, octokit } = github;
  const prefix = `${panelUrl}/tasks/`;
  let closed = 0;
  let deleted = 0;
  const pulls = await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: "all", per_page: 100 });
  for (const pull of pulls) {
    const body = pull.body ?? "";
    const at = body.indexOf(prefix);
    const taskId = at === -1 ? "" : body.slice(at + prefix.length, at + prefix.length + 36);
    if (!/^[0-9a-f-]{36}$/.test(taskId) || !pull.head.ref.startsWith("ostra/")) continue;
    if (pull.state === "open") {
      await octokit.rest.pulls.update({ owner, repo, pull_number: pull.number, state: "closed" });
      closed += 1;
    }
    for (const ref of [`heads/${pull.head.ref}`, `ostra/wip/${taskId}`]) if (await gone(octokit.rest.git.deleteRef({ owner, repo, ref }))) deleted += 1;
  }
  return { closed, deleted };
};

const issuesSchema = z.object({ issues: z.object({ nodes: z.array(z.object({ id: z.string(), identifier: z.string(), title: z.string() })) }) });

/** Archives the team's tickets the suite made: those whose title starts with `TICKET_PREFIX`. */
export const archiveSuiteTickets = async (tool: LinearTool, teamId: string): Promise<number> => {
  const issues = issuesSchema.parse(
    await tool.call("query ($team: ID!, $prefix: String!) { issues(first: 100, filter: { team: { id: { eq: $team } }, title: { startsWith: $prefix } }) { nodes { id identifier title } } }", {
      team: teamId,
      prefix: TICKET_PREFIX,
    }),
  ).issues.nodes;
  for (const issue of issues) await archiveIssue(tool, issue.id);
  return issues.length;
};

/** After a run: the run's PRs, branches and hidden refs on test1, and its tickets in OST. */
export const cleanUpRun = async (world: World): Promise<void> => {
  const { owner, repo, octokit } = world.github;
  // Tasks whose PR never opened still have a branch and a hidden ref.
  const repos = await world.db.taskRepo.findMany({ where: { taskId: { in: world.made.taskIds } }, select: { taskId: true, branchName: true } });
  const cleaned = await cleanUpRepo(world.github, world.m2.publicUrl);
  let deleted = cleaned.deleted;
  for (const row of repos) {
    for (const ref of [`heads/${row.branchName}`, `ostra/wip/${row.taskId}`]) if (await gone(octokit.rest.git.deleteRef({ owner, repo, ref }))) deleted += 1;
  }
  let archived = 0;
  for (const ticket of world.made.tickets) if (await gone(archiveIssue(world.tool, ticket.id))) archived += 1;
  say(`clean-up: closed ${String(cleaned.closed)} PRs, deleted ${String(deleted)} refs, archived ${String(archived)} tickets`);
};
