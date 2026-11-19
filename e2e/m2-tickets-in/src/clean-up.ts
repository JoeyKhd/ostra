// `pnpm --filter @ostra/e2e-m2 clean-up`: the demo's clean-up (spec section 3, "Clean-up"). It
// closes this stack's PRs on the test repo, those whose body links a task on this stack's panel, and
// deletes their branches and hidden refs. Nothing else on the repo is touched: milestone 1's kept
// PR, and other stacks' work, stay. It archives the tickets the demo made in the team (those with the
// `ostra-demo` label), and deletes any webhook the dev seed left on Linear. `--keep-pr <n>` and `--keep-ticket <OST-n>` keep
// the final run's PR and ticket, which demo.md links.

import { demoGitHub } from "@ostra/e2e-m1/github";
import type { DemoGitHub } from "@ostra/e2e-m1/github";
import { z } from "zod";

import { archiveIssue, deleteWebhook, linearTool, listWebhooks } from "./linear.ts";
import { SEED_WEBHOOK_LABEL } from "./seed-linear.ts";
import { m2Settings } from "./settings.ts";

const valuesOf = (flag: string): readonly string[] =>
  process.argv.flatMap((arg, index) => (arg === flag && index + 1 < process.argv.length ? [process.argv[index + 1] ?? ""] : []));

const demoIssuesSchema = z.object({
  issues: z.object({ nodes: z.array(z.object({ id: z.string(), identifier: z.string() })) }),
});

/**
 * Closes this stack's open PRs except `keep`, and deletes their branches and hidden refs. A PR is
 * this stack's when its body links a task on this stack's panel (`OSTRA_PUBLIC_URL`): other stacks
 * on the same test repo, the maintainer's and other sessions', have other addresses, and their PRs
 * are never touched.
 */
const cleanUpRepo = async (github: DemoGitHub, publicUrl: string, keep: ReadonlySet<number>): Promise<{ readonly closed: number; readonly deleted: number }> => {
  const { owner, repo, octokit } = github;
  const prefix = `${publicUrl}/tasks/`;
  const taskIdIn = (body: string): string | undefined => {
    const at = body.indexOf(prefix);
    const id = at === -1 ? "" : body.slice(at + prefix.length, at + prefix.length + 36);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : undefined;
  };
  let closed = 0;
  let deleted = 0;
  const pulls = await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: "all", per_page: 100 });
  for (const pull of pulls) {
    const taskId = taskIdIn(pull.body ?? "");
    if (taskId === undefined || !pull.head.ref.startsWith("ostra/") || keep.has(pull.number)) continue;
    if (pull.state === "open") {
      await octokit.rest.pulls.update({ owner, repo, pull_number: pull.number, state: "closed" });
      closed += 1;
    }
    for (const ref of [`heads/${pull.head.ref}`, `ostra/wip/${taskId}`]) {
      const gone = await octokit.rest.git.deleteRef({ owner, repo, ref }).then(
        () => true,
        () => false,
      );
      if (gone) deleted += 1;
    }
  }
  return { closed, deleted };
};

const main = async (): Promise<void> => {
  const settings = m2Settings(process.env);
  const keepPrs = new Set(valuesOf("--keep-pr").map(Number));
  const keepTickets = new Set(valuesOf("--keep-ticket"));
  const github = await demoGitHub(settings);
  const cleaned = await cleanUpRepo(github, settings.publicUrl, keepPrs);
  process.stdout.write(`[clean-up] closed ${String(cleaned.closed)} PRs, deleted ${String(cleaned.deleted)} refs\n`);

  const tool = linearTool(settings.linearApiKey);
  const issues = demoIssuesSchema.parse(
    await tool.call(
      "query ($team: ID!) { issues(first: 100, filter: { team: { id: { eq: $team } }, labels: { some: { name: { eq: \"ostra-demo\" } } } }) { nodes { id identifier } } }",
      { team: settings.linearTeamId },
    ),
  ).issues.nodes;
  let archived = 0;
  for (const issue of issues) {
    if (keepTickets.has(issue.identifier)) continue;
    await archiveIssue(tool, issue.id);
    archived += 1;
  }
  let hooks = 0;
  for (const hook of await listWebhooks(tool)) {
    if (hook.label !== SEED_WEBHOOK_LABEL) continue;
    await deleteWebhook(tool, hook.id);
    hooks += 1;
  }
  process.stdout.write(`[clean-up] archived ${String(archived)} tickets, deleted ${String(hooks)} webhooks\n`);
};

await main();
