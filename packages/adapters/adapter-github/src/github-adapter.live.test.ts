import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { repoFullNameSchema } from "@ostra/protocol";
import type { RepoAccess, WebhookInput } from "@ostra/adapter-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { GitHubAdapter } from "./github-adapter.ts";

// Live cases against the test App and `ostra-test/test1`. They run only with `github.env` and
// `github-test.env` loaded (`set -a; . ~/.config/ostra-dev/github.env; set +a`), and skip
// otherwise. They print no token, key or secret, and delete every branch they make.

const envSchema = z.object({
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1),
  GITHUB_APP_INSTALLATION_ID: z.string().min(1),
  GITHUB_TEST_ORG: z.string().min(1),
  GITHUB_TEST_REPO: z.string().min(1),
  GITHUB_TEST_OTHER_REPO: z.string().min(1),
});
const env = envSchema.safeParse(process.env);
const userAgent = "ostra-github-adapter-live-test/0.0.0";

/**
 * GitHub refuses an App's JWT stamped by a clock that is off (a machine an hour out answers "Bad
 * credentials"), and Octokit corrects only some of those refusals. The test reads GitHub's own
 * clock once and runs on it, so a skewed dev machine still proves the adapter; the adapter itself
 * is unchanged.
 */
beforeAll(async () => {
  if (!env.success) {
    return;
  }
  const response = await fetch("https://api.github.com/zen", { method: "HEAD", headers: { "user-agent": userAgent } });
  const date = response.headers.get("date");
  const skew = date === null ? 0 : Date.parse(date) - Date.now();
  if (Math.abs(skew) > 30_000) {
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  }
});

