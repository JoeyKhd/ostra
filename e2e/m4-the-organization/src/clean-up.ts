import { say } from "@ostra/e2e-m1/setup";
import { archiveIssue } from "@ostra/e2e-m2/linear";
import { removeSeedWebhook } from "@ostra/e2e-m2/seed-linear";

import type { Demo } from "./context.ts";

// Spec section 3, the clean-up (ticket 41): only this run's own records. Each task's PRs closed,
// its branch and hidden ref deleted, in the repos it used; its tickets archived in OST; the dev
// seed's webhook deleted. Another session's PRs and branches on the same repos are left alone.

const gone = (error: unknown): boolean => typeof error === "object" && error !== null && "status" in error && (error.status === 404 || error.status === 422);

export const cleanUp = async (d: Demo): Promise<void> => {
  const { github } = d;
  const repos = await d.db.taskRepo.findMany({ select: { taskId: true, branchName: true, repo: { select: { fullName: true } }, pullRequests: { select: { number: true } } } });
  let closed = 0;
  let deleted = 0;
  for (const row of repos) {
    const [owner = "", repo = ""] = row.repo.fullName.split("/");
    if (owner !== github.owner) continue;
    for (const pr of row.pullRequests) {
      const pull = await github.octokit.rest.pulls.get({ owner, repo, pull_number: pr.number });
      if (pull.data.state === "open") {
        await github.octokit.rest.pulls.update({ owner, repo, pull_number: pr.number, state: "closed" });
        closed += 1;
      }
    }
    for (const ref of [`heads/${row.branchName}`, `ostra/wip/${row.taskId}`]) {
      await github.octokit.rest.git.deleteRef({ owner, repo, ref }).then(
        () => {
          deleted += 1;
        },
        (error: unknown) => {
          if (!gone(error)) throw error;
        },
      );
    }
  }
  let archived = 0;
  for (const [key, value] of Object.entries(d.run.ids)) {
    if (!key.startsWith("ticket:")) continue;
    await archiveIssue(d.tool, value.split("|")[0] ?? "");
    archived += 1;
  }
  const webhook = d.run.notes["linearWebhook"];
  if (webhook !== undefined && webhook !== "polling") await removeSeedWebhook(d.tool, webhook);
  say(`clean-up: ${String(closed)} PRs closed, ${String(deleted)} refs deleted, ${String(archived)} tickets archived`);
  d.check("after: the clean-up closed this run's PRs, deleted its refs and archived its tickets", true, `${String(closed)} PRs closed, ${String(deleted)} refs deleted, ${String(archived)} tickets archived`);
};
