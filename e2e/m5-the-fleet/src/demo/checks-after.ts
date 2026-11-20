import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { checkNoCredential } from "@ostra/e2e-m1/checks";
import { scanFolder } from "@ostra/e2e-m1/scan";
import { repoRoot } from "@ostra/e2e-m1/settings";
import { say } from "@ostra/e2e-m1/setup";
import { archiveIssue } from "@ostra/e2e-m2/linear";
import { cleanUpRepo } from "@ostra/e2e-m2-failures/clean-up";
import { STUB_KEY } from "@ostra/e2e-m2-failures/stub-model";

import type { Demo } from "./context.ts";

// The checks after the run (spec section 3): nothing leaked, searched by value and never printed;
// then the tests that prove each check on Postgres and the real gateway (isolation, join tokens, the
// share and the queue, choosing, versions, drain, the fake cluster's objects), run here as they run
// in CI. Then the clean-up: the run's tickets archived in OST, its PRs closed and its branches and
// hidden refs deleted, in test1 and test2 only.

const vitest = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const runTests = (cwd: string, files: readonly string[]): Promise<{ readonly ok: boolean; readonly summary: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [vitest, "run", "--maxWorkers=2", ...files], { cwd, windowsHide: true, timeout: 900_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const lines = `${stdout}${stderr}`.split(/\r?\n/).filter((line) => /^\s*(Tests|Test Files)\s/.test(line));
      resolve({ ok: error === null, summary: lines.map((line) => line.trim()).join("; ") });
    });
  });

/** Files a runner's folder may hold the run's secrets in by design: none. Its key pair and access token are its own. */
const runnerFolders = async (d: Demo): Promise<readonly string[]> =>
  (await readdir(d.settings.runnersDir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && entry.name !== "cli").map((entry) => path.join(d.settings.runnersDir, entry.name));

export const afterRun = async (d: Demo): Promise<void> => {
  // Nothing leaked: the join tokens, the registry's credentials, the stub's key, the App's key and
  // the Linear key, in the event log, every log of the stack and the runners, and every runner's folder.
  const logs = [...d.stack.logFiles(), ...(await readdir(d.logDir).catch(() => [])).filter((name) => name.startsWith("runner-")).map((name) => path.join(d.logDir, name))];
  const needles = [...d.secrets.filter((value) => value.length >= 8), d.settings.m2.linearApiKey];
  const leaked = await checkNoCredential({ ...d.settings.m2, modelApiKey: STUB_KEY }, logs, needles);
  d.check(0, `after the run: ${leaked.name}`, leaked.ok, leaked.detail);
  const holding: string[] = [];
  let files = 0;
  for (const folder of await runnerFolders(d)) {
    const scan = await scanFolder(folder, needles);
    files += scan.files;
    holding.push(...scan.holding.map((file) => `${path.basename(folder)}/${file}`));
  }
  d.check(0, "after the run: no runner's folder or worktree holds a join token, a registry credential or a key", holding.length === 0, holding.length === 0 ? `${String(files)} files searched` : `found in ${holding.slice(0, 5).join(", ")}`);
  for (const [name, cwd, files] of [
    ["isolation: milestone 4's generated test with the new models", path.join(repoRoot, "packages", "api"), ["src/isolation/every-record.test.ts"]],
    ["join tokens, the share and the queue, choosing, drain and versions on the real gateway", path.join(repoRoot, "apps", "core"), ["src/gateway/join-notices.test.ts", "src/dispatch/admission.test.ts", "src/dispatch/choose.test.ts", "src/gateway/drain.test.ts", "src/gateway/version-matrix.test.ts"]],
    ["the compatibility matrix over recorded fixtures", path.join(repoRoot, "packages", "protocol"), ["src/runner/version-matrix.test.ts"]],
    ["the fake cluster's objects: everything released, nothing outside the runner's namespaces", path.join(repoRoot, "packages", "adapters", "adapter-executor-kubernetes"), ["src/kubernetes-executor.contract.test.ts"]],
  ] as const) {
    const result = await runTests(cwd, files);
    d.check(0, `after the run: ${name}`, result.ok, result.summary);
  }
};

/** The run's tickets archived in OST; its PRs closed and their branches and hidden refs deleted in test1 and test2. */
export const cleanUp = async (d: Demo): Promise<void> => {
  let archived = 0;
  for (const ticket of d.made.tickets) {
    if (await archiveIssue(d.tool, ticket.id).then(() => true, () => false)) archived += 1;
  }
  const one = await cleanUpRepo(d.github.test1, d.settings.m2.publicUrl);
  const two = await cleanUpRepo(d.github.test2, d.settings.m2.publicUrl);
  let deleted = one.deleted + two.deleted;
  const repos = await d.db.taskRepo.findMany({ where: { taskId: { in: d.made.taskIds } }, select: { taskId: true, branchName: true, projectId: true } }).catch(() => []);
  for (const row of repos) {
    const github = row.projectId === d.test2.id ? d.github.test2 : d.github.test1;
    for (const ref of [`heads/${row.branchName}`, `ostra/wip/${row.taskId}`]) {
      if (await github.octokit.rest.git.deleteRef({ owner: github.owner, repo: github.repo, ref }).then(() => true, () => false)) deleted += 1;
    }
  }
  say(`clean-up: archived ${String(archived)} tickets, closed ${String(one.closed + two.closed)} PRs, deleted ${String(deleted)} refs`);
};
