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
    const { GITHUB_TEST_ORG, GITHUB_TEST_REPO } = config();
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
});
