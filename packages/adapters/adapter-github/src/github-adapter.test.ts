import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { CheckRunState, InstallationAccount, PullRequestReview } from "@ostra/adapter-sdk";

import { defineCodeHostContractSuite, memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import type { CodeHostFixture } from "@ostra/adapter-sdk/testing";
import { repoFullNameSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFakeGitHub } from "./fake-github.ts";
import type { FakeGitHub, FakeReview } from "./fake-github.ts";
import { GITHUB_COM_LFS_ACTION_HOSTS, GitHubAdapter } from "./github-adapter.ts";
import { OSTRA_PROJECT_URL } from "./manifest.ts";

const template = "## What\n\n## Why\n";
const test1 = repoFullNameSchema.parse("fake-org/test1");
const test2 = repoFullNameSchema.parse("fake-org/test2");

/** A big patch, over GitHub's 500 KB a file, and 300 small ones: GitHub lists 300 and leaves the big one's patch out. */
const bigPatch = `@@ -1 +1 @@\n${"+x".repeat(300_000)}\n`;
const truncatedFiles = [
  { path: "huge.txt", status: "modified", additions: 300_000, deletions: 0, patch: bigPatch },
  ...Array.from({ length: 300 }, (_, index) => ({ path: `many/${String(index)}.txt`, status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+a\n" })),
];

const compares = [
  {
    base: "main",
    head: "ostra/contract",
    aheadBy: 2,
    behindBy: 0,
    mergeBase: "b".repeat(40),
    files: [
      { path: "src/new.ts", status: "added", additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c\n" },
      { path: "src/moved.ts", previousPath: "src/old.ts", status: "renamed", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b\n" },
      { path: "logo.png", status: "modified", additions: 0, deletions: 0 },
      { path: "gone.md", status: "removed", additions: 0, deletions: 4, patch: "@@ -1,4 +0,0 @@\n-a\n-b\n-c\n-d\n" },
      { path: "odd.txt", status: "something-new", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+a\n" },
    ],
  },
  { base: "main", head: "ostra/other", aheadBy: 0, behindBy: 3 },
  { base: "main", head: "ostra/third", aheadBy: 2, behindBy: 1 },
  { base: "main", head: "ostra/review", aheadBy: 40, behindBy: 0, files: truncatedFiles },
] as const;

/** A comment's webhook payload, shaped as GitHub sends it (docs.github.com, "Webhook events and payloads"). */
const issueCommentPayload = (input: { readonly commentId: string; readonly onPullRequest: boolean; readonly body: string }): string =>
  JSON.stringify({
    action: "created",
    installation: { id: 7 },
    repository: { id: 1001, full_name: "fake-org/test1", owner: { login: "fake-org" } },
    issue: {
      number: 5,
      title: "a PR",
      ...(input.onPullRequest ? { pull_request: { url: "https://api.github.example/repos/fake-org/test1/pulls/5", html_url: "https://github.example/fake-org/test1/pull/5" } } : {}),
    },
    comment: {
      id: Number(input.commentId),
      body: input.body,
      html_url: `https://github.example/fake-org/test1/pull/5#issuecomment-${input.commentId}`,
      user: { id: 583231, login: "octocat", type: "User" },
      author_association: "MEMBER",
    },
    sender: { id: 583231, login: "octocat" },
  });

const reviewCommentPayload = (input: { readonly commentId: string; readonly side: "LEFT" | "RIGHT"; readonly line: number | null; readonly subjectType?: "line" | "file" }): string =>
  JSON.stringify({
    action: "created",
    installation: { id: 7 },
    repository: { id: 1001, full_name: "fake-org/test1" },
    pull_request: { number: 5, head: { ref: "ostra/contract", sha: "a".repeat(40) } },
    comment: {
      id: Number(input.commentId),
      body: "@ostra rename this",
      html_url: `https://github.example/fake-org/test1/pull/5#discussion_r${input.commentId}`,
      user: { id: 583231, login: "octocat" },
      path: "src/index.ts",
      line: input.line,
      original_line: input.line,
      side: input.side,
      subject_type: input.subjectType ?? "line",
      diff_hunk: "@@ -1 +1 @@",
    },
    sender: { id: 583231, login: "octocat" },
  });

const pushPayload = (commits: unknown): string =>
  JSON.stringify({
    ref: "refs/heads/main",
    before: "c".repeat(40),
    after: "d".repeat(40),
    installation: { id: 7 },
    repository: { id: 1001, full_name: "fake-org/test1" },
    commits,
    head_commit: null,
  });

const signed = (fake: FakeGitHub, event: string, body: string): { readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly secret: string } => ({
  headers: { "x-github-event": event, "x-github-delivery": `delivery-${event}`, "x-hub-signature-256": fake.signWebhook(body) },
  body,
  secret: fake.webhookSecret,
});

const linkedUser = { userId: "583231", login: "octocat" };
const linkRedirect = "https://ostra.example.test/api/github/link/callback";

const milestone3Fixture = (fake: FakeGitHub): Pick<CodeHostFixture, "compare" | "commentWebhooks" | "comment" | "userLink"> => {
  const issueCommentId = fake.addComment("fake-org/test1", "issue");
  const reviewCommentId = fake.addComment("fake-org/test1", "review");
  return {
    compare: {
      ahead: { base: "main", head: "ostra/contract", aheadBy: 2, behindBy: 0 },
      behind: { base: "main", head: "ostra/other", aheadBy: 0, behindBy: 3 },
      diverged: { base: "main", head: "ostra/third", aheadBy: 2, behindBy: 1 },
      truncated: { base: "main", head: "ostra/review", path: "huge.txt" },
    },
    commentWebhooks: {
      issueComment: {
        input: signed(fake, "issue_comment", issueCommentPayload({ commentId: issueCommentId, onPullRequest: true, body: "@ostra fix the test" })),
        number: 5,
        commentId: issueCommentId,
        authorId: "583231",
        body: "@ostra fix the test",
      },
      reviewComment: {
        input: signed(fake, "pull_request_review_comment", reviewCommentPayload({ commentId: reviewCommentId, side: "RIGHT", line: 12 })),
        number: 5,
        commentId: reviewCommentId,
        path: "src/index.ts",
        line: 12,
        side: "new",
      },
      push: {
        input: signed(fake, "push", pushPayload([{ added: ["a.ts"], removed: ["pnpm-lock.yaml"], modified: ["b.ts"] }, { added: [], removed: [], modified: ["b.ts", "c.ts"] }])),
        ref: "refs/heads/main",
        after: "d".repeat(40),
        changedPaths: ["a.ts", "pnpm-lock.yaml", "b.ts", "c.ts"],
      },
    },
    comment: { kind: "issue", commentId: issueCommentId },
    userLink: {
      client: fake.oauthClient,
      code: fake.issueUserCode(linkedUser, { redirectUri: linkRedirect }),
      redirectUri: linkRedirect,
      user: linkedUser,
      revokedTokens: fake.revokedUserTokens,
      failNextRevocation: () => {
        fake.failRevocations(1);
      },
    },
  };
};

// ---- milestone 4 (ticket 47, F-136): a stranger's installation, and another the suite removes ----

const STRANGER = { login: "stranger-co", id: 9_100, type: "Organization", installationId: 91 } as const;
const ANOTHER = { login: "another-dev", id: 9_200, type: "User", installationId: 92 } as const;
const strangerRead: InstallationAccount = { accountId: "9100", login: "stranger-co", kind: "organization" };
const strangerRepo = (id: number, name: string) => ({ hostRepoId: String(id), fullName: repoFullNameSchema.parse(`stranger-co/${name}`) });
/** DELETE requests that reached the fake's uninstall endpoint. */
const removalCalls = (fake: FakeGitHub): number => fake.requests.filter((request) => request.method === "DELETE" && /^\/app\/installations\/\d+$/.test(request.path)).length;

const milestone4InstallationsFixture = (
  fake: FakeGitHub,
): Pick<CodeHostFixture, "manifestVisibility" | "installations" | "removal" | "installationWebhooks"> => ({
  manifestVisibility: (manifest) => ({ public: manifest["public"] === true, homepage: String(manifest["url"]) }),
  installations: {
    owner: { login: fake.org, accountId: String(fake.orgId) },
    stranger: { installationId: "91", accountLogin: "stranger-co", accountId: "9100" },
  },
  removal: { installationId: "92", unknownInstallationId: "404404", calls: () => removalCalls(fake) },
  installationWebhooks: [
    ...(["created", "deleted", "suspend", "unsuspend"] as const).map((action) => ({
      input: signed(fake, "installation", fake.installationPayload(action, 91)),
      expected: { kind: "installation" as const, action, installationId: "91", account: strangerRead },
    })),
    {
      input: signed(fake, "installation_repositories", fake.installationRepositoriesPayload("added", 91, ["api"])),
      expected: { kind: "installation_repositories" as const, action: "added", installationId: "91", account: strangerRead, reposAdded: [strangerRepo(3002, "api")], reposRemoved: [] },
    },
    {
      input: signed(fake, "installation_repositories", fake.installationRepositoriesPayload("removed", 91, ["api"])),
      expected: { kind: "installation_repositories" as const, action: "removed", installationId: "91", account: strangerRead, reposAdded: [], reposRemoved: [strangerRepo(3002, "api")] },
    },
  ],
});

const startFake = (): Promise<FakeGitHub> =>
  createFakeGitHub({
    repos: [
      {
        id: 1001,
        owner: "fake-org",
        name: "test1",
        defaultBranch: "main",
        files: {
          "package.json": '{ "name": "demo" }\n',
          ".github/pull_request_template.md": template,
          "src/index.ts": "export {};\n",
        },
        branches: ["main", "ostra/contract", "ostra/other", "ostra/third", "ostra/fourth", "ostra/classic", "ostra/review", "ostra/open", "ostra/drafts", "ostra/closing", "ostra/draft-token", "ostra/read-back"],
        protectedBranches: ["ostra/classic"],
        rulesets: {
          main: ["deletion", "required_signatures"],
          "ostra/review": ["pull_request"],
        },
        refs: ["refs/ostra/wip/task-contract"],
        compares,
      },
      { id: 1002, owner: "fake-org", name: "test2", defaultBranch: "main", files: { "secret.txt": "other repo\n" }, branches: ["main"] },
      // Private, in a free organization: rulesets and rules answer 403 "Upgrade to GitHub Pro".
      { id: 1003, owner: "fake-org", name: "free", defaultBranch: "main", files: {}, branches: ["main"], plan: "free" },
      // The rules endpoint refuses the App, as for a missing permission.
      { id: 1004, owner: "fake-org", name: "refused", defaultBranch: "main", files: {}, branches: ["main", "locked"], protectedBranches: ["locked"], rulesRefused: true },
      // Milestone 4 (F-136): repos on a stranger's account, which installed the public App.
      { id: 3001, owner: "stranger-co", name: "app", defaultBranch: "main", files: { "README.md": "stranger\n" }, branches: ["main"] },
      { id: 3002, owner: "stranger-co", name: "api", defaultBranch: "main", files: {}, branches: ["main"] },
    ],
    otherAccounts: [STRANGER, ANOTHER],
  });

const pullRequestPayload = (overrides: Readonly<Record<string, unknown>> = {}, pr: Readonly<Record<string, unknown>> = {}): string =>
  JSON.stringify({
    action: "closed",
    number: 12,
    installation: { id: 7 },
    repository: { id: 1001, full_name: "fake-org/test1" },
    pull_request: {
      number: 12,
      html_url: "https://github.example/fake-org/test1/pull/12",
      state: "closed",
      merged: true,
      merged_at: "2026-01-01T00:00:05Z",
      closed_at: "2026-01-01T00:00:05Z",
      updated_at: "2026-01-01T00:00:05Z",
      title: "a title",
      head: { ref: "ostra/contract", sha: "a".repeat(40) },
      base: { ref: "main" },
      ...pr,
    },
    ...overrides,
  });

// ---- milestone 4 (ticket 08, F-104): reviews, check runs, and the review webhooks ----

const REVIEWED_PR = 40;
const reviewedHead = "e".repeat(40);
const olderHead = "f".repeat(40);
const at = (minute: number): string => new Date(Date.UTC(2026, 10, 18, 12, minute)).toISOString();

/** A `pull_request_review` webhook's payload, as GitHub documents it ("Webhook events and payloads"), with a field ostra doesn't read. */
const reviewPayload = (input: { readonly action: "submitted" | "edited" | "dismissed"; readonly reviewId: number; readonly state: string; readonly userId: number; readonly login: string; readonly type: "User" | "Bot" }): string =>
  JSON.stringify({
    action: input.action,
    review: {
      id: input.reviewId,
      node_id: `PRR_${String(input.reviewId)}`,
      user: { login: input.login, id: input.userId, type: input.type, site_admin: false },
      body: "Looks good.",
      commit_id: reviewedHead,
      submitted_at: at(30),
      state: input.state,
      html_url: `https://github.example/fake-org/test1/pull/${String(REVIEWED_PR)}#pullrequestreview-${String(input.reviewId)}`,
      author_association: "MEMBER",
      a_field_github_adds_later: { anything: true },
    },
    pull_request: { number: REVIEWED_PR, title: "a PR", head: { ref: "ostra/contract", sha: reviewedHead }, base: { ref: "main" } },
    repository: { id: 1001, full_name: "fake-org/test1" },
    installation: { id: 7 },
    sender: { login: input.login, id: input.userId },
  });

const milestone4Fixture = (fake: FakeGitHub): Pick<CodeHostFixture, "reviews" | "checkRuns" | "reviewWebhooks"> => {
  const repo = "fake-org/test1";
  // Oldest first: a bot's comment, a person's approval since dismissed, a change request on an older head, and an approval.
  const bot = fake.addReview(repo, REVIEWED_PR, { userId: fake.botId, login: `${fake.appSlug}[bot]`, userType: "Bot", state: "COMMENTED", commitId: reviewedHead, submittedAt: at(1) });
  const dismissed = fake.addReview(repo, REVIEWED_PR, { userId: 583231, login: "octocat", userType: "User", state: "APPROVED", commitId: olderHead, submittedAt: at(2) });
  fake.dismissReview(dismissed.id);
  const changes = fake.addReview(repo, REVIEWED_PR, { userId: 583232, login: "hubot", userType: "User", state: "CHANGES_REQUESTED", commitId: olderHead, submittedAt: at(3) });
  const approved = fake.addReview(repo, REVIEWED_PR, { userId: 583233, login: "monalisa", userType: "User", state: "APPROVED", commitId: reviewedHead, submittedAt: at(4) });
  const expected = (review: FakeReview, state: PullRequestReview["state"]): PullRequestReview => ({
    reviewId: String(review.id),
    userId: String(review.userId),
    login: review.login,
    isBot: review.userType === "Bot",
    state,
    commitId: review.commitId,
    submittedAt: review.submittedAt === null ? null : Date.parse(review.submittedAt),
  });
  const synchronize = pullRequestPayload({ action: "synchronize", number: REVIEWED_PR }, { number: REVIEWED_PR, state: "open", merged: false, merged_at: null, closed_at: null, head: { ref: "ostra/contract", sha: reviewedHead } });
  return {
    reviews: { number: REVIEWED_PR, expected: [expected(bot, "commented"), expected(dismissed, "dismissed"), expected(changes, "changes_requested"), expected(approved, "approved")] },
    checkRuns: {
      headSha: reviewedHead,
      otherHeadSha: olderHead,
      read: (checkRunId) => {
        const run = fake.checkRuns.find((candidate) => String(candidate.id) === checkRunId);
        if (run === undefined) return Promise.resolve(undefined);
        const conclusion = run.conclusion === "success" || run.conclusion === "action_required" ? run.conclusion : null;
        const state: CheckRunState = run.status === "completed" && conclusion !== null ? { status: "completed", conclusion } : { status: "in_progress", conclusion: null };
        return Promise.resolve({ checkRunId, name: run.name, headSha: run.headSha, title: run.title ?? "", summary: run.summary ?? "", externalId: run.externalId ?? "", ...state });
      },
      count: (headSha, name) => Promise.resolve(fake.checkRuns.filter((run) => run.headSha === headSha && run.name === name).length),
    },
    reviewWebhooks: {
      submitted: {
        input: signed(fake, "pull_request_review", reviewPayload({ action: "submitted", reviewId: approved.id, state: "approved", userId: 583233, login: "monalisa", type: "User" })),
        number: REVIEWED_PR,
        headSha: reviewedHead,
        review: { reviewId: String(approved.id), userId: "583233", login: "monalisa", isBot: false, state: "approved", commitId: reviewedHead, submittedAt: Date.parse(at(30)) },
      },
      dismissed: {
        input: signed(fake, "pull_request_review", reviewPayload({ action: "dismissed", reviewId: dismissed.id, state: "dismissed", userId: 583231, login: "octocat", type: "User" })),
        number: REVIEWED_PR,
        reviewId: String(dismissed.id),
      },
      synchronize: { input: signed(fake, "pull_request", synchronize), number: REVIEWED_PR, headSha: reviewedHead },
    },
  };
};

const fixtureOf = (fake: FakeGitHub): CodeHostFixture => {
  const app = { appId: fake.appId, privateKey: fake.privateKey };
  const body = JSON.stringify({ action: "opened", number: 1 });
  const prBody = pullRequestPayload();
  return {
    app,
    wrongApp: { appId: fake.appId, privateKey: fake.wrongPrivateKey },
    installationId: fake.installationId,
    access: { app, installationId: fake.installationId, repo: test1 },
    defaultBranch: "main",
    file: { path: "package.json", content: '{ "name": "demo" }\n' },
    missingPath: ".env.example",
    prTemplate: template,
    prHead: "ostra/contract",
    webhook: { headers: { "X-Hub-Signature-256": fake.signWebhook(body) }, body, secret: fake.webhookSecret },
    // Node lowercases a request's header names; the suite's second case replaces `x-github-event`.
    pullRequestWebhook: {
      input: {
        headers: { "x-github-event": "pull_request", "x-github-delivery": "delivery-1", "x-hub-signature-256": fake.signWebhook(prBody) },
        body: prBody,
        secret: fake.webhookSecret,
      },
      number: 12,
      state: "merged",
    },
    deletableRef: "refs/ostra/wip/task-contract",
    branchRules: [
      { branch: "main", expected: { protected: true, requiresSignedCommits: true } },
      { branch: "ostra/contract", expected: { protected: false, requiresSignedCommits: false } },
      { branch: "ostra/review", expected: { protected: true, requiresSignedCommits: false } },
      { branch: "ostra/classic", expected: { protected: true, requiresSignedCommits: "unknown" } },
    ],
    ...milestone3Fixture(fake),
    ...milestone4Fixture(fake),
    ...milestone4InstallationsFixture(fake),
  };
};

// The code host contract suite, against the fake GitHub.
let suiteFake: FakeGitHub | undefined;
defineCodeHostContractSuite({
  name: "github, against a fake GitHub",
  create: async () => {
    suiteFake = await startFake();
    return {
      adapter: new GitHubAdapter({ apiUrl: suiteFake.apiUrl, webUrl: suiteFake.webUrl, oauthUrl: suiteFake.apiUrl }),
      fixture: fixtureOf(suiteFake),
      dispose: () => suiteFake?.close() ?? Promise.resolve(),
    };
  },
});

describe("the GitHub adapter", () => {
  let fake: FakeGitHub;
  const context = memoryAdapterContext();
  let adapter: GitHubAdapter;
  let fixture: CodeHostFixture;

  beforeAll(async () => {
    fake = await startFake();
    adapter = new GitHubAdapter({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, oauthUrl: fake.apiUrl }, context);
    fixture = fixtureOf(fake);
  });
  afterAll(async () => {
    await fake.close();
  });

  describe("the manifest", () => {
    const input = {
      name: "ostra acme",
      homepageUrl: "https://ostra.acme.dev",
      webhookUrl: "https://ostra.acme.dev/hooks/github/abc",
      redirectUrl: "https://ostra.acme.dev/setup/github/callback",
      ownerLogin: "acme",
    };

    it("F-006: asks for exactly the permissions GitHub accepted, `checks: write` and `actions: read` among them, and no `email_addresses` or `workflows`", () => {
      const { manifest } = adapter.appManifest(input);
      expect(manifest["default_permissions"]).toEqual({
        contents: "write",
        pull_requests: "write",
        checks: "write",
        actions: "read",
        issues: "read",
        statuses: "read",
        metadata: "read",
      });
      expect(JSON.stringify(manifest)).not.toContain("email_addresses");
      expect(JSON.stringify(manifest)).not.toContain("workflows");
    });

    it("F-006: sends the webhook and its events when the URL is public", () => {
      const { manifest } = adapter.appManifest(input);
      expect(manifest["hook_attributes"]).toEqual({ url: input.webhookUrl, active: true });
      expect(manifest["default_events"]).toContain("pull_request_review");
    });

    it("F-006: leaves out the webhook and its events for a loopback or private URL, which GitHub refuses", () => {
      for (const webhookUrl of [
        "http://localhost:8787/hooks/x",
        "http://127.0.0.1:8787/hooks/x",
        "http://192.168.1.5/hooks/x",
        "http://10.0.0.2/hooks/x",
        "http://core:8787/hooks/x",
        "http://ostra.local/hooks/x",
      ]) {
        const { manifest } = adapter.appManifest({ ...input, webhookUrl });
        expect(manifest, webhookUrl).not.toHaveProperty("hook_attributes");
        expect(manifest, webhookUrl).not.toHaveProperty("default_events");
      }
    });

    it("F-006: posts to the organization's page, or the admin's own", () => {
      expect(adapter.appManifest(input).createUrl).toBe("https://github.example/organizations/acme/settings/apps/new");
      expect(adapter.appManifest({ ...input, ownerLogin: null }).createUrl).toBe("https://github.example/settings/apps/new");
    });
  });

  describe("the manifest code", () => {
    it("trades the code for the App's credentials", async () => {
      const created = await adapter.convertManifestCode("good-code");
      expect(created).toMatchObject({
        ok: true,
        value: { appId: fake.appId, slug: fake.appSlug, webhookSecret: fake.webhookSecret, clientId: "Iv1.fakeclient" },
      });
      if (created.ok) {
        expect(created.value.privateKey).toBe(fake.privateKey);
      }
    });

    it("refuses a code that GitHub doesn't know, and one that isn't a code", async () => {
      expect(await adapter.convertManifestCode("stale-code")).toMatchObject({ ok: false, error: { code: "not-found" } });
      expect(await adapter.convertManifestCode("a b/../c")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    });

    it("never logs the one-time code", async () => {
      await adapter.convertManifestCode("good-code");
      expect(JSON.stringify(context.logger.records)).not.toContain("good-code");
    });
  });

  describe("tokens", () => {
    it("F-090: mints a token for one repo with only the permissions asked", async () => {
      const minted = await adapter.mintRepoToken(fixture.access, { contents: "write" });
      expect(minted.ok).toBe(true);
      if (!minted.ok) {
        return;
      }
      const scope = fake.tokens.get(minted.value.token);
      expect(scope?.repos).toEqual(["test1"]);
      expect(scope?.permissions).toEqual({ contents: "write" });
    });

    it("refuses a token with no permission", async () => {
      expect(await adapter.mintRepoToken(fixture.access, {})).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    });

    it("F-090: gives a token that can't read another repo of the installation", async () => {
      const minted = await adapter.mintRepoToken(fixture.access, { contents: "read", metadata: "read" });
      if (!minted.ok) {
        throw new Error("mint failed");
      }
      const headers = { authorization: `Bearer ${minted.value.token}`, "user-agent": "probe" };
      expect((await fetch(`${fake.apiUrl}/repos/fake-org/test1`, { headers })).status).toBe(200);
      expect((await fetch(`${fake.apiUrl}/repos/fake-org/test2`, { headers })).status).toBe(404);
    });

    it("F-090: asks only for the permissions each step needs", async () => {
      const before = fake.tokens.size;
      const { access } = fixture;
      await adapter.listTree(access, "main");
      await adapter.findPullRequest(access, "ostra/never-pushed");
      const minted = [...fake.tokens.values()].slice(before);
      for (const scope of minted) {
        expect(Object.values(scope.permissions)).not.toContain("write");
      }
    });
  });

  describe("reading a repo", () => {
    it("lists the repo's files", async () => {
      const tree = await adapter.listTree(fixture.access, "main");
      expect(tree).toEqual({ ok: true, value: ["package.json", ".github/pull_request_template.md", "src/index.ts"] });
    });

    it("reports a directory or a missing path as missing, and decodes content", async () => {
      const read = await adapter.readFiles(fixture.access, "main", ["package.json", "src", "nope.txt"]);
      expect(read).toEqual({
        ok: true,
        value: { files: [{ path: "package.json", content: '{ "name": "demo" }\n' }], missing: ["src", "nope.txt"] },
      });
    });

    it.each(["../etc/passwd", "/abs", "a//b", "a\\b", ""])("refuses the path %j before any call", async (path) => {
      const before = fake.requests.length;
      expect(await adapter.readFiles(fixture.access, "main", [path])).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(fake.requests.length).toBe(before);
    });

    it("answers not-found for a repo the installation can't see", async () => {
      const hidden = { ...fixture.access, repo: repoFullNameSchema.parse("fake-org/missing") };
      expect(await adapter.readFiles(hidden, "main", ["a"])).toMatchObject({ ok: false, error: { code: "not-found" } });
    });

    it("finds no template when the repo has none", async () => {
      const bare = { ...fixture.access, repo: test2 };
      expect(await adapter.getPullRequestTemplate(bare, "main")).toEqual({ ok: true, value: null });
    });

    it("reads the repo's other repo too, each with its own token", async () => {
      const second = { ...fixture.access, repo: test2 };
      expect(await adapter.readFiles(second, "main", ["secret.txt"])).toMatchObject({
        ok: true,
        value: { files: [{ path: "secret.txt" }] },
      });
    });
  });

  describe("the bot", () => {
    it("names the bot and its noreply email from the bot user's ID", async () => {
      expect(await adapter.getBotIdentity(fixture.app)).toEqual({
        ok: true,
        value: { name: `${fake.appSlug}[bot]`, email: `${String(fake.botId)}+${fake.appSlug}[bot]@users.noreply.github.com` },
      });
    });
  });

  describe("pull requests", () => {
    it("opens a PR with the agent's text as data, and finds it again", async () => {
      const body = "Fixes it.\n\n$(rm -rf /) `whoami` ; echo \"hi\" <script>alert(1)</script>";
      const title = `  a title with a ${"long ".repeat(80)}tail  `;
      const opened = await adapter.openPullRequest({
        access: fixture.access,
        head: "ostra/other",
        base: "main",
        title,
        body,
        draft: true,
      });
      expect(opened).toMatchObject({ ok: true, value: { state: "open", headBranch: "ostra/other", baseBranch: "main" } });
      const stored = fake.pulls.find((pr) => pr.head === "ostra/other");
      expect(stored?.body).toBe(body);
      expect(stored?.draft).toBe(true);
      expect(stored?.title.length).toBe(256);
      const found = await adapter.findPullRequest(fixture.access, "ostra/other");
      expect(found.ok && found.value?.number).toBe(opened.ok ? opened.value.number : -1);
    });

    it("F-030: changes a PR's body as the App, with the text as data, and refuses a PR that isn't there", async () => {
      const opened = await adapter.openPullRequest({ access: fixture.access, head: "ostra/fourth", base: "main", title: "Fourth", body: "first text", draft: false });
      if (!opened.ok) {
        throw new Error("open failed");
      }
      const body = "first text, then the task's other PRs: https://github.example/fake-org/test2/pull/9 `whoami`";
      const updated = await adapter.updatePullRequestBody({ access: fixture.access, number: opened.value.number, body });
      expect(updated).toMatchObject({ ok: true, value: { number: opened.value.number, state: "open" } });
      expect(fake.pulls.find((pr) => pr.number === opened.value.number)?.body).toBe(body);
      const write = [...fake.tokens.values()].at(-1);
      expect(write?.repos).toEqual(["test1"]);
      expect(write?.permissions).toEqual({ pull_requests: "write", metadata: "read" });
      expect(await adapter.updatePullRequestBody({ access: fixture.access, number: 9999, body })).toMatchObject({ ok: false, error: { code: "not-found" } });
    });

    it("answers conflict for a branch whose PR is open, without a second call to create", async () => {
      const posts = () => fake.requests.filter((request) => request.method === "POST" && request.path.endsWith("/pulls")).length;
      const input = { access: fixture.access, head: "ostra/third", base: "main", title: "third", body: "", draft: false };
      expect((await adapter.openPullRequest(input)).ok).toBe(true);
      const before = posts();
      expect(await adapter.openPullRequest(input)).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(posts()).toBe(before);
    });

    it("reads a merged PR as merged and a closed one as closed", async () => {
      const pr = fake.pulls.find((candidate) => candidate.head === "ostra/third");
      if (pr === undefined) {
        throw new Error("no PR");
      }
      fake.finishPullRequest("fake-org/test1", pr.number, "merged");
      expect(await adapter.findPullRequest(fixture.access, "ostra/third")).toMatchObject({ ok: true, value: { state: "merged" } });
      pr.merged = false;
      pr.mergedAt = null;
      expect(await adapter.findPullRequest(fixture.access, "ostra/third")).toMatchObject({ ok: true, value: { state: "closed" } });
    });

    it("refuses a PR with no title and a head that isn't pushed", async () => {
      const base = { access: fixture.access, base: "main", body: "", draft: false };
      expect(await adapter.openPullRequest({ ...base, head: "ostra/x", title: "   " })).toMatchObject({
        ok: false,
        error: { code: "invalid-input" },
      });
      expect(await adapter.openPullRequest({ ...base, head: "ostra/not-pushed", title: "t" })).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
    });
  });

  describe("branch rules (F-055, F-060)", () => {
    const on = (name: string) => ({ ...fixture.access, repo: repoFullNameSchema.parse(`fake-org/${name}`) });

    it("reads a ruleset's required_signatures as protected and signed, with no reason", async () => {
      expect(await adapter.readBranchRules(fixture.access, "main")).toEqual({
        ok: true,
        value: { protected: true, requiresSignedCommits: true, reasons: [] },
      });
    });

    it("reads a protective rule on its own as protected and not signed", async () => {
      expect(await adapter.readBranchRules(fixture.access, "ostra/review")).toMatchObject({
        ok: true,
        value: { protected: true, requiresSignedCommits: false, reasons: [] },
      });
    });

    it("reads an unprotected branch as false for both, since classic protection can't be there", async () => {
      expect(await adapter.readBranchRules(fixture.access, "ostra/contract")).toEqual({
        ok: true,
        value: { protected: false, requiresSignedCommits: false, reasons: [] },
      });
    });

    it("answers unknown, with the reason, for a classically protected branch no ruleset signs", async () => {
      const rules = await adapter.readBranchRules(fixture.access, "ostra/classic");
      expect(rules).toMatchObject({ ok: true, value: { protected: true, requiresSignedCommits: "unknown" } });
      expect(rules.ok && rules.value.reasons.join(" ")).toContain("administration");
    });

    it("answers false for both on a plan that has no rules, never unknown, and says so", async () => {
      expect(await adapter.readBranchRules(on("free"), "main")).toEqual({
        ok: true,
        value: { protected: false, requiresSignedCommits: false, reasons: ["GitHub doesn't offer branch rules on this repo's plan, so none apply."] },
      });
    });

    it("answers unknown, with the reason, when GitHub refuses the App the rulesets", async () => {
      expect(await adapter.readBranchRules(on("refused"), "main")).toMatchObject({
        ok: true,
        value: { protected: "unknown", requiresSignedCommits: "unknown" },
      });
      expect(await adapter.readBranchRules(on("refused"), "locked")).toMatchObject({
        ok: true,
        value: { protected: true, requiresSignedCommits: "unknown" },
      });
    });

    it("answers not-found for a branch that isn't there, and refuses a branch name with a control character", async () => {
      expect(await adapter.readBranchRules(fixture.access, "ostra/nope")).toMatchObject({ ok: false, error: { code: "not-found" } });
      expect(await adapter.readBranchRules(fixture.access, "a\nb")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(await adapter.readBranchRules(fixture.access, "")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    });

    it("asks for no permission beyond read, and never the administration permission", async () => {
      const before = fake.tokens.size;
      // A fresh adapter, since a minted token is cached.
      await new GitHubAdapter({ apiUrl: fake.apiUrl, webUrl: fake.webUrl }).readBranchRules(fixture.access, "main");
      const minted = [...fake.tokens.values()].slice(before);
      expect(minted.length).toBeGreaterThan(0);
      for (const scope of minted) {
        expect(Object.keys(scope.permissions)).not.toContain("administration");
        expect(Object.values(scope.permissions)).not.toContain("write");
      }
    });

    it("keeps the vendor's words out of the answer", async () => {
      const rules = await adapter.readBranchRules(on("free"), "main");
      expect(JSON.stringify(rules)).not.toMatch(/Upgrade to GitHub Pro|documentation_url/);
    });

    it("reads a rate-limited 403 as a wait, not as a refusal", async () => {
      fake.failures.push({ pathPattern: /\/rules\/branches\//, status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "120" }, times: 5 });
      const rules = await adapter.readBranchRules(fixture.access, "main");
      fake.failures.length = 0;
      expect(rules).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    });
  });

  describe("a PR by number (F-044)", () => {
    it("reads an open PR, a merged one with its times, and a closed one", async () => {
      const opened = await adapter.openPullRequest({ access: fixture.access, head: "ostra/open", base: "main", title: "by number", body: "", draft: false });
      if (!opened.ok) {
        throw new Error("open failed");
      }
      const open = await adapter.getPullRequest(fixture.access, opened.value.number);
      expect(open).toMatchObject({ ok: true, value: { state: "open", merged: false, mergedAt: null, closedAt: null, headBranch: "ostra/open", baseBranch: "main" } });
      expect(open.ok && open.value.headSha).toMatch(/^[0-9a-f]{40}$/);

      const merged = fake.finishPullRequest("fake-org/test1", opened.value.number, "merged");
      const after = await adapter.getPullRequest(fixture.access, opened.value.number);
      expect(after).toMatchObject({
        ok: true,
        value: { state: "merged", merged: true, mergedAt: Date.parse(merged.mergedAt ?? ""), closedAt: Date.parse(merged.closedAt ?? ""), updatedAt: Date.parse(merged.updatedAt) },
      });

      const second = fake.pulls.find((pr) => pr.head === "ostra/other");
      if (second === undefined) {
        throw new Error("no second PR");
      }
      fake.finishPullRequest("fake-org/test1", second.number, "closed");
      expect(await adapter.getPullRequest(fixture.access, second.number)).toMatchObject({
        ok: true,
        value: { state: "closed", merged: false, mergedAt: null },
      });
    });

    it("reads a reopened PR as open again", async () => {
      const pr = fake.pulls.find((candidate) => candidate.head === "ostra/other");
      if (pr === undefined) {
        throw new Error("no PR");
      }
      fake.reopenPullRequest("fake-org/test1", pr.number);
      expect(await adapter.getPullRequest(fixture.access, pr.number)).toMatchObject({ ok: true, value: { state: "open", closedAt: null } });
    });

    it("answers not-found for a PR that isn't there, and refuses a number that isn't one", async () => {
      expect(await adapter.getPullRequest(fixture.access, 99_999)).toMatchObject({ ok: false, error: { code: "not-found" } });
      expect(await adapter.getPullRequest(fixture.access, 0)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(await adapter.getPullRequest(fixture.access, 1.5)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    });
  });

  describe("pull_request webhooks (F-044)", () => {
    const hook = (action: string, state: "open" | "closed", pr: Readonly<Record<string, unknown>> = {}) => {
      const body = pullRequestPayload({ action }, { state, ...pr });
      return {
        headers: { "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": "d-9", "X-Hub-Signature-256": fake.signWebhook(body) },
        body,
        secret: fake.webhookSecret,
      };
    };

    it("reads closed-and-merged as merged, with the head, the repo's host ID and the PR's own time", () => {
      const input = hook("closed", "closed");
      expect(adapter.verifyWebhook(input)).toBe(true);
      expect(adapter.parseWebhook(input)).toEqual({
        ok: true,
        value: {
          kind: "pull_request",
          action: "closed",
          installationId: "7",
          hostRepoId: "1001",
          repo: test1,
          number: 12,
          state: "merged",
          headBranch: "ostra/contract",
          headSha: "a".repeat(40),
          changedAt: Date.parse("2026-01-01T00:00:05Z"),
        },
      });
    });

    it("reads closed without a merge as closed", () => {
      expect(adapter.parseWebhook(hook("closed", "closed", { merged: false, merged_at: null }))).toMatchObject({
        ok: true,
        value: { action: "closed", state: "closed" },
      });
    });

    it("reads reopened and synchronize as open", () => {
      for (const action of ["reopened", "synchronize"]) {
        expect(adapter.parseWebhook(hook(action, "open", { merged: false, merged_at: null, closed_at: null }))).toMatchObject({
          ok: true,
          value: { kind: "pull_request", action, state: "open" },
        });
      }
    });

    it("reads a header whatever its case, and takes no installation when the payload has none", () => {
      const body = pullRequestPayload({ installation: undefined });
      expect(adapter.parseWebhook({ headers: { "X-GITHUB-EVENT": "pull_request" }, body, secret: "" })).toMatchObject({
        ok: true,
        value: { installationId: null },
      });
    });

    it("tolerates fields GitHub adds", () => {
      const body = pullRequestPayload({ sender: { login: "x" }, brand_new: [1, 2, 3] }, { labels: [], something_else: { deep: true } });
      expect(adapter.parseWebhook({ headers: { "x-github-event": "pull_request" }, body, secret: "" }).ok).toBe(true);
    });

    it("answers other for an event it doesn't act on, without reading its body", () => {
      expect(adapter.parseWebhook({ headers: { "x-github-event": "check_suite" }, body: "not json at all", secret: "" })).toEqual({
        ok: true,
        value: { kind: "other", event: "check_suite" },
      });
    });

    it("answers invalid-response for no event header, a body that isn't JSON and a payload that doesn't match", () => {
      const headers = { "x-github-event": "pull_request" };
      expect(adapter.parseWebhook({ headers: {}, body: "{}", secret: "" })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
      expect(adapter.parseWebhook({ headers, body: "{", secret: "" })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
      expect(adapter.parseWebhook({ headers, body: JSON.stringify({ action: "closed" }), secret: "" })).toMatchObject({
        ok: false,
        error: { code: "invalid-response" },
      });
      const badTime = pullRequestPayload({}, { updated_at: "yesterday-ish" });
      expect(adapter.parseWebhook({ headers, body: badTime, secret: "" })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    });
  });

  describe("refs (F-079)", () => {
    it("deletes a hidden ref with a contents:write token for that repo only, and deleting it again is success", async () => {
      fake.refs.get("fake-org/test1")?.add("refs/ostra/wip/task-two");
      const before = fake.tokens.size;
      expect(await adapter.deleteRef(fixture.access, "refs/ostra/wip/task-two")).toEqual({ ok: true, value: { deleted: true } });
      expect(await adapter.deleteRef(fixture.access, "refs/ostra/wip/task-two")).toEqual({ ok: true, value: { deleted: false } });
      const minted = [...fake.tokens.values()].slice(before);
      expect(minted[0]?.repos).toEqual(["test1"]);
      expect(minted[0]?.permissions).toEqual({ contents: "write", metadata: "read" });
      expect(fake.refs.get("fake-org/test1")?.has("refs/ostra/wip/task-two")).toBe(false);
    });

    it("never deletes a branch, a tag or a path that climbs out", async () => {
      const before = fake.requests.length;
      for (const ref of ["refs/heads/main", "refs/tags/v1", "refs/ostra/../heads/main", "refs/ostra/", "ostra/wip/x", "refs/ostra/wip/a b", "refs/ostra/wip/x?y=1"]) {
        expect(await adapter.deleteRef(fixture.access, ref), ref).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      }
      expect(fake.requests.length).toBe(before);
    });

    it("answers not-found for a repo the installation can't see", async () => {
      const hidden = { ...fixture.access, repo: repoFullNameSchema.parse("fake-org/missing") };
      expect(await adapter.deleteRef(hidden, "refs/ostra/wip/x")).toMatchObject({ ok: false, error: { code: "not-found" } });
    });
  });

  describe("every request", () => {
    it("carries a User-Agent, and the fake refuses one with none", async () => {
      await adapter.readApp(fixture.app);
      await adapter.listRepos(fixture.app, fixture.installationId);
      expect(fake.requests.length).toBeGreaterThan(10);
      const ours = fake.requests.filter((request) => request.userAgent !== "probe");
      expect(ours.every((request) => request.userAgent?.includes("ostra-github-adapter") === true)).toBe(true);
      const bare = await fetch(`${fake.apiUrl}/rate_limit`, { headers: { "user-agent": "" } });
      expect(bare.status).toBe(403);
    });
  });

  describe("failures", () => {
    it("maps a wrong key to unauthorized, and an unreadable one to invalid-input, without echoing either", async () => {
      const wrong = await adapter.readApp(fixture.wrongApp);
      expect(wrong).toMatchObject({ ok: false, error: { code: "unauthorized" } });
      const garbage = "-----BEGIN RSA PRIVATE KEY-----\nTHE-BODY-OF-A-KEY-THAT-IS-NOT-ONE\n-----END RSA PRIVATE KEY-----";
      const unreadable = await adapter.readApp({ appId: fake.appId, privateKey: garbage });
      expect(unreadable).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      for (const result of [wrong, unreadable]) {
        const text = JSON.stringify(result);
        expect(text).not.toContain("THE-BODY-OF-A-KEY");
        expect(text).not.toContain("BEGIN RSA");
        expect(text).not.toContain(fake.privateKey.slice(40, 80));
      }
    });

    it("keeps a vendor's message, a token and a key out of every error and log line", async () => {
      fake.failures.push({ pathPattern: /^\/repos\/fake-org\/test1$/, status: 403 });
      const forbidden = await adapter.getDefaultBranch(fixture.access);
      expect(forbidden).toMatchObject({ ok: false, error: { code: "forbidden" } });
      const minted = await adapter.mintRepoToken(fixture.access, { contents: "read" });
      const token = minted.ok ? minted.value.token : "";
      expect(token).not.toBe("");
      const everything = JSON.stringify([forbidden, context.logger.records]);
      expect(everything).not.toContain("ghp_");
      expect(everything).not.toContain("injected");
      expect(everything).not.toContain(token);
      expect(everything).not.toContain(fake.privateKey.slice(40, 80));
    });

    it("retries a 5xx once and then succeeds", async () => {
      fake.failures.push({ pathPattern: /^\/app$/, status: 502 });
      const before = fake.requests.filter((request) => request.path === "/app").length;
      expect(await adapter.readApp(fixture.app)).toMatchObject({ ok: true });
      expect(fake.requests.filter((request) => request.path === "/app").length - before).toBe(2);
    });

    it("answers rate-limited, with the wait, when GitHub says so and a retry can't help", async () => {
      const limited = { status: 429, headers: { "retry-after": "120" }, times: 5 } as const;
      fake.failures.push({ pathPattern: /^\/app$/, ...limited });
      const result = await adapter.readApp(fixture.app);
      expect(result).toMatchObject({ ok: false, error: { code: "rate-limited", retryAfterMs: 120_000 } });
      fake.failures.length = 0;
    });

    it("answers unavailable when GitHub can't be reached, and health goes down", async () => {
      const dead = new GitHubAdapter({ apiUrl: "http://127.0.0.1:1" });
      expect(await dead.readApp(fixture.app)).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(await dead.health()).toMatchObject({ status: "down" });
    });
  });

  describe("the rate budget", () => {
    it("records what GitHub says, and holds a call back when the budget is spent", async () => {
      const store = context.rateBudgets;
      if (store === undefined) {
        throw new Error("the context has no rate budget store");
      }
      const key = `inst:${fake.appId}:${fake.installationId}`;
      await adapter.listTree(fixture.access, "main");
      expect(await store.get(key)).toMatchObject({ remaining: 4990, limit: 5000 });
      await store.set(key, { remaining: 0, limit: 5000, resetAt: context.clock.now() + 90_000 });
      const before = fake.requests.length;
      expect(await adapter.listTree(fixture.access, "main")).toMatchObject({
        ok: false,
        error: { code: "rate-limited", retryAfterMs: 90_000 },
      });
      expect(fake.requests.length).toBe(before);
      await store.set(key, { remaining: 4000, limit: 5000, resetAt: context.clock.now() + 90_000 });
    });
  });

  describe("compare (F-027, F-070)", () => {
    it("F-027: reads each file's status, rename, counts and patch, a binary file as whole, and the merge base", async () => {
      const compared = await adapter.compare(fixture.access, "main", "ostra/contract");
      if (!compared.ok) throw new Error(compared.error.message);
      expect(compared.value).toMatchObject({ aheadBy: 2, behindBy: 0, mergeBase: "b".repeat(40), filesTruncated: false, limits: { maxFiles: 300, maxPatchBytes: 512_000 } });
      expect(compared.value.files).toEqual([
        { path: "src/new.ts", previousPath: null, status: "added", additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c\n", truncated: false },
        { path: "src/moved.ts", previousPath: "src/old.ts", status: "renamed", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false },
        { path: "logo.png", previousPath: null, status: "modified", additions: 0, deletions: 0, patch: null, truncated: false },
        { path: "gone.md", previousPath: null, status: "removed", additions: 0, deletions: 4, patch: "@@ -1,4 +0,0 @@\n-a\n-b\n-c\n-d\n", truncated: false },
        // A status GitHub adds later reads as `changed`, never an error.
        { path: "odd.txt", previousPath: null, status: "changed", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+a\n", truncated: false },
      ]);
    });

    it("F-027: reports GitHub's limits: a patch it left out over 500 KB is truncated, and a list of 300 files is cut", async () => {
      const compared = await adapter.compare(fixture.access, "main", "ostra/review");
      if (!compared.ok) throw new Error(compared.error.message);
      expect(compared.value.filesTruncated).toBe(true);
      expect(compared.value.files).toHaveLength(300);
      expect(compared.value.files[0]).toEqual({ path: "huge.txt", previousPath: null, status: "modified", additions: 300_000, deletions: 0, patch: null, truncated: true });
      expect(compared.value.files.slice(1).every((file) => !file.truncated && file.patch !== null)).toBe(true);
    });

    it("F-027, F-070: compares with a read-only token for the one repo, reads how far behind a branch is, slashes in its name included", async () => {
      const fresh = new GitHubAdapter({ apiUrl: fake.apiUrl, webUrl: fake.webUrl });
      const before = fake.tokens.size;
      expect(await fresh.compare(fixture.access, "main", "ostra/third")).toMatchObject({ ok: true, value: { aheadBy: 2, behindBy: 1, files: [] } });
      const minted = [...fake.tokens.values()].slice(before);
      expect(minted.length).toBeGreaterThan(0);
      for (const scope of minted) {
        expect(scope.repos).toEqual(["test1"]);
        expect(scope.permissions).toEqual({ contents: "read", metadata: "read" });
      }
      expect(fake.requests.some((request) => request.path.startsWith("/repos/fake-org/test1/compare/"))).toBe(true);
    });

    it("F-027: refuses a ref that could change what's compared, and reports a missing one as not found", async () => {
      for (const ref of ["", "main...evil", "a..b", "x y", "a:b", "a\u0000b"]) {
        expect(await adapter.compare(fixture.access, ref, "main"), JSON.stringify(ref)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      }
      expect(await adapter.compare(fixture.access, "main", "no-such-branch")).toMatchObject({ ok: false, error: { code: "not-found" } });
    });
  });

  describe("drafts (F-054)", () => {
    it("F-054: makes a PR a draft and ready again through GraphQL, and an asked-for state already there writes nothing", async () => {
      const opened = await adapter.openPullRequest({ access: fixture.access, head: "ostra/drafts", base: "main", title: "drafts", body: "", draft: false });
      if (!opened.ok) throw new Error(opened.error.message);
      const { number } = opened.value;
      const before = fake.draftChanges();
      expect(await adapter.setPullRequestDraft(fixture.access, number, false)).toMatchObject({ ok: true, value: { number, draft: false } });
      expect(fake.draftChanges()).toBe(before);
      expect(await adapter.setPullRequestDraft(fixture.access, number, true)).toMatchObject({ ok: true, value: { number, draft: true } });
      expect(await adapter.setPullRequestDraft(fixture.access, number, true)).toMatchObject({ ok: true, value: { draft: true } });
      expect(fake.draftChanges()).toBe(before + 1);
      expect(fake.pulls.find((pr) => pr.number === number)?.draft).toBe(true);
      // The PR reads as a draft wherever it's read.
      expect(await adapter.findPullRequest(fixture.access, "ostra/drafts")).toMatchObject({ ok: true, value: { number, draft: true } });
      expect(await adapter.setPullRequestDraft(fixture.access, number, false)).toMatchObject({ ok: true, value: { draft: false } });
      expect(fake.draftChanges()).toBe(before + 2);
    });

    it("F-054: reads a PR's description as it is now and whether it's a draft, so a person's edits and drafts are kept", async () => {
      const opened = await adapter.openPullRequest({ access: fixture.access, head: "ostra/read-back", base: "main", title: "read back", body: "ostra's text", draft: true });
      if (!opened.ok) throw new Error(opened.error.message);
      const { number } = opened.value;
      expect(await adapter.getPullRequest(fixture.access, number)).toMatchObject({ ok: true, value: { number, draft: true, body: "ostra's text" } });
      // A person edits the description and marks it ready on GitHub.
      const pr = fake.pulls.find((candidate) => candidate.number === number);
      if (pr === undefined) throw new Error("no PR");
      pr.body = "ostra's text\n\nA person's note.";
      pr.draft = false;
      expect(await adapter.getPullRequest(fixture.access, number)).toMatchObject({ ok: true, value: { draft: false, body: "ostra's text\n\nA person's note." } });
    });

    it("F-054: switches with a token that can write contents and PRs, as GitHub's mutations need, and reads a refusal as forbidden", async () => {
      const opened = await adapter.openPullRequest({ access: fixture.access, head: "ostra/draft-token", base: "main", title: "draft token", body: "", draft: false });
      if (!opened.ok) throw new Error(opened.error.message);
      const fresh = new GitHubAdapter({ apiUrl: fake.apiUrl, webUrl: fake.webUrl });
      const before = fake.tokens.size;
      expect(await fresh.setPullRequestDraft(fixture.access, opened.value.number, true)).toMatchObject({ ok: true, value: { draft: true } });
      const minted = [...fake.tokens.values()].slice(before);
      expect(minted.map((scope) => scope.permissions)).toEqual([{ contents: "write", pull_requests: "write", metadata: "read" }]);
      expect(minted[0]?.repos).toEqual(["test1"]);
      // GitHub's GraphQL refuses with 200 and an error of type FORBIDDEN: the App's permissions, not a race.
      fake.failures.push({ pathPattern: /^\/graphql$/, method: "POST", status: 200, body: { data: { markPullRequestReadyForReview: null }, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] } });
      expect(await fresh.setPullRequestDraft(fixture.access, opened.value.number, false)).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(fake.pulls.find((pr) => pr.number === opened.value.number)?.draft).toBe(true);
    });

    it("F-054: refuses a closed PR, and a number that isn't a PR", async () => {
      const opened = await adapter.openPullRequest({ access: fixture.access, head: "ostra/closing", base: "main", title: "closing", body: "", draft: false });
      if (!opened.ok) throw new Error(opened.error.message);
      fake.finishPullRequest("fake-org/test1", opened.value.number, "closed");
      expect(await adapter.setPullRequestDraft(fixture.access, opened.value.number, true)).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await adapter.setPullRequestDraft(fixture.access, 0, true)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(await adapter.setPullRequestDraft(fixture.access, 4242, true)).toMatchObject({ ok: false, error: { code: "not-found" } });
    });
  });

  describe("PR comments and reactions (F-053)", () => {
    it("F-053: reads a comment on an issue as not on a PR, a line comment on the base's side, and a comment on a whole file", () => {
      const onIssue = adapter.parseWebhook(signed(fake, "issue_comment", issueCommentPayload({ commentId: "77", onPullRequest: false, body: "@ostra hi" })));
      expect(onIssue).toMatchObject({ ok: true, value: { kind: "issue_comment", onPullRequest: false, installationId: "7", hostRepoId: "1001", repo: "fake-org/test1" } });
      const left = adapter.parseWebhook(signed(fake, "pull_request_review_comment", reviewCommentPayload({ commentId: "78", side: "LEFT", line: 3 })));
      expect(left).toMatchObject({ ok: true, value: { side: "old", line: 3, comment: { authorLogin: "octocat", url: "https://github.example/fake-org/test1/pull/5#discussion_r78" } } });
      const onFile = adapter.parseWebhook(signed(fake, "pull_request_review_comment", reviewCommentPayload({ commentId: "79", side: "RIGHT", line: null, subjectType: "file" })));
      expect(onFile).toMatchObject({ ok: true, value: { path: "src/index.ts", line: null, side: "new" } });
    });

    it("F-053: reads who caused a comment's delivery apart from who wrote the comment", () => {
      const edited = (payload: string, sender: { readonly id: number; readonly login: string }): string => JSON.stringify({ ...JSON.parse(payload), action: "edited", sender });
      const stranger = { id: 900_001, login: "collaborator" };
      const issue = adapter.parseWebhook(signed(fake, "issue_comment", edited(issueCommentPayload({ commentId: "81", onPullRequest: true, body: "@ostra hi" }), stranger)));
      expect(issue).toMatchObject({ ok: true, value: { kind: "issue_comment", action: "edited", senderId: "900001", comment: { authorId: "583231" } } });
      const review = adapter.parseWebhook(signed(fake, "pull_request_review_comment", edited(reviewCommentPayload({ commentId: "82", side: "RIGHT", line: 3 }), stranger)));
      expect(review).toMatchObject({ ok: true, value: { kind: "pull_request_review_comment", action: "edited", senderId: "900001", comment: { authorId: "583231" } } });
      // A delivery that doesn't say who sent it is refused, not read as the author's.
      const noSender = issueCommentPayload({ commentId: "83", onPullRequest: true, body: "@ostra hi" }).replace(/,"sender":{[^}]*}/, "");
      expect(noSender).not.toContain("sender");
      expect(adapter.parseWebhook(signed(fake, "issue_comment", noSender))).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    });

    it("F-053: keeps a comment's body as data, exactly", () => {
      const body = "@ostra run `rm -rf /` $(whoami); echo \"done\"";
      const parsed = adapter.parseWebhook(signed(fake, "issue_comment", issueCommentPayload({ commentId: "80", onPullRequest: true, body })));
      expect(parsed.ok && parsed.value.kind === "issue_comment" && parsed.value.comment.body).toBe(body);
    });

    it("F-070: reads a push's changed paths once each, and none when the payload lists no commits", () => {
      const listed = adapter.parseWebhook(signed(fake, "push", pushPayload([{ added: ["a"], modified: ["a", "b"] }, { removed: ["b"] }])));
      expect(listed.ok && listed.value.kind === "push" && listed.value.changedPaths).toEqual(["a", "b"]);
      const none = adapter.parseWebhook(signed(fake, "push", pushPayload(null)));
      expect(none).toMatchObject({ ok: true, value: { kind: "push", changedPaths: null, before: "c".repeat(40) } });
      expect(adapter.parseWebhook(signed(fake, "push", JSON.stringify({ ref: "main", before: "a", after: "b", repository: { id: 1, full_name: "o/r" } })))).toMatchObject({
        ok: false,
        error: { code: "invalid-response" },
      });
    });

    it("F-053: reads a body that isn't JSON, or isn't the event it says, as invalid, and other events as other", () => {
      expect(adapter.parseWebhook(signed(fake, "issue_comment", "{nope"))).toMatchObject({ ok: false, error: { code: "invalid-response" } });
      expect(adapter.parseWebhook(signed(fake, "pull_request_review_comment", "{}"))).toMatchObject({ ok: false, error: { code: "invalid-response" } });
      expect(adapter.parseWebhook(signed(fake, "pull_request_review_thread", "{}"))).toEqual({ ok: true, value: { kind: "other", event: "pull_request_review_thread" } });
      // Milestone 4 reads the review event itself (ticket 08): an empty one is invalid, not other.
      expect(adapter.parseWebhook(signed(fake, "pull_request_review", "{}"))).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    });

    it("F-053: reacts 👀 to a line comment once, with a PR-scoped token, and refuses a comment that isn't there", async () => {
      const commentId = fake.addComment("fake-org/test1", "review");
      const fresh = new GitHubAdapter({ apiUrl: fake.apiUrl, webUrl: fake.webUrl });
      const before = fake.tokens.size;
      expect(await fresh.addReaction(fixture.access, { kind: "review", commentId }, "eyes")).toEqual({ ok: true, value: { created: true } });
      expect(await adapter.addReaction(fixture.access, { kind: "review", commentId }, "eyes")).toEqual({ ok: true, value: { created: false } });
      expect(fake.reactions().filter((key) => key.includes(`:review:${commentId}:`))).toEqual([`fake-org/test1:review:${commentId}:eyes`]);
      for (const scope of [...fake.tokens.values()].slice(before)) {
        expect(scope.permissions).toEqual({ pull_requests: "write", metadata: "read" });
      }
      // A conversation comment and a line comment are told apart: the same ID on the other kind isn't there.
      expect(await adapter.addReaction(fixture.access, { kind: "issue", commentId }, "eyes")).toMatchObject({ ok: false, error: { code: "not-found" } });
      expect(await adapter.addReaction(fixture.access, { kind: "issue", commentId: "../1" }, "eyes")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    });
  });

  describe("the verified link (F-119)", () => {
    it("F-119: sends the member to GitHub's sign-in with the App's client ID, the state and the callback, and no scope or secret", () => {
      const url = adapter.userAuthorizeUrl(fake.oauthClient, "state-abc", linkRedirect);
      if (!url.ok) throw new Error(url.error.message);
      const parsed = new URL(url.value);
      expect(`${parsed.origin}${parsed.pathname}`).toBe("https://github.example/login/oauth/authorize");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({ client_id: fake.oauthClient.clientId, redirect_uri: linkRedirect, state: "state-abc", allow_signup: "false" });
      expect(url.value).not.toContain(fake.oauthClient.clientSecret);
      expect(adapter.userAuthorizeUrl(fake.oauthClient, "", linkRedirect)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(adapter.userAuthorizeUrl(fake.oauthClient, "s", "javascript:alert(1)")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    });

    it("F-119: answers the account's ID and login, and holds no token after: the one it got is revoked", async () => {
      const code = fake.issueUserCode({ userId: "1234", login: "maya" }, { singleUse: true });
      const live = fake.liveUserTokens();
      const revoked = fake.revokedUserTokens();
      expect(await adapter.exchangeUserCode(fake.oauthClient, code, linkRedirect)).toEqual({ ok: true, value: { userId: "1234", login: "maya" } });
      expect(fake.liveUserTokens()).toBe(live);
      expect(fake.revokedUserTokens()).toBe(revoked + 1);
      // GitHub's code is used once.
      expect(await adapter.exchangeUserCode(fake.oauthClient, code, linkRedirect)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    });

    it("F-119: revokes the token even when reading the account fails, and links nothing", async () => {
      const code = fake.issueUserCode({ userId: "1235", login: "noor" });
      const live = fake.liveUserTokens();
      fake.failures.push({ pathPattern: /^\/user$/, method: "GET", status: 500 });
      expect(await adapter.exchangeUserCode(fake.oauthClient, code, linkRedirect)).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(fake.liveUserTokens()).toBe(live);
    });

    it("F-119: links nothing when the revocation fails, or the client or the callback is wrong", async () => {
      const code = fake.issueUserCode({ userId: "1236", login: "ida" }, { redirectUri: linkRedirect });
      fake.failRevocations(1);
      expect(await adapter.exchangeUserCode(fake.oauthClient, code, linkRedirect)).toMatchObject({ ok: false, error: { code: "unavailable" } });
      // A refusal that isn't a server failure links nothing either.
      fake.failRevocations(1, 422);
      expect(await adapter.exchangeUserCode(fake.oauthClient, code, linkRedirect)).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(await adapter.exchangeUserCode({ ...fake.oauthClient, clientSecret: "wrong" }, code, linkRedirect)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
      expect(await adapter.exchangeUserCode(fake.oauthClient, code, "https://elsewhere.example/cb")).toMatchObject({ ok: false, error: { code: "unauthorized" } });
      expect(await adapter.exchangeUserCode(fake.oauthClient, "bad code!", linkRedirect)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    });

    it("F-119: keeps the code, the client secret and the token out of every answer and log line", async () => {
      const code = fake.issueUserCode({ userId: "1237", login: "lee" });
      const answers = [await adapter.exchangeUserCode(fake.oauthClient, code, linkRedirect)];
      fake.failRevocations(1);
      answers.push(await adapter.exchangeUserCode(fake.oauthClient, code, linkRedirect));
      const everything = JSON.stringify([answers, context.logger.records]);
      expect(everything).not.toContain(code);
      expect(everything).not.toContain(fake.oauthClient.clientSecret);
      expect(everything).not.toContain("ghu_");
    });

    it("F-119: puts the link's callback in a new App's manifest", () => {
      const { manifest } = adapter.appManifest({
        name: "ostra acme",
        homepageUrl: "https://ostra.acme.dev/",
        webhookUrl: "https://ostra.acme.dev/hooks/github/abc",
        redirectUrl: "https://ostra.acme.dev/setup/github/callback",
        ownerLogin: "acme",
      });
      expect(manifest["callback_urls"]).toEqual(["https://ostra.acme.dev/api/auth/callback/github", "https://ostra.acme.dev/api/github/link/callback"]);
    });

    it("F-119: reads the member's ID and login from `GET /user` alone, and the App asks for no `email_addresses`", async () => {
      const code = fake.issueUserCode({ userId: "1238", login: "ana" });
      const before = fake.requests.length;
      expect(await adapter.exchangeUserCode(fake.oauthClient, code, linkRedirect)).toEqual({ ok: true, value: { userId: "1238", login: "ana" } });
      expect(fake.requests.slice(before).map((request) => `${request.method} ${request.path}`)).toEqual([
        "POST /login/oauth/access_token",
        "GET /user",
        `DELETE /applications/${fake.oauthClient.clientId}/token`,
      ]);
      const { manifest } = adapter.appManifest({ name: "ostra", homepageUrl: "https://ostra.acme.dev", webhookUrl: "https://ostra.acme.dev/hooks/github/abc", redirectUrl: "https://ostra.acme.dev/setup/github/callback", ownerLogin: null });
      expect(manifest["default_permissions"]).toMatchObject({ pull_requests: "write" });
      expect(manifest["default_permissions"]).not.toHaveProperty("email_addresses");
      const url = adapter.userAuthorizeUrl(fake.oauthClient, "state", linkRedirect);
      expect(url.ok && new URL(url.value).searchParams.has("scope")).toBe(false);
    });
  });

  describe("webhooks", () => {
    it("refuses a missing, malformed or wrong signature, and an empty secret", () => {
      const { webhook } = fixture;
      expect(adapter.verifyWebhook({ ...webhook, headers: {} })).toBe(false);
      expect(adapter.verifyWebhook({ ...webhook, headers: { "x-hub-signature-256": "sha1=abc" } })).toBe(false);
      expect(adapter.verifyWebhook({ ...webhook, headers: { "x-hub-signature-256": "sha256=zz" } })).toBe(false);
      expect(adapter.verifyWebhook({ ...webhook, secret: "" })).toBe(false);
      expect(adapter.verifyWebhook(webhook)).toBe(true);
    });
  });

  describe("capabilities", () => {
    it("declares check runs, PR templates, exactly the LFS hosts of Q119, and milestone 3's compare, drafts, PR comments and link", () => {
      expect(adapter.capabilities).toEqual({
        checkRuns: true,
        prTemplates: true,
        lfsActionHosts: ["github-cloud.githubusercontent.com", "github-cloud.s3.amazonaws.com", "lfs.github.com"],
        branchRules: true,
        // Milestone 3 (ticket 09).
        compare: true,
        draftPullRequests: true,
        prComments: true,
        userLink: true,
        // Milestone 4 (ticket 08).
        reviews: true,
        // Milestone 4 (ticket 47).
        installableByOtherAccounts: true,
        // Milestone 6: none yet, until its ticket 08.
        ciResults: false,
        ciLogs: false,
        reviewComments: false,
        requestedReviewers: false,
        codeOwners: false,
      });
    });
  });

  // ---- milestone 4 (ticket 08, F-104, ADR 0040) ----
  describe("installations on other accounts (F-136)", () => {
    const input = {
      name: "ostra acme",
      homepageUrl: "https://ostra.acme.dev",
      webhookUrl: "https://ostra.acme.dev/hooks/github/abc",
      redirectUrl: "https://ostra.acme.dev/setup/github/callback",
      ownerLogin: "acme",
    };

    it("F-136: the manifest is private with the panel as homepage by default or when asked, and public with ostra's project page when asked; the OAuth callbacks stay the install's", () => {
      for (const asked of [{}, { public: false }] as const) {
        const { manifest } = adapter.appManifest({ ...input, ...asked });
        expect(manifest["public"]).toBe(false);
        expect(manifest["url"]).toBe(input.homepageUrl);
      }
      const { manifest } = adapter.appManifest({ ...input, public: true });
      expect(manifest["public"]).toBe(true);
      expect(manifest["url"]).toBe(OSTRA_PROJECT_URL);
      expect(OSTRA_PROJECT_URL).not.toContain("acme");
      // Sign-in and the verified link still come back to this install.
      expect(manifest["callback_urls"]).toEqual([`${input.homepageUrl}/api/auth/callback/github`, `${input.homepageUrl}/api/github/link/callback`]);
      expect(manifest["redirect_url"]).toBe(input.redirectUrl);
    });

    it("F-136: reads the App's owner and each installation's account ID; a stranger's installation mints tokens for its own repos only", async () => {
      expect(await adapter.readApp(fixture.app)).toMatchObject({ ok: true, value: { owner: { login: "fake-org", accountId: "6001" } } });
      const listed = await adapter.listInstallations(fixture.app);
      expect(listed.ok && listed.value.find((item) => item.installationId === "91")).toEqual({
        installationId: "91",
        accountLogin: "stranger-co",
        accountId: "9100",
        accountKind: "organization",
        repositorySelection: "selected",
      });
      expect(listed.ok && listed.value.find((item) => item.installationId === fake.installationId)?.accountId).toBe("6001");
      const repos = await adapter.listRepos(fixture.app, "91");
      expect(repos.ok && repos.value.map((repo) => repo.fullName)).toEqual(["stranger-co/app", "stranger-co/api"]);
      const own = await adapter.listRepos(fixture.app, fake.installationId);
      expect(own.ok && own.value.map((repo) => repo.fullName)).not.toContain("stranger-co/app");
      const strangers = { app: fixture.app, installationId: "91", repo: repoFullNameSchema.parse("stranger-co/app") };
      expect(await adapter.getDefaultBranch(strangers)).toEqual({ ok: true, value: "main" });
      expect((await adapter.getDefaultBranch({ ...strangers, repo: test1 })).ok).toBe(false);
    });

    it("F-136: a removal sends one DELETE /app/installations/{id} as the App; an unknown or removed one is not-found, and a malformed ID never reaches GitHub", async () => {
      const removable = await createFakeGitHub({ repos: [], otherAccounts: [ANOTHER] });
      try {
        const local = new GitHubAdapter({ apiUrl: removable.apiUrl, webUrl: removable.webUrl, oauthUrl: removable.apiUrl });
        const app = { appId: removable.appId, privateKey: removable.privateKey };
        expect(await local.removeInstallation(app, "92")).toEqual({ ok: true, value: undefined });
        expect(removable.requests.filter((request) => request.method === "DELETE")).toEqual([expect.objectContaining({ path: "/app/installations/92" })]);
        expect(removable.removedInstallations()).toEqual([92]);
        const listed = await local.listInstallations(app);
        expect(listed.ok && listed.value.map((item) => item.installationId)).toEqual([removable.installationId]);
        expect(await local.removeInstallation(app, "92")).toMatchObject({ ok: false, error: { code: "not-found" } });
        expect(await local.removeInstallation(app, "404404")).toMatchObject({ ok: false, error: { code: "not-found" } });
        expect(await local.removeInstallation({ ...app, privateKey: removable.wrongPrivateKey }, "7")).toMatchObject({ ok: false, error: { code: "unauthorized" } });
        const before = removable.requests.length;
        for (const malformed of ["", "0", "12a", "../7", "-1"]) {
          expect(await local.removeInstallation(app, malformed), malformed).toMatchObject({ ok: false, error: { code: "invalid-input" } });
        }
        expect(removable.requests.length).toBe(before);
        expect(removable.removedInstallations()).toEqual([92]);
      } finally {
        await removable.close();
      }
    });

    it("F-136: the fake's second App answers as its own App: its owner, its one installation, and tokens for its owner's repos only", async () => {
      const owner = { login: "globex", id: 9_300, type: "Organization", installationId: 93 } as const;
      const two = await createFakeGitHub({
        repos: [
          { id: 1, owner: "fake-org", name: "test1", defaultBranch: "main", branches: ["main"], files: {} },
          { id: 2, owner: "globex", name: "shop", defaultBranch: "main", branches: ["main"], files: {} },
        ],
        secondApp: { slug: "globex-ostra", owner },
      });
      try {
        const local = new GitHubAdapter({ apiUrl: two.apiUrl, webUrl: two.webUrl, oauthUrl: two.apiUrl });
        const secondApp = two.secondApp;
        if (secondApp === null) throw new Error("the fake was started with a second App");
        const app = { appId: secondApp.appId, privateKey: secondApp.privateKey };
        expect(await local.readApp(app)).toMatchObject({ ok: true, value: { slug: "globex-ostra", owner: { login: "globex", accountId: "9300" } } });
        const listed = await local.listInstallations(app);
        expect(listed.ok && listed.value.map((item) => item.installationId)).toEqual(["93"]);
        const repos = await local.listRepos(app, "93");
        expect(repos.ok && repos.value.map((repo) => repo.fullName)).toEqual(["globex/shop"]);
        // Neither App reaches the other's installation, and the first App's own doesn't reach globex.
        expect((await local.listRepos(app, two.installationId)).ok).toBe(false);
        const first = { appId: two.appId, privateKey: two.privateKey };
        expect((await local.listRepos(first, "93")).ok).toBe(false);
        const own = await local.listRepos(first, two.installationId);
        expect(own.ok && own.value.map((repo) => repo.fullName)).toEqual(["fake-org/test1"]);
        // Its own bot, as GitHub names an App's bot by its slug.
        const bot = await local.getBotIdentity(app);
        expect(bot.ok && bot.value.name).toBe("globex-ostra[bot]");
        // The second App's key signed for the first App's ID is refused.
        expect((await local.readApp({ appId: two.appId, privateKey: secondApp.privateKey })).ok).toBe(false);
      } finally {
        await two.close();
      }
    });

    it("F-136: reads each installation event from GitHub's documented payloads, whatever GitHub adds, and refuses one it can't read", () => {
      // GitHub's example payloads ("Webhook events and payloads": installation, installation_repositories), trimmed, with a field ostra doesn't read.
      const account = { login: "octocat", id: 1, node_id: "MDQ6VXNlcjE=", type: "User", site_admin: false, a_field_github_adds_later: true };
      const installation = {
        id: 1,
        account,
        repository_selection: "selected",
        access_tokens_url: "https://api.github.com/app/installations/1/access_tokens",
        app_id: 1,
        target_id: 1,
        target_type: "User",
        permissions: { metadata: "read", contents: "read" },
        events: ["push", "pull_request"],
        suspended_by: null,
        suspended_at: null,
      };
      const repo = { id: 1296269, node_id: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5", name: "Hello-World", full_name: "octocat/Hello-World", private: false };
      const read: InstallationAccount = { accountId: "1", login: "octocat", kind: "user" };
      for (const action of ["created", "deleted", "suspend", "unsuspend", "new_permissions_accepted"]) {
        const body = JSON.stringify({ action, installation, repositories: [repo], requester: null, sender: account });
        expect(adapter.parseWebhook(signed(fake, "installation", body)), action).toEqual({ ok: true, value: { kind: "installation", action, installationId: "1", account: read } });
      }
      const added = JSON.stringify({ action: "added", installation, repository_selection: "selected", repositories_added: [repo], repositories_removed: [], requester: null, sender: account });
      const hello = { hostRepoId: "1296269", fullName: repoFullNameSchema.parse("octocat/Hello-World") };
      expect(adapter.parseWebhook(signed(fake, "installation_repositories", added))).toEqual({
        ok: true,
        value: { kind: "installation_repositories", action: "added", installationId: "1", account: read, reposAdded: [hello], reposRemoved: [] },
      });
      const removed = JSON.stringify({ action: "removed", installation, repository_selection: "selected", repositories_added: [], repositories_removed: [repo], sender: account });
      expect(adapter.parseWebhook(signed(fake, "installation_repositories", removed))).toMatchObject({ ok: true, value: { action: "removed", reposAdded: [], reposRemoved: [hello] } });
      // An organization's account reads as one; a webhook with no account, or a repo name that isn't one, is refused.
      const orgBody = JSON.stringify({ action: "created", installation: { ...installation, id: 5, account: { ...account, type: "Organization" } } });
      expect(adapter.parseWebhook(signed(fake, "installation", orgBody))).toMatchObject({ ok: true, value: { installationId: "5", account: { kind: "organization" } } });
      expect(adapter.parseWebhook(signed(fake, "installation", JSON.stringify({ action: "created", installation: { id: 1 } })))).toMatchObject({ ok: false, error: { code: "invalid-response" } });
      const badRepo = JSON.stringify({ action: "added", installation, repositories_added: [{ ...repo, full_name: "not a repo" }] });
      expect(adapter.parseWebhook(signed(fake, "installation_repositories", badRepo))).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    });
  });

  describe("reviews and check runs", () => {
    const repo = "fake-org/test1";
    const head = "1".repeat(40);
    const access = (): CodeHostFixture["access"] => fixture.access;

    it("F-104: lists every page of a PR's reviews, oldest first, each with its author's ID and login, whether a bot wrote it, its lower-cased state, commit and time", async () => {
      const number = 41;
      for (let index = 0; index < 130; index += 1) {
        fake.addReview(repo, number, {
          userId: 600_000 + index,
          login: `reviewer-${String(index)}`,
          userType: index === 0 ? "Bot" : "User",
          state: index === 129 ? "APPROVED" : "COMMENTED",
          commitId: head,
          submittedAt: new Date(Date.UTC(2026, 10, 18, 12, 0, index)).toISOString(),
        });
      }
      const pending = fake.addReview(repo, number, { userId: 700_001, login: "drafty", userType: "User", state: "PENDING", commitId: head, submittedAt: null });
      const listed = await adapter.listReviews(access(), number);
      if (!listed.ok) throw new Error(listed.error.message);
      expect(listed.value).toHaveLength(131);
      expect(listed.value[0]).toMatchObject({ userId: "600000", login: "reviewer-0", isBot: true, state: "commented", commitId: head, submittedAt: Date.UTC(2026, 10, 18, 12, 0, 0) });
      expect(listed.value[0]?.reviewId).toMatch(/^\d+$/);
      expect(listed.value[129]).toMatchObject({ userId: "600129", isBot: false, state: "approved" });
      expect(listed.value[130]).toEqual({ reviewId: String(pending.id), userId: "700001", login: "drafty", isBot: false, state: "pending", commitId: head, submittedAt: null });
      // Oldest first, as GitHub lists them, across its pages of 100.
      expect(listed.value.map((review) => review.login).slice(98, 102)).toEqual(["reviewer-98", "reviewer-99", "reviewer-100", "reviewer-101"]);
      expect(fake.requests.filter((request) => request.path === `/repos/${repo}/pulls/${String(number)}/reviews`)).toHaveLength(2);
      expect(await adapter.listReviews(access(), 0)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(await adapter.listReviews(access(), 9999)).toMatchObject({ ok: false, error: { code: "not-found" } });
    });

    it("F-104: publishes a check run with a token for the one repo and `checks: write`, in progress with no conclusion, its words and its external ID", async () => {
      const before = new Set(fake.tokens.keys());
      const published = await adapter.publishCheckRun(access(), {
        name: "ostra/independent-review",
        headSha: head,
        status: "in_progress",
        conclusion: null,
        title: "Waiting for an independent reviewer",
        summary: "A member who didn't drive the task approves the PR's current head.",
        externalId: "task-repo-123",
      });
      if (!published.ok) throw new Error(published.error.message);
      const run = fake.checkRuns.find((candidate) => String(candidate.id) === published.value.checkRunId);
      expect(run).toMatchObject({ repo, name: "ostra/independent-review", headSha: head, status: "in_progress", conclusion: null, title: "Waiting for an independent reviewer", externalId: "task-repo-123", appId: Number(fake.appId) });
      const minted = [...fake.tokens.entries()].filter(([token]) => !before.has(token)).map(([, scope]) => scope);
      expect(minted).toEqual([expect.objectContaining({ repos: ["test1"], permissions: { checks: "write", metadata: "read" } })]);
      // Completed with a conclusion, then back: each a PATCH of the same run.
      expect(await adapter.updateCheckRun(access(), published.value.checkRunId, { name: "ostra/independent-review", headSha: head, status: "completed", conclusion: "success", title: "Approved", summary: "monalisa approved this head.", externalId: "task-repo-123" })).toEqual({ ok: true, value: undefined });
      expect(run).toMatchObject({ status: "completed", conclusion: "success", title: "Approved", summary: "monalisa approved this head." });
      expect(fake.checkRuns.filter((candidate) => candidate.headSha === head && candidate.name === "ostra/independent-review")).toHaveLength(1);
    });

    it("F-104: refuses a check run on a head that isn't a commit SHA, or with no name, before calling GitHub; an unknown run is not-found", async () => {
      const input = { name: "ostra/independent-review", headSha: head, status: "in_progress", conclusion: null, title: "t", summary: "s", externalId: "x" } as const;
      const calls = fake.requests.length;
      expect(await adapter.publishCheckRun(access(), { ...input, headSha: "main" })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(await adapter.publishCheckRun(access(), { ...input, name: " " })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(await adapter.updateCheckRun(access(), "not-a-number", input)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(fake.requests.length).toBe(calls);
      expect(await adapter.updateCheckRun(access(), "999999", input)).toMatchObject({ ok: false, error: { code: "not-found" } });
    });

    it("F-104: reads a review webhook whatever GitHub adds to it, a bot's review as a bot's, and refuses one it can't read", () => {
      const body = (review: Readonly<Record<string, unknown>>): string =>
        JSON.stringify({
          action: "submitted",
          review: { id: 9, user: { id: fake.botId, login: `${fake.appSlug}[bot]`, type: "Bot" }, state: "commented", commit_id: head, submitted_at: "2026-11-18T12:00:00Z", ...review },
          pull_request: { number: 3, head: { sha: head }, extra: [1, 2] },
          repository: { id: 1001, full_name: repo },
          installation: { id: 7 },
          enterprise: { id: 1 },
        });
      expect(adapter.parseWebhook(signed(fake, "pull_request_review", body({})))).toEqual({
        ok: true,
        value: {
          kind: "pull_request_review",
          action: "submitted",
          installationId: "7",
          hostRepoId: "1001",
          repo,
          number: 3,
          headSha: head,
          review: { reviewId: "9", userId: String(fake.botId), login: `${fake.appSlug}[bot]`, isBot: true, state: "commented", commitId: head, submittedAt: Date.parse("2026-11-18T12:00:00Z") },
        },
      });
      expect(adapter.parseWebhook(signed(fake, "pull_request_review", body({ state: "a-state-github-never-sent" })))).toMatchObject({ ok: false, error: { code: "invalid-response" } });
      expect(adapter.parseWebhook(signed(fake, "pull_request_review", "not json"))).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    });
  });

  // The review harness, ported from spikes/github-app-and-git-proxy/src/harness/review-local.ts: the
  // reviews the independent-review check reads past, as the adapter reads them from the fake GitHub,
  // and the webhook's signature. The evaluator itself is the domain's (`packages/domain`, ticket 06).
  describe("the review harness (spike 4)", () => {
    const repo = "fake-org/test1";
    const head = "a".repeat(40);
    const old = "b".repeat(40);
    const minute = (m: number): string => new Date(Date.UTC(2026, 10, 18, 12, m)).toISOString();

    it("F-104: reads each review the check tells apart: the App's own comment, the driver's approval, another member's, one of an older commit, one withdrawn by a change request", async () => {
      const number = 42;
      const add = (login: string, userId: number, state: string, commitId: string, m: number, userType: "User" | "Bot" = "User") =>
        fake.addReview(repo, number, { userId, login, userType, state, commitId, submittedAt: minute(m) });
      add(`${fake.appSlug}[bot]`, fake.botId, "COMMENTED", head, 1, "Bot");
      add("driver", 1, "APPROVED", head, 2);
      add("reviewer", 2, "APPROVED", old, 3);
      add("reviewer", 2, "APPROVED", head, 4);
      add("reviewer", 2, "CHANGES_REQUESTED", head, 5);
      add("other", 3, "APPROVED", head, 6);
      add("other", 3, "COMMENTED", head, 7);
      const listed = await adapter.listReviews(fixture.access, number);
      if (!listed.ok) throw new Error(listed.error.message);
      expect(listed.value.map((review) => [review.login, review.isBot, review.state, review.commitId === head ? "head" : "old"])).toEqual([
        [`${fake.appSlug}[bot]`, true, "commented", "head"],
        ["driver", false, "approved", "head"],
        ["reviewer", false, "approved", "old"],
        ["reviewer", false, "approved", "head"],
        ["reviewer", false, "changes_requested", "head"],
        ["other", false, "approved", "head"],
        ["other", false, "commented", "head"],
      ]);
      // In order, so a later change request reads as withdrawing the earlier approval.
      expect(listed.value.map((review) => review.submittedAt)).toEqual([...listed.value.map((review) => review.submittedAt)].sort((a, b) => (a ?? 0) - (b ?? 0)));
    });

    it("F-104: a correctly signed pull_request_review webhook is read; one with a bad signature or none is refused", () => {
      const body = JSON.stringify({
        action: "submitted",
        review: { id: 1, state: "approved", user: { id: 2, login: "reviewer", type: "User" }, commit_id: head, submitted_at: minute(1) },
        pull_request: { number: 7, head: { sha: head } },
        repository: { id: 1001, full_name: repo },
        installation: { id: 7 },
      });
      const good = signed(fake, "pull_request_review", body);
      expect(adapter.verifyWebhook(good)).toBe(true);
      expect(adapter.parseWebhook(good)).toMatchObject({ ok: true, value: { kind: "pull_request_review", number: 7, review: { login: "reviewer", state: "approved" } } });
      expect(adapter.verifyWebhook({ ...good, headers: { ...good.headers, "x-hub-signature-256": `sha256=${createHmac("sha256", "not-the-secret").update(body).digest("hex")}` } })).toBe(false);
      expect(adapter.verifyWebhook({ ...good, headers: { "x-github-event": "pull_request_review" } })).toBe(false);
    });
  });
});

describe("the configuration reference", () => {
  it("F-090: names the hosts each code host's LFS actions may call, and says a cleaned-up task's LFS objects stay", async () => {
    const text = await readFile(new URL("../../../../docs/configuration.md", import.meta.url), "utf8");
    const line = (start: string): string => text.split("\n").find((row) => row.startsWith(start)) ?? "";
    const hostsIn = (row: string): readonly string[] => [...row.matchAll(/`([a-z0-9.*-]+\.[a-z]{2,})`/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    // One line per code host: GitHub.com's lists exactly the adapter's hosts, a GHES install its own.
    expect(hostsIn(line("| GitHub.com |"))).toEqual([...GITHUB_COM_LFS_ACTION_HOSTS]);
    expect(line("| GitHub Enterprise Server |")).toContain("`OSTRA_GITHUB_LFS_HOSTS`");
    expect(line("| `OSTRA_GITHUB_LFS_HOSTS` |")).toContain(`| \`${GITHUB_COM_LFS_ACTION_HOSTS.join(",")}\` |`);
    expect(text).toContain("LFS objects of a cleaned-up task stay in the code host's storage");
    // And the adapter calls what the setting lists: GitHub.com's by default, a GHES install's when set.
    expect(new GitHubAdapter().capabilities.lfsActionHosts).toEqual([...GITHUB_COM_LFS_ACTION_HOSTS]);
    expect(new GitHubAdapter({ lfsActionHosts: ["lfs.ghes.example.com"] }).capabilities.lfsActionHosts).toEqual(["lfs.ghes.example.com"]);
  });
});