describe.skipIf(!env.success)("the GitHub adapter, live on the test org", () => {
  const adapter = new GitHubAdapter({ userAgent: "ostra-github-adapter-live-test/0.0.0" });
  let access: RepoAccess;
  let other: RepoAccess;
  let api: Octokit;
  let branch: string | undefined;
  let prNumber: number | undefined;
  let mergeBranch: string | undefined;

  const config = (): z.infer<typeof envSchema> => {
    if (!env.success) {
      throw new Error("the live environment is not loaded");
    }
    return env.data;
  };

  beforeAll(async () => {
    const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID, GITHUB_TEST_ORG, GITHUB_TEST_REPO, GITHUB_TEST_OTHER_REPO } = config();
    const app = { appId: GITHUB_APP_ID, privateKey: await readFile(GITHUB_APP_PRIVATE_KEY_PATH, "utf8") };
    access = { app, installationId: GITHUB_APP_INSTALLATION_ID, repo: repoFullNameSchema.parse(`${GITHUB_TEST_ORG}/${GITHUB_TEST_REPO}`) };
    other = { app, installationId: GITHUB_APP_INSTALLATION_ID, repo: repoFullNameSchema.parse(`${GITHUB_TEST_ORG}/${GITHUB_TEST_OTHER_REPO}`) };
    const token = await adapter.mintRepoToken(access, { contents: "write", pull_requests: "write", metadata: "read" });
    if (!token.ok) {
      throw new Error(`could not mint a setup token: ${token.error.message}`);
    }
    api = new Octokit({ auth: token.value.token, userAgent: "ostra-github-adapter-live-test/0.0.0" });
  });

  afterAll(async () => {
    const { GITHUB_TEST_ORG, GITHUB_TEST_REPO, GITHUB_TEST_OTHER_REPO } = config();
    if (mergeBranch !== undefined) {
      const minted = await adapter.mintRepoToken(other, { contents: "write", metadata: "read" });
      if (minted.ok) {
        const cleaner = new Octokit({ auth: minted.value.token, userAgent: "ostra-github-adapter-live-test/0.0.0" });
        await cleaner.rest.git.deleteRef({ owner: GITHUB_TEST_ORG, repo: GITHUB_TEST_OTHER_REPO, ref: `heads/${mergeBranch}` });
      }
    }
    if (prNumber !== undefined) {
      await api.rest.pulls.update({ owner: GITHUB_TEST_ORG, repo: GITHUB_TEST_REPO, pull_number: prNumber, state: "closed" });
    }
    if (branch !== undefined) {
      await api.rest.git.deleteRef({ owner: GITHUB_TEST_ORG, repo: GITHUB_TEST_REPO, ref: `heads/${branch}` });
    }
  });

  it("reads the App: it has `checks: write` and `actions: read`", async () => {
    const app = await adapter.readApp(access.app);
    expect(app).toMatchObject({ ok: true, value: { appId: config().GITHUB_APP_ID } });
    if (app.ok) {
      expect(app.value.permissions["checks"]).toBe("write");
      expect(app.value.permissions["actions"]).toBe("read");
    }
  });

  it("lists the installation and both test repos", async () => {
    const installations = await adapter.listInstallations(access.app);
    expect(installations.ok && installations.value.map((item) => item.installationId)).toContain(config().GITHUB_APP_INSTALLATION_ID);
    const repos = await adapter.listRepos(access.app, access.installationId);
    expect(repos.ok && repos.value.map((repo) => repo.fullName)).toEqual(expect.arrayContaining([access.repo, other.repo]));
  });

  it("names the App's bot, and a default branch", async () => {
    const bot = await adapter.getBotIdentity(access.app);
    expect(bot.ok && bot.value.name).toMatch(/\[bot\]$/);
    expect(bot.ok && bot.value.email).toMatch(/^\d+\+.+\[bot\]@users\.noreply\.github\.com$/);
    expect(await adapter.getDefaultBranch(access)).toMatchObject({ ok: true });
  });

  it("mints a token for test1 that can't read test2", async () => {
    const minted = await adapter.mintRepoToken(access, { contents: "read", metadata: "read" });
    if (!minted.ok) {
      throw new Error("mint failed");
    }
    const probe = new Octokit({ auth: minted.value.token, userAgent: "ostra-github-adapter-live-test/0.0.0" });
    const { GITHUB_TEST_ORG, GITHUB_TEST_REPO, GITHUB_TEST_OTHER_REPO } = config();
    await expect(probe.rest.repos.get({ owner: GITHUB_TEST_ORG, repo: GITHUB_TEST_REPO })).resolves.toMatchObject({ status: 200 });
    await expect(probe.rest.repos.get({ owner: GITHUB_TEST_ORG, repo: GITHUB_TEST_OTHER_REPO })).rejects.toMatchObject({ status: 404 });
  });

  it("opens a PR on a test branch, finds it again, and cleans up", async () => {
    const { GITHUB_TEST_ORG, GITHUB_TEST_REPO } = config();
    const base = await adapter.getDefaultBranch(access);
    if (!base.ok) {
      throw new Error("no default branch");
    }
    const head = await api.rest.git.getRef({ owner: GITHUB_TEST_ORG, repo: GITHUB_TEST_REPO, ref: `heads/${base.value}` });
    branch = `ostra/live-test-${String(Date.now())}`;
    await api.rest.git.createRef({ owner: GITHUB_TEST_ORG, repo: GITHUB_TEST_REPO, ref: `refs/heads/${branch}`, sha: head.data.object.sha });
    await api.rest.repos.createOrUpdateFileContents({
      owner: GITHUB_TEST_ORG,
      repo: GITHUB_TEST_REPO,
      path: `live-test/${branch.replaceAll("/", "-")}.md`,
      message: "ostra live test",
      content: Buffer.from("A probe from the ostra GitHub adapter's live test.\n").toString("base64"),
      branch,
    });

    expect(await adapter.findPullRequest(access, branch)).toEqual({ ok: true, value: null });
    const opened = await adapter.openPullRequest({
      access,
      head: branch,
      base: base.value,
      title: "ostra live test: safe to close",
      body: "Opened by the adapter's live test.",
      draft: true,
    });
    expect(opened).toMatchObject({ ok: true, value: { state: "open", headBranch: branch } });
    prNumber = opened.ok ? opened.value.number : undefined;
    const found = await adapter.findPullRequest(access, branch);
    expect(found.ok && found.value?.number).toBe(prNumber);
    expect(await adapter.openPullRequest({ access, head: branch, base: base.value, title: "again", body: "", draft: true })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  }, 60_000);

  it("reads each test repo's default branch as its real protection (F-055, F-060)", async () => {
    const { GITHUB_TEST_ORG, GITHUB_TEST_REPO, GITHUB_TEST_OTHER_REPO } = config();
    for (const repo of [access, other]) {
      const name = repo === access ? GITHUB_TEST_REPO : GITHUB_TEST_OTHER_REPO;
      const base = await adapter.getDefaultBranch(repo);
      if (!base.ok) {
        throw new Error("no default branch");
      }
      const token = await adapter.mintRepoToken(repo, { contents: "read", metadata: "read" });
      if (!token.ok) {
        throw new Error("could not mint a read token");
      }
      const reader = new Octokit({ auth: token.value.token, userAgent: "ostra-github-adapter-live-test/0.0.0" });
      const flagged = (await reader.rest.repos.getBranch({ owner: GITHUB_TEST_ORG, repo: name, branch: base.value })).data.protected;
      // What the rules endpoint says for this plan: a private repo in a free organization is refused.
      const rulesStatus = await reader
        .request("GET /repos/{owner}/{repo}/rules/branches/{branch}", { owner: GITHUB_TEST_ORG, repo: name, branch: base.value })
        .then(
          () => 200,
          (error: unknown) => Number(Reflect.get(Object(error), "status")),
        );

      const rules = await adapter.readBranchRules(repo, base.value);
      expect(rules, name).toMatchObject({ ok: true });
      if (!rules.ok) {
        continue;
      }
      if (flagged) {
        expect(rules.value.protected, name).toBe(true);
      }
      if (rulesStatus === 403 && !flagged) {
        expect(rules.value, name).toEqual({
          protected: false,
          requiresSignedCommits: false,
          reasons: ["no-rules-on-plan"],
        });
      }
      // Never a guess: an answer that isn't a plain yes or no says why.
      if (rules.value.protected === "unknown" || rules.value.requiresSignedCommits === "unknown") {
        expect(rules.value.reasons.length, name).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it("reads a PR the test opened and merged as open, then merged (F-044)", async () => {
    const { GITHUB_TEST_ORG, GITHUB_TEST_OTHER_REPO } = config();
    const minted = await adapter.mintRepoToken(other, { contents: "write", pull_requests: "write", metadata: "read" });
    if (!minted.ok) {
      throw new Error("could not mint a token for the other repo");
    }
    const otherApi = new Octokit({ auth: minted.value.token, userAgent: "ostra-github-adapter-live-test/0.0.0" });
    const target = { owner: GITHUB_TEST_ORG, repo: GITHUB_TEST_OTHER_REPO };
    const base = await adapter.getDefaultBranch(other);
    if (!base.ok) {
      throw new Error("no default branch");
    }
    const head = await otherApi.rest.git.getRef({ ...target, ref: `heads/${base.value}` });
    mergeBranch = `ostra/live-merge-${String(Date.now())}`;
    await otherApi.rest.git.createRef({ ...target, ref: `refs/heads/${mergeBranch}`, sha: head.data.object.sha });
    // One fixed file, so repeated runs change a line and don't grow the tree.
    const path = "live-test/merged-probe.md";
    const existing = await otherApi.rest.repos.getContent({ ...target, path, ref: base.value }).then(
      (response) => (Array.isArray(response.data) ? undefined : response.data.sha),
      () => undefined,
    );
    const committed = await otherApi.rest.repos.createOrUpdateFileContents({
      ...target,
      path,
      message: "ostra live test: a probe for the merged state",
      content: Buffer.from(`Last probed ${new Date().toISOString()} by the ostra GitHub adapter's live test.\n`).toString("base64"),
      branch: mergeBranch,
      ...(existing === undefined ? {} : { sha: existing }),
    });

    const opened = await adapter.openPullRequest({
      access: other,
      head: mergeBranch,
      base: base.value,
      title: "ostra live test: merged by the test",
      body: "Opened and merged by the adapter's live test.",
      draft: false,
    });
    if (!opened.ok) {
      throw new Error(`could not open the PR: ${opened.error.message}`);
    }
    const open = await adapter.getPullRequest(other, opened.value.number);
    expect(open).toMatchObject({ ok: true, value: { state: "open", merged: false, mergedAt: null, headSha: committed.data.commit.sha } });

    await otherApi.rest.pulls.merge({ ...target, pull_number: opened.value.number, merge_method: "squash" });
    const merged = await adapter.getPullRequest(other, opened.value.number);
    expect(merged).toMatchObject({ ok: true, value: { state: "merged", merged: true } });
    expect(merged.ok && merged.value.mergedAt).toEqual(expect.any(Number));
    expect(merged.ok && merged.value.closedAt).toEqual(expect.any(Number));
  }, 90_000);

  it("deletes a hidden ref the test pushed, and deleting it again succeeds (F-079)", async () => {
    const { GITHUB_TEST_ORG, GITHUB_TEST_REPO } = config();
    const base = await adapter.getDefaultBranch(access);
    if (!base.ok) {
      throw new Error("no default branch");
    }
    const head = await api.rest.git.getRef({ owner: GITHUB_TEST_ORG, repo: GITHUB_TEST_REPO, ref: `heads/${base.value}` });
    const ref = `refs/ostra/wip/live-test-${String(Date.now())}`;
    await api.rest.git.createRef({ owner: GITHUB_TEST_ORG, repo: GITHUB_TEST_REPO, ref, sha: head.data.object.sha });
    expect(await adapter.deleteRef(access, ref)).toEqual({ ok: true, value: { deleted: true } });
    expect(await adapter.deleteRef(access, ref)).toEqual({ ok: true, value: { deleted: false } });
    await expect(api.rest.git.getRef({ owner: GITHUB_TEST_ORG, repo: GITHUB_TEST_REPO, ref: ref.slice("refs/".length) })).rejects.toMatchObject({ status: 404 });
  }, 60_000);
});

// Milestone 3 (ticket 09), live: compare, drafts, a reaction, and the comment webhooks GitHub
// delivers. The comments are posted in spike 4's shapes (spikes/github-app-and-git-proxy/src/github/
// pr-flow.ts: a conversation comment, and a line comment on the head's side, `RIGHT`).
const webhookSecret = z.object({ GITHUB_APP_WEBHOOK_SECRET: z.string().min(1) }).safeParse(process.env);
const deliveryPayloadSchema = z.looseObject({ comment: z.looseObject({ id: z.number() }) });

describe.skipIf(!env.success)("the GitHub adapter's milestone 3, live on the test org (F-027, F-054, F-053)", () => {
  const adapter = new GitHubAdapter({ userAgent });
  let access: RepoAccess;
  let api: Octokit;
  let appApi: Octokit;
  let base = "";
  let branch: string | undefined;
  let prNumber: number | undefined;
  let headSha = "";
  let issueCommentId: number | undefined;
  let reviewCommentId: number | undefined;
  let startedAt = 0;
  const path = "live-test/m3-probe.md";

  const config = (): z.infer<typeof envSchema> => {
    if (!env.success) {
      throw new Error("the live environment is not loaded");
    }
    return env.data;
  };
  const target = (): { readonly owner: string; readonly repo: string } => ({ owner: config().GITHUB_TEST_ORG, repo: config().GITHUB_TEST_REPO });

  beforeAll(async () => {
    startedAt = Date.now();
    const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID, GITHUB_TEST_ORG, GITHUB_TEST_REPO } = config();
    const app = { appId: GITHUB_APP_ID, privateKey: await readFile(GITHUB_APP_PRIVATE_KEY_PATH, "utf8") };
    access = { app, installationId: GITHUB_APP_INSTALLATION_ID, repo: repoFullNameSchema.parse(`${GITHUB_TEST_ORG}/${GITHUB_TEST_REPO}`) };
    const token = await adapter.mintRepoToken(access, { contents: "write", pull_requests: "write", metadata: "read" });
    if (!token.ok) {
      throw new Error(`could not mint a setup token: ${token.error.message}`);
    }
    api = new Octokit({ auth: token.value.token, userAgent });
    appApi = new Octokit({ authStrategy: createAppAuth, auth: { appId: app.appId, privateKey: app.privateKey }, userAgent });
    const defaultBranch = await adapter.getDefaultBranch(access);
    if (!defaultBranch.ok) {
      throw new Error("no default branch");
    }
    base = defaultBranch.value;
    // A branch one commit ahead of the default branch, changing one fixed file.
    const head = await api.rest.git.getRef({ ...target(), ref: `heads/${base}` });
    branch = `ostra/live-m3-${String(Date.now())}`;
    await api.rest.git.createRef({ ...target(), ref: `refs/heads/${branch}`, sha: head.data.object.sha });
    const existing = await api.rest.repos.getContent({ ...target(), path, ref: base }).then(
      (response) => (Array.isArray(response.data) ? undefined : response.data.sha),
      () => undefined,
    );
    const committed = await api.rest.repos.createOrUpdateFileContents({
      ...target(),
      path,
      message: "ostra live test: a milestone 3 probe",
      content: Buffer.from(`One.\nTwo.\nThree, probed ${new Date(Date.now()).toISOString()}.\n`).toString("base64"),
      branch,
      ...(existing === undefined ? {} : { sha: existing }),
    });
    headSha = committed.data.commit.sha ?? "";
  }, 60_000);

  afterAll(async () => {
    if (prNumber !== undefined) {
      await api.rest.pulls.update({ ...target(), pull_number: prNumber, state: "closed" });
    }
    if (branch !== undefined) {
      await api.rest.git.deleteRef({ ...target(), ref: `heads/${branch}` });
    }
  }, 60_000);

  it("F-027: compares the test branch with the default branch: one commit ahead, its file and its patch", async () => {
    if (branch === undefined) throw new Error("no branch");
    const compared = await adapter.compare(access, base, branch);
    if (!compared.ok) throw new Error(compared.error.message);
    expect(compared.value).toMatchObject({ aheadBy: 1, behindBy: 0, filesTruncated: false, limits: { maxFiles: 300 } });
    expect(compared.value.mergeBase).toMatch(/^[0-9a-f]{40}$/);
    const file = compared.value.files.find((candidate) => candidate.path === path);
    expect(file).toMatchObject({ truncated: false, previousPath: null });
    expect(["added", "modified"]).toContain(file?.status);
    expect(file?.patch).toContain("+Three, probed");
    // The other way round, the default branch is behind by that commit.
    expect(await adapter.compare(access, branch, base)).toMatchObject({ ok: true, value: { aheadBy: 0, behindBy: 1 } });
    expect(await adapter.compare(access, base, "ostra/no-such-branch-live")).toMatchObject({ ok: false, error: { code: "not-found" } });
  }, 60_000);

  it("F-054: makes a PR the test opens a draft and back, and a state already there is a success", async () => {
    if (branch === undefined) throw new Error("no branch");
    const opened = await adapter.openPullRequest({ access, head: branch, base, title: "ostra live test (milestone 3): safe to close", body: "Opened by the adapter's live test.", draft: false });
    if (!opened.ok) throw new Error(opened.error.message);
    const number = opened.value.number;
    prNumber = number;
    expect(await adapter.setPullRequestDraft(access, number, true)).toMatchObject({ ok: true, value: { number, draft: true } });
    expect((await api.rest.pulls.get({ ...target(), pull_number: number })).data.draft).toBe(true);
    expect(await adapter.setPullRequestDraft(access, number, true)).toMatchObject({ ok: true, value: { draft: true } });
    expect(await adapter.setPullRequestDraft(access, number, false)).toMatchObject({ ok: true, value: { number, draft: false } });
    expect((await api.rest.pulls.get({ ...target(), pull_number: number })).data.draft).toBe(false);
  }, 60_000);

  it("F-053: reacts with eyes to a conversation comment and a line comment, once each", async () => {
    if (prNumber === undefined) throw new Error("no PR");
    const issueComment = await api.rest.issues.createComment({ ...target(), issue_number: prNumber, body: "ostra live test: a conversation comment." });
    const reviewComment = await api.rest.pulls.createReviewComment({
      ...target(),
      pull_number: prNumber,
      commit_id: headSha,
      path,
      line: 2,
      side: "RIGHT",
      body: "ostra live test: a line comment on line 2.",
    });
    issueCommentId = issueComment.data.id;
    reviewCommentId = reviewComment.data.id;
    const issueRef = { kind: "issue", commentId: String(issueComment.data.id) } as const;
    const reviewRef = { kind: "review", commentId: String(reviewComment.data.id) } as const;
    expect(await adapter.addReaction(access, issueRef, "eyes")).toEqual({ ok: true, value: { created: true } });
    expect(await adapter.addReaction(access, issueRef, "eyes")).toEqual({ ok: true, value: { created: false } });
    expect(await adapter.addReaction(access, reviewRef, "eyes")).toEqual({ ok: true, value: { created: true } });
    expect(await adapter.addReaction(access, reviewRef, "eyes")).toEqual({ ok: true, value: { created: false } });
    const onIssue = await api.rest.reactions.listForIssueComment({ ...target(), comment_id: issueComment.data.id });
    expect(onIssue.data.filter((reaction) => reaction.content === "eyes")).toHaveLength(1);
    const onLine = await api.rest.reactions.listForPullRequestReviewComment({ ...target(), comment_id: reviewComment.data.id });
    expect(onLine.data.filter((reaction) => reaction.content === "eyes")).toHaveLength(1);
  }, 60_000);

  it("F-053: parses both comment webhooks from the deliveries the comments triggered", async (context) => {
    if (issueCommentId === undefined || reviewCommentId === undefined) throw new Error("no comments");
    // Only an App subscribed to both events, with its webhook on and its secret saved, gets them
    // (ticket 51, step 9). Until then this case says why it skipped.
    const app = await appApi.request("GET /app");
    const events: readonly string[] = app.data?.events ?? [];
    if (!webhookSecret.success || !events.includes("issue_comment") || !events.includes("pull_request_review_comment")) {
      context.skip("the test App has no webhook subscribed to issue_comment and pull_request_review_comment (ticket 51, step 9)");
      return;
    }
    const secret = webhookSecret.data.GITHUB_APP_WEBHOOK_SECRET;
    const wanted = new Map<string, number>([
      ["issue_comment", issueCommentId],
      ["pull_request_review_comment", reviewCommentId],
    ]);
    const found = new Map<string, unknown>();
    for (let attempt = 0; attempt < 20 && found.size < wanted.size; attempt += 1) {
      const deliveries = await appApi.request("GET /app/hook/deliveries", { per_page: 50 });
      for (const delivery of deliveries.data) {
        const commentId = wanted.get(delivery.event);
        if (commentId === undefined || found.has(delivery.event) || Date.parse(delivery.delivered_at) < startedAt - 60_000) {
          continue;
        }
        const detail = await appApi.request("GET /app/hook/deliveries/{delivery_id}", { delivery_id: Number(delivery.id) });
        const payload = deliveryPayloadSchema.safeParse(detail.data.request.payload);
        if (payload.success && payload.data.comment.id === commentId) {
          found.set(delivery.event, payload.data);
        }
      }
      if (found.size < wanted.size) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
    expect([...found.keys()].sort()).toEqual(["issue_comment", "pull_request_review_comment"]);
    // The API hands the payload back parsed, so the test signs it again with the App's secret, as GitHub does.
    const signed = (event: string): WebhookInput => {
      const body = JSON.stringify(found.get(event));
      return { headers: { "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` }, body, secret };
    };
    for (const event of wanted.keys()) {
      expect(adapter.verifyWebhook(signed(event)), event).toBe(true);
    }
    expect(adapter.parseWebhook(signed("issue_comment"))).toMatchObject({
      ok: true,
      value: { kind: "issue_comment", number: prNumber, onPullRequest: true, repo: access.repo, comment: { commentId: String(issueCommentId), body: "ostra live test: a conversation comment." } },
    });
    expect(adapter.parseWebhook(signed("pull_request_review_comment"))).toMatchObject({
      ok: true,
      value: { kind: "pull_request_review_comment", number: prNumber, path, line: 2, side: "new", comment: { commentId: String(reviewCommentId) } },
    });
  }, 120_000);
});

// Milestone 4 (ticket 08, F-104), live: a check run published once per head and updated, and a
// PR's reviews read back, on a PR the test opens in `test1`. The review a reviewer user sends, its
// dismissal and the webhooks GitHub delivers for them need the reviewer's token and the App's
// `pull_request_review` event (ticket 42, steps 2 and 3), so they are the maintainer's run.

describe.skipIf(!env.success)("the GitHub adapter's milestone 4, live on the test org (F-104)", () => {
  const adapter = new GitHubAdapter({ userAgent });
  let access: RepoAccess;
  let api: Octokit;
  let base = "";
  let branch: string | undefined;
  let prNumber: number | undefined;
  let headSha = "";
  const name = `ostra/live-check-${String(Date.now())}`;

  const config = (): z.infer<typeof envSchema> => {
    if (!env.success) {
      throw new Error("the live environment is not loaded");
    }
    return env.data;
  };
  const target = (): { readonly owner: string; readonly repo: string } => ({ owner: config().GITHUB_TEST_ORG, repo: config().GITHUB_TEST_REPO });

  beforeAll(async () => {
    const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID, GITHUB_TEST_ORG, GITHUB_TEST_REPO } = config();
    const app = { appId: GITHUB_APP_ID, privateKey: await readFile(GITHUB_APP_PRIVATE_KEY_PATH, "utf8") };
    access = { app, installationId: GITHUB_APP_INSTALLATION_ID, repo: repoFullNameSchema.parse(`${GITHUB_TEST_ORG}/${GITHUB_TEST_REPO}`) };
    const token = await adapter.mintRepoToken(access, { contents: "write", pull_requests: "write", metadata: "read" });
    if (!token.ok) {
      throw new Error(`could not mint a setup token: ${token.error.message}`);
    }
    api = new Octokit({ auth: token.value.token, userAgent });
    const defaultBranch = await adapter.getDefaultBranch(access);
    if (!defaultBranch.ok) {
      throw new Error("no default branch");
    }
    base = defaultBranch.value;
    const head = await api.rest.git.getRef({ ...target(), ref: `heads/${base}` });
    branch = `ostra/live-m4-${String(Date.now())}`;
    await api.rest.git.createRef({ ...target(), ref: `refs/heads/${branch}`, sha: head.data.object.sha });
    const committed = await api.rest.repos.createOrUpdateFileContents({
      ...target(),
      path: `live-test/${branch.replaceAll("/", "-")}.md`,
      message: "ostra live test: a milestone 4 probe",
      content: Buffer.from("A probe from the ostra GitHub adapter's milestone 4 live test.\n").toString("base64"),
      branch,
    });
    headSha = committed.data.commit.sha ?? "";
    const opened = await adapter.openPullRequest({ access, head: branch, base, title: "ostra live test (milestone 4): safe to close", body: "Opened by the adapter's live test.", draft: false });
    if (!opened.ok) throw new Error(opened.error.message);
    prNumber = opened.value.number;
  }, 60_000);

  afterAll(async () => {
    if (prNumber !== undefined) {
      await api.rest.pulls.update({ ...target(), pull_number: prNumber, state: "closed" });
    }
    if (branch !== undefined) {
      await api.rest.git.deleteRef({ ...target(), ref: `heads/${branch}` });
    }
  }, 60_000);

  it("F-104: publishes a check run on the PR's head once, a second publish answering the same run, and updates it to success", async () => {
    const input = {
      name,
      headSha,
      status: "in_progress",
      conclusion: null,
      title: "Waiting for an independent reviewer",
      summary: "A member who didn't drive the task approves the PR's current head.",
      externalId: "live-test",
    } as const;
    const first = await adapter.publishCheckRun(access, input);
    if (!first.ok) throw new Error(first.error.message);
    expect(await adapter.publishCheckRun(access, input)).toEqual(first);
    // Read back with a token of its own that can read checks, as a person's view of the head would.
    const reader = await adapter.mintRepoToken(access, { checks: "read", metadata: "read" });
    if (!reader.ok) throw new Error(reader.error.message);
    const checks = new Octokit({ auth: reader.value.token, userAgent });
    const runs = await checks.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...target(), ref: headSha, check_name: name, filter: "all" });
    expect(runs.data.check_runs.map((run) => String(run.id))).toEqual([first.value.checkRunId]);
    expect(runs.data.check_runs[0]).toMatchObject({ status: "in_progress", conclusion: null, external_id: "live-test", output: { title: input.title } });
    expect(await adapter.updateCheckRun(access, first.value.checkRunId, { ...input, status: "completed", conclusion: "success", title: "Approved by an independent reviewer" })).toEqual({ ok: true, value: undefined });
    const done = await checks.request("GET /repos/{owner}/{repo}/check-runs/{check_run_id}", { ...target(), check_run_id: Number(first.value.checkRunId) });
    expect(done.data).toMatchObject({ status: "completed", conclusion: "success", head_sha: headSha, output: { title: "Approved by an independent reviewer" } });
    // After the update, a publish for the head still answers the same run.
    expect(await adapter.publishCheckRun(access, input)).toEqual(first);
    console.info(`live check run: one run on the head, published twice, updated to ${String(done.data.conclusion)}`);
  }, 60_000);

  it("F-104: lists the PR's reviews, the App's own comment review read as a bot's", async () => {
    if (prNumber === undefined) throw new Error("no PR");
    expect(await adapter.listReviews(access, prNumber)).toEqual({ ok: true, value: [] });
    // The App can comment on its own PR (it can't approve it): its bot is the review's author.
    await api.rest.pulls.createReview({ ...target(), pull_number: prNumber, commit_id: headSha, event: "COMMENT", body: "ostra live test: the App's own comment review." });
    const listed = await adapter.listReviews(access, prNumber);
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toMatchObject({ isBot: true, state: "commented", commitId: headSha });
    expect(listed.value[0]?.login).toMatch(/\[bot\]$/);
    expect(listed.value[0]?.submittedAt).toEqual(expect.any(Number));
    console.info(`live reviews: ${String(listed.value.length)} review, isBot=${String(listed.value[0]?.isBot)}, state=${String(listed.value[0]?.state)}`);
  }, 60_000);
});

describe.skipIf(!env.success)("the GitHub adapter's milestone 6, live on the test org (F-035, F-100, F-102)", () => {
  const adapter = new GitHubAdapter({ userAgent });
  let access: RepoAccess;
  let api: Octokit;
  let base = "";
  let branch: string | undefined;
  let prNumber: number | undefined;
  let headSha = "";
  const codeOwners = "# ostra live test\n/live-test/ @ostra-test/nobody\n";
  /** The file the test's commit adds: its lines 1 to 3 are the PR's diff. */
  const probePath = (): string => `live-test/${(branch ?? "x").replaceAll("/", "-")}.md`;

  const config = (): z.infer<typeof envSchema> => {
    if (!env.success) {
      throw new Error("the live environment is not loaded");
    }
    return env.data;
  };
  const target = (): { readonly owner: string; readonly repo: string } => ({ owner: config().GITHUB_TEST_ORG, repo: config().GITHUB_TEST_REPO });

  beforeAll(async () => {
    const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID, GITHUB_TEST_ORG, GITHUB_TEST_REPO } = config();
    const app = { appId: GITHUB_APP_ID, privateKey: await readFile(GITHUB_APP_PRIVATE_KEY_PATH, "utf8") };
    access = { app, installationId: GITHUB_APP_INSTALLATION_ID, repo: repoFullNameSchema.parse(`${GITHUB_TEST_ORG}/${GITHUB_TEST_REPO}`) };
    const token = await adapter.mintRepoToken(access, { contents: "write", pull_requests: "write", metadata: "read" });
    if (!token.ok) {
      throw new Error(`could not mint a setup token: ${token.error.message}`);
    }
    api = new Octokit({ auth: token.value.token, userAgent });
    const defaultBranch = await adapter.getDefaultBranch(access);
    if (!defaultBranch.ok) {
      throw new Error("no default branch");
    }
    base = defaultBranch.value;
    const head = await api.rest.git.getRef({ ...target(), ref: `heads/${base}` });
    branch = `ostra/live-m6-${String(Date.now())}`;
    await api.rest.git.createRef({ ...target(), ref: `refs/heads/${branch}`, sha: head.data.object.sha });
    await api.rest.repos.createOrUpdateFileContents({
      ...target(),
      path: ".github/CODEOWNERS",
      message: "ostra live test: a CODEOWNERS file",
      content: Buffer.from(codeOwners).toString("base64"),
      branch,
    });
    const committed = await api.rest.repos.createOrUpdateFileContents({
      ...target(),
      path: probePath(),
      message: "ostra live test: a milestone 6 probe",
      content: Buffer.from("A probe from the ostra GitHub adapter's milestone 6 live test.\nIts second line.\nIts third line.\n").toString("base64"),
      branch,
    });
    headSha = committed.data.commit.sha ?? "";
    const opened = await adapter.openPullRequest({ access, head: branch, base, title: "ostra live test (milestone 6): safe to close", body: "Opened by the adapter's live test.", draft: false });
    if (!opened.ok) throw new Error(opened.error.message);
    prNumber = opened.value.number;
  }, 90_000);

  afterAll(async () => {
    if (prNumber !== undefined) {
      await api.rest.pulls.update({ ...target(), pull_number: prNumber, state: "closed" });
    }
    if (branch !== undefined) {
      await api.rest.git.deleteRef({ ...target(), ref: `heads/${branch}` });
    }
  }, 60_000);

  it("F-035: reads a workflow run's check runs on its head, and a GitHub Actions job's log from the end up to the cap", async () => {
    // The newest finished run of test1's own CI workflow: its jobs' logs are kept for 90 days.
    const reader = await adapter.mintRepoToken(access, { actions: "read", metadata: "read" });
    if (!reader.ok) throw new Error(reader.error.message);
    const actions = new Octokit({ auth: reader.value.token, userAgent });
    const runs = await actions.request("GET /repos/{owner}/{repo}/actions/runs", { ...target(), status: "completed", per_page: 5 });
    const run = runs.data.workflow_runs[0];
    if (run === undefined) throw new Error("test1 has no finished workflow run");
    const ci = await adapter.listCiResults(access, run.head_sha);
    if (!ci.ok) throw new Error(ci.error.message);
    const job = ci.value.checkRuns.find((candidate) => candidate.appSlug === "github-actions" && candidate.status === "completed");
    if (job === undefined) throw new Error("the run's head has no finished Actions check run");
    expect([job.status, typeof job.conclusion, typeof job.startedAt, typeof job.completedAt]).toEqual(["completed", "string", "number", "number"]);
    const log = await adapter.getCiLog(access, { kind: "check-run", checkRunId: job.id }, 2_048);
    if (!log.ok) throw new Error(log.error.message);
    if (!log.value.found) throw new Error(`no log: ${log.value.reason}`);
    expect(Buffer.byteLength(log.value.text)).toBeLessThanOrEqual(2_048);
    expect(log.value.totalBytes).toBeGreaterThan(0);
    expect(log.value.text.length).toBeGreaterThan(0);
    const whole = await adapter.getCiLog(access, { kind: "check-run", checkRunId: job.id }, 1_000_000);
    if (!whole.ok || !whole.value.found) throw new Error("the whole log could not be read");
    // The tail is the end of the whole log.
    expect(whole.value.text.endsWith(log.value.text)).toBe(true);
    expect(whole.value.truncated).toBe(false);
    console.info(
      `live CI: run ${String(run.id)} head ${run.head_sha.slice(0, 7)}: ${String(ci.value.checkRuns.length)} check run(s), ${String(ci.value.statuses.length)} status(es); job log ${String(log.value.totalBytes)} bytes, tail ${String(Buffer.byteLength(log.value.text))} bytes, truncated=${String(log.value.truncated)}, tail ends the whole log=${String(whole.value.text.endsWith(log.value.text))}`,
    );
  }, 60_000);

  it("F-100: posts a comment-type review with one line comment, and an off-diff finding is named, then moved into the body", async () => {
    if (prNumber === undefined) throw new Error("no PR");
    const lines = await adapter.diffLines(access, prNumber);
    if (!lines.ok) throw new Error(lines.error.message);
    expect(lines.value.find((file) => file.path === probePath())).toEqual({ path: probePath(), new: [{ start: 1, end: 3 }], old: [] });
    const onDiff = { path: probePath(), line: 2, side: "new", body: "ostra live test: a finding on a line of the diff." } as const;
    const offDiff = { path: probePath(), line: 40, side: "new", body: "ostra live test: a finding on a line outside the diff." } as const;
    const refused = await adapter.createReview(access, prNumber, { event: "COMMENT", commitId: headSha, body: "ostra live test: a review.", comments: [onDiff, offDiff] });
    expect(refused).toMatchObject({ ok: false, error: { code: "line-outside-diff", commentIndex: 1 } });
    expect(await adapter.listReviews(access, prNumber)).toEqual({ ok: true, value: [] });
    // What core does with the refusal: the finding moves into the body, and the review is posted once more.
    const posted = await adapter.createReview(access, prNumber, {
      event: "COMMENT",
      commitId: headSha,
      body: `ostra live test: a review.\n\n**${offDiff.path}:${String(offDiff.line)}:** ${offDiff.body}`,
      comments: [onDiff],
    });
    if (!posted.ok) throw new Error(posted.error.message);
    expect(posted.value.url).toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+#pullrequestreview-\d+$/);
    const reviews = await adapter.listReviews(access, prNumber);
    expect(reviews.ok && reviews.value.map((review) => [review.state, review.isBot, review.commitId])).toEqual([["commented", true, headSha]]);
    const comments = await adapter.listReviewComments(access, prNumber, posted.value.reviewId);
    if (!comments.ok) throw new Error(comments.error.message);
    expect(comments.value.map((comment) => [comment.path, comment.line, comment.side, comment.body])).toEqual([[onDiff.path, 2, "new", onDiff.body]]);
    console.info(`live review: the off-diff comment was named as index 1 and nothing was posted; the retry posted review ${posted.value.reviewId} with ${String(comments.value.length)} line comment, on line 2`);
  }, 60_000);

  it("F-102: reads the PR's requested reviewers, and CODEOWNERS where GitHub looks first", async () => {
    if (prNumber === undefined || branch === undefined) throw new Error("no PR");
    // No one is asked: asking a person would notify them, so the list is read as it is.
    expect(await adapter.listRequestedReviewers(access, prNumber)).toEqual({ ok: true, value: { users: [], teams: [] } });
    expect(await adapter.readCodeOwners(access, branch)).toEqual({ ok: true, value: codeOwners });
    expect(await adapter.readCodeOwners(access, base)).toEqual({ ok: true, value: null });
    console.info(`live reviewers: PR ${String(prNumber)} has 0 requested reviewers; CODEOWNERS read at the branch from .github/CODEOWNERS, none on ${base}`);
  }, 60_000);
});
