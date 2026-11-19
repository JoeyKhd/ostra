import { readFile } from "node:fs/promises";

import { Octokit } from "@octokit/rest";
import { repoFullNameSchema } from "@ostra/protocol";
import type { RepoAccess } from "@ostra/adapter-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
          reasons: ["GitHub doesn't offer branch rules on this repo's plan, so none apply."],
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
