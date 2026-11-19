import { repoFullNameSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import type { RepoAccess } from "../code-host/base.ts";
import { TinyCodeHost } from "../test-adapters/tiny-adapters.ts";
import { checkRunInput } from "./code-host-suite.ts";
import type { BranchProtectionMode } from "./fake-reviews-and-checks.ts";

// The fake code host's reviews, check runs and branch protection (milestone 4, ticket 03, F-104):
// what core's review check (ticket 18) is tested against before ticket 08's live run on test1 says
// which mode GitHub is. Both modes are fixtures, so whichever way ADR 0040's open question is
// answered, the check's behaviour is already tested.

const repo = repoFullNameSchema.parse("test-org/test1");
const app = { appId: "42", privateKey: "-----BEGIN TEST KEY-----" };
const access: RepoAccess = { app, installationId: "7", repo };
const CHECK = "ostra/independent-review";

/** A host with one open PR from `ostra/task` into a protected `main`, at head `headSha`. */
const hostWithPr = async (mode: BranchProtectionMode | null) => {
  const host = new TinyCodeHost({
    app: { ...app, slug: "ostra-tiny", name: "ostra tiny" },
    installationId: "7",
    repos: [{ hostRepoId: "1001", fullName: repo, defaultBranch: "main", files: {}, branches: ["main", "ostra/task"] }],
  });
  const opened = await host.openPullRequest({ access, head: "ostra/task", base: "main", title: "Add a test", body: "", draft: false });
  if (!opened.ok) throw new Error(opened.error.message);
  const headSha = "a".repeat(40);
  host.pushHead(repo, opened.value.number, headSha);
  host.reviewsAndChecks.protect(repo, "main", mode === null ? null : { requiredCheck: CHECK, mode });
  return { host, number: opened.value.number, headSha };
};

describe("the fake code host's branch protection", () => {
  it("F-104: on the fake host, a required check in progress blocks a merge when in_progress blocks, and lets it through when only a failing check blocks", async () => {
    const blocking = await hostWithPr("in_progress-blocks");
    expect(await blocking.host.publishCheckRun(access, checkRunInput(blocking.headSha, CHECK))).toMatchObject({ ok: true });
    expect(blocking.host.mergePullRequest(repo, blocking.number)).toMatchObject({ merged: false });
    expect(await blocking.host.getPullRequest(access, blocking.number)).toMatchObject({ ok: true, value: { state: "open", merged: false } });

    const lenient = await hostWithPr("only-failing-blocks");
    expect(await lenient.host.publishCheckRun(access, checkRunInput(lenient.headSha, CHECK))).toMatchObject({ ok: true });
    expect(lenient.host.mergePullRequest(repo, lenient.number)).toEqual({ merged: true });
    expect(await lenient.host.getPullRequest(access, lenient.number)).toMatchObject({ ok: true, value: { state: "merged", merged: true } });
  });

  it("F-104: on the fake host, a required check that never ran, or needs action, blocks a merge in both modes, and a passed one lets it through", async () => {
    for (const mode of ["in_progress-blocks", "only-failing-blocks"] as const) {
      const { host, number, headSha } = await hostWithPr(mode);
      expect(host.mergePullRequest(repo, number), `${mode}: never ran`).toMatchObject({ merged: false });
      const published = await host.publishCheckRun(access, { ...checkRunInput(headSha, CHECK), status: "completed", conclusion: "action_required" });
      if (!published.ok) throw new Error(published.error.message);
      expect(host.mergePullRequest(repo, number), `${mode}: action required`).toMatchObject({ merged: false });
      // A check passed on an older head doesn't count for the new one.
      expect(await host.updateCheckRun(access, published.value.checkRunId, { ...checkRunInput(headSha, CHECK), status: "completed", conclusion: "success" })).toMatchObject({ ok: true });
      host.pushHead(repo, number, "b".repeat(40));
      expect(host.mergePullRequest(repo, number), `${mode}: a new head`).toMatchObject({ merged: false });
      host.pushHead(repo, number, headSha);
      expect(host.mergePullRequest(repo, number), `${mode}: passed`).toEqual({ merged: true });
    }
    const unprotected = await hostWithPr(null);
    expect(unprotected.host.mergePullRequest(repo, unprotected.number)).toEqual({ merged: true });
  });
});

describe("the fake code host's reviews and check runs", () => {
  it("F-104: the fake host lists a PR's reviews oldest first, keeps a dismissed one as dismissed, and tells a bot apart", async () => {
    const { host, number } = await hostWithPr(null);
    const first = host.reviewsAndChecks.addReview(repo, number, { userId: "1", login: "grace", isBot: false, state: "approved", commitId: "a".repeat(40), submittedAt: 1 });
    host.reviewsAndChecks.addReview(repo, number, { userId: "2", login: "helper[bot]", isBot: true, state: "approved", commitId: "a".repeat(40), submittedAt: 2 });
    host.reviewsAndChecks.dismissReview(repo, number, first.reviewId);
    const listed = await host.listReviews(access, number);
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.value.map((review) => [review.login, review.state, review.isBot])).toEqual([
      ["grace", "dismissed", false],
      ["helper[bot]", "approved", true],
    ]);
    expect(await host.listReviews(access, number + 1)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("F-104: the fake host publishes one check run per head and name, and an update changes its status and conclusion", async () => {
    const { host, headSha } = await hostWithPr(null);
    const first = await host.publishCheckRun(access, checkRunInput(headSha, CHECK));
    if (!first.ok) throw new Error(first.error.message);
    expect(await host.publishCheckRun(access, checkRunInput(headSha, CHECK))).toEqual(first);
    expect(host.reviewsAndChecks.checkRuns(repo, headSha, CHECK)).toHaveLength(1);
    expect(await host.updateCheckRun(access, first.value.checkRunId, { ...checkRunInput(headSha, CHECK), status: "completed", conclusion: "success" })).toEqual({ ok: true, value: undefined });
    expect(host.reviewsAndChecks.checkRun(first.value.checkRunId)).toMatchObject({ status: "completed", conclusion: "success", headSha, name: CHECK });
    expect(await host.updateCheckRun(access, "no-such-run", checkRunInput(headSha, CHECK))).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});
