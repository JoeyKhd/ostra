// The hidden ref on real GitHub, in the sandbox org's test repo, through the
// test App: does GitHub accept `refs/ostra/wip/<task>`, and does it start CI?
//
//   1. clone the test repo's default branch; leave a modified file, a staged
//      new file and an untracked one
//   2. push the hidden ref (saveWorkInProgress, with the App's token in the
//      environment); read it back through the API
//   3. wait, then count workflow runs and check suites for its commit: none
//   4. the control: push the same commit to a throwaway branch. CI must start
//      for it, or step 3 proves nothing (a repo with no push workflow). The
//      runs listed for the commit then are the control branch's; any other run
//      (head_branch not the control) counts against the hidden ref, so the
//      quiet window lasts until GitHub has visibly processed a push
//   5. restore the ref into a second clone: the files come back
//   6. delete the control branch and the hidden ref
//
// Needs the GitHub inputs; SKIPPED without them.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { git, gitOut } from "../lib/git.ts";
import { activeWorkflows, ciActivityFor, defaultBranch, deleteRemoteRef, gitAuthEnv, loadGitHubApp, mintRepoToken, remoteRef, repoUrl } from "../lib/github.ts";
import { hiddenRef, restoreWorkInProgress, saveWorkInProgress } from "../lib/hidden-ref.ts";
import { taskId as toTaskId } from "../lib/ids.ts";
import { errorMessage, randomWord, sleep, type RunContext } from "../harness/fixture.ts";
import { GITHUB_INPUT_HINT } from "../harness/inputs.ts";
import { check, fail, skip, type Check } from "../harness/report.ts";

const QUIET_WAIT_MS = 60_000;
const CONTROL_WAIT_MS = 180_000;

