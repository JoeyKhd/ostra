// `pnpm --filter @ostra/e2e-m2 clean-up`: the demo's clean-up (spec section 3, "Clean-up"). It
// closes the demo's PRs on the test repo, those whose branch names a ticket of the demo's team
// (`ostra/ost-<n>-…`), and deletes their branches and hidden refs. Nothing else on the repo is
// touched: milestone 1's kept PR, and other sessions' work, stay. It archives the tickets the demo made in OST (those with the `ostra-demo` label), and
// deletes any webhook the dev seed left on Linear. `--keep-pr <n>` and `--keep-ticket <OST-n>` keep
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

/** Closes the demo's open PRs except `keep`, then deletes the branches and hidden refs of every demo task not kept. */
const cleanUpRepo = async (github: DemoGitHub, teamKey: string, keep: ReadonlySet<number>): Promise<{ readonly closed: number; readonly deleted: number }> => {
  const { owner, repo, octokit } = github;
  const prefix = `ostra/${teamKey.toLowerCase()}-`;
  const kept = new Set<string>();
  let closed = 0;
  const pulls = await octokit.rest.pulls.list({ owner, repo, state: "all", per_page: 100 });
  for (const pull of pulls.data) {
    if (!pull.head.ref.startsWith(prefix)) continue;
    if (keep.has(pull.number)) {
      kept.add(pull.head.ref);
      continue;
    }
    if (pull.state === "open") {
      await octokit.rest.pulls.update({ owner, repo, pull_number: pull.number, state: "closed" });
      closed += 1;
    }
  }
  // A branch `ostra/ost-<n>-<last 8 hex of the task ID>-<slug>` names its task's hidden ref.
  const keptTasks = new Set([...kept].map((branch) => branch.slice(prefix.length).split("-")[1] ?? ""));
  let deleted = 0;
  const branches = await octokit.rest.git.listMatchingRefs({ owner, repo, ref: `heads/${prefix}` });
  const demoTasks = new Set<string>();
  for (const ref of branches.data) {
    const branch = ref.ref.replace(/^refs\/heads\//, "");
    const part = branch.slice(prefix.length).split("-")[1] ?? "";
    demoTasks.add(part);
    if (kept.has(branch)) continue;
    await octokit.rest.git.deleteRef({ owner, repo, ref: ref.ref.replace(/^refs\//, "") });
    deleted += 1;
  }
  const hidden = await octokit.rest.git.listMatchingRefs({ owner, repo, ref: "ostra/wip/" });
  for (const ref of hidden.data) {
    const part = ref.ref.replace(/^refs\/ostra\/wip\//, "").replaceAll("-", "").slice(-8);
    if (!demoTasks.has(part) || keptTasks.has(part)) continue;
    await octokit.rest.git.deleteRef({ owner, repo, ref: ref.ref.replace(/^refs\//, "") });
    deleted += 1;
  }
  return { closed, deleted };
};

const main = async (): Promise<void> => {
  const settings = m2Settings(process.env);
  const keepPrs = new Set(valuesOf("--keep-pr").map(Number));
  const keepTickets = new Set(valuesOf("--keep-ticket"));
  const github = await demoGitHub(settings);
  const cleaned = await cleanUpRepo(github, settings.linearTeamKey, keepPrs);
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