export const githubHiddenRefChecks = async (ctx: RunContext): Promise<{ checks: Check[]; recorded: Record<string, string | number | boolean> }> => {
  const accepted = "GitHub accepts the hidden ref (push succeeds; the API reads it back)";
  const noCi = "GitHub starts no CI for the hidden ref (no workflow run, no check suite), while a branch push of the same commit does";
  const restored = "the hidden ref on GitHub restores into a fresh clone";
  const recorded: Record<string, string | number | boolean> = {};
  if (ctx.inputs.githubMissing.length > 0) {
    return { checks: [skip(accepted, GITHUB_INPUT_HINT), skip(noCi, GITHUB_INPUT_HINT), skip(restored, GITHUB_INPUT_HINT)], recorded };
  }
  const app = await loadGitHubApp(process.env);
  if (app === undefined) return { checks: [skip(accepted, GITHUB_INPUT_HINT), skip(noCi, GITHUB_INPUT_HINT), skip(restored, GITHUB_INPUT_HINT)], recorded };

  const checks: Check[] = [];
  const task = toTaskId(`spike2-${randomWord("t")}`);
  const ref = hiddenRef(task);
  const controlBranch = `ostra-spike2-control-${randomWord("c")}`;
  const root = path.join(ctx.runRoot, `${task}-github`);
  let token;
  try {
    // What the check needs; spike 4's manifest asks for these.
    token = await mintRepoToken(app, { contents: "write", actions: "read", metadata: "read" });
  } catch (error) {
    return { checks: [fail(accepted, errorMessage(error)), skip(noCi, "a token for the test repo"), skip(restored, "a token for the test repo")], recorded };
  }
  // Check suites need `checks: read`, which the App may not have: GitHub
  // refuses the whole mint then (422), so it is a second, optional token.
  let checksToken;
  try {
    checksToken = await mintRepoToken(app, { contents: "read", actions: "read", checks: "read", metadata: "read" });
  } catch {
    checksToken = undefined;
  }
  recorded["the App has checks: read (a token with it could be minted)"] = checksToken !== undefined;
  const ciToken = checksToken ?? token;
  const env = gitAuthEnv(token);
  try {
    const workflows = await activeWorkflows(app, token);
    recorded["active workflows in the test repo"] = workflows.length;
    const branch = await defaultBranch(app, token);
    const work = path.join(root, "a");
    await mkdir(root, { recursive: true });
    await git(["clone", "-q", "--depth", "1", "--branch", branch, repoUrl(app), work], { cwd: root, env });
    const tracked = (await gitOut(["ls-files"], { cwd: work })).split(/\r?\n/).find((f) => f !== "" && !f.startsWith(".github/"));
    if (tracked !== undefined) await writeFile(path.join(work, tracked), `${await readFile(path.join(work, tracked), "utf8")}\nostra spike 2: an uncommitted edit\n`);
    await writeFile(path.join(work, `${task}-staged.txt`), "staged\n");
    await git(["add", `${task}-staged.txt`], { cwd: work });
    await writeFile(path.join(work, `${task}-untracked.txt`), "untracked\n");

    const saved = await saveWorkInProgress({ workspace: work, remote: "origin", task, turn: 1, pushEnv: env });
    const onGitHub = await remoteRef(app, token, ref.replace(/^refs\//, ""));
    checks.push(check(accepted, onGitHub === saved.commit, onGitHub === saved.commit ? `${ref} points at the saved commit` : `the API reads ${onGitHub ?? "no ref"}`));

    const pushedAt = Date.now();
    await sleep(QUIET_WAIT_MS);
    const quiet = await ciActivityFor(app, ciToken, saved.commit);
    recorded["hidden ref: workflow runs after the quiet wait"] = quiet.workflowRuns;
    recorded["hidden ref: check suites after the quiet wait"] = quiet.checkSuites;
    recorded["check suites readable"] = quiet.checkSuitesReadable;

    await git(["push", "-q", "origin", `${saved.commit}:refs/heads/${controlBranch}`], { cwd: work, env });
    const controlPushedAt = Date.now();
    let control = await ciActivityFor(app, ciToken, saved.commit);
    const deadline = Date.now() + CONTROL_WAIT_MS;
    while (control.workflowRuns === 0 && Date.now() < deadline) {
      await sleep(10_000);
      control = await ciActivityFor(app, ciToken, saved.commit);
    }
    recorded["control branch: workflow runs"] = control.workflowRuns;
    recorded["control branch: seconds until its first run showed"] = Math.round((Date.now() - controlPushedAt) / 1000);
    // After the control's CI showed, GitHub has processed a push of this
    // commit: any run not on the control branch is the hidden ref's.
    const notControl = control.runBranches.filter((b) => b !== controlBranch).length;
    recorded["hidden ref: workflow runs not on the control branch, after the control"] = notControl;
    recorded["hidden ref: quiet window, s"] = Math.round((Date.now() - pushedAt) / 1000);
    if (control.workflowRuns === 0) {
      checks.push(skip(noCi, `the control started no CI either, so this proves nothing: a push-triggered workflow in ${app.org}/${app.repo} (${String(workflows.length)} active workflows now)`));
    } else {
      const suitesNote = quiet.checkSuitesReadable ? `${String(quiet.checkSuites)} check suites` : "check suites not readable (no checks: read)";
      checks.push(
        check(
          noCi,
          quiet.workflowRuns === 0 && quiet.checkSuites === 0 && notControl === 0,
          `${String(quiet.workflowRuns)} runs and ${suitesNote} for the hidden ref after ${String(QUIET_WAIT_MS / 1000)} s; after the control branch got ${String(control.workflowRuns)} runs, ${String(notControl)} runs on any other ref`,
        ),
      );
    }

    const second = path.join(root, "b");
    await git(["clone", "-q", "--depth", "1", "--branch", branch, repoUrl(app), second], { cwd: root, env });
    const back = await restoreWorkInProgress({ workspace: second, remote: "origin", task, fetchEnv: env });
    const same = back !== undefined && JSON.stringify([...back.status].sort()) === JSON.stringify([...saved.status].sort());
    checks.push(check(restored, same, back === undefined ? "no ref found" : `${String(back.status.length)} status entries back, ${same ? "the same as saved" : "DIFFERENT from saved"}`));
  } catch (error) {
    checks.push(fail("the GitHub hidden-ref run", errorMessage(error).slice(0, 300)));
  } finally {
    recorded["cleanup: delete control branch (HTTP)"] = await deleteRemoteRef(app, token, `heads/${controlBranch}`).catch(() => -1);
    recorded["cleanup: delete hidden ref (HTTP)"] = await deleteRemoteRef(app, token, ref.replace(/^refs\//, "")).catch(() => -1);
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
  return { checks, recorded };
};
