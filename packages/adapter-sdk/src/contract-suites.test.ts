import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { organizationIdSchema, repoFullNameSchema } from "@ostra/protocol";
import { fixtureIds, taskSpecFixture } from "@ostra/protocol/testing";

import { memoryAdapterContext, memorySecretRowStore } from "./testing/memory.ts";
import { defineAgentContractSuite } from "./testing/agent-suite.ts";
import { defineCodeHostContractSuite } from "./testing/code-host-suite.ts";
import type { CodeHostFixture } from "./testing/code-host-suite.ts";
import { createFakeRepoTrees, movedSkillTree } from "./testing/fake-repo-trees.ts";
import type { FakeRepoTrees } from "./testing/fake-repo-trees.ts";
import type { BoxRef } from "./executor/base.ts";
import { TASK_TOKEN_FILE } from "./executor/task-token.ts";
import { defineExecutorContractSuite } from "./testing/executor-suite.ts";
import type { ExecutorFixture, FleetFixture } from "./testing/executor-suite.ts";
import { defineBlobStoreFirstCases } from "./testing/blob-store-suite.ts";
import { defineNotificationContractSuite, suiteRecipient } from "./testing/notification-suite.ts";
import { createJiraFakeSuiteSubject } from "./testing/jira-fake.ts";
import { FakeCiHost } from "./testing/fake-ci-host.ts";
import {
  defineTrackerContractSuite,
  defineTrackerFilesSuite,
  defineTrackerFirstCases,
  defineTrackerMentionSuite,
  defineTrackerMilestone6Suite,
} from "./testing/tracker-suite.ts";
import { defineModelProviderContractSuite } from "./testing/model-provider-suite.ts";
import { defineSecretStoreContractSuite } from "./testing/secret-store-suite.ts";
import {
  killTree,
  scriptedDriver,
  signWebhook,
  TinyAgent,
  TinyBlobStore,
  TinyCodeHost,
  TinyExecutor,
  TinyModelProvider,
  TinyNotifier,
  TinySecretStore,
  TinyTracker,
} from "./test-adapters/tiny-adapters.ts";

// Every contract suite, run against this package's tiny adapters: the suites pass against an
// adapter that does what its kind promises.

defineTrackerFirstCases({ name: "tiny tracker", create: () => Promise.resolve({ adapter: new TinyTracker(), fixture: {} }) });
defineTrackerContractSuite({
  name: "the Jira fake",
  create: () => {
    const { adapter, fixture } = createJiraFakeSuiteSubject();
    return Promise.resolve({ adapter, fixture });
  },
});
for (const channel of ["panel", "email"] as const) {
  defineNotificationContractSuite({
    name: `tiny notifier, ${channel}`,
    create: () => {
      const context = memoryAdapterContext();
      const adapter = new TinyNotifier(channel, context);
      return Promise.resolve({
        adapter,
        fixture: {
          reachable: suiteRecipient("ada", { email: true, mention: true }),
          alsoReachable: suiteRecipient("grace", { email: true, mention: false }),
          // The panel reaches every member; email can't reach one with no address.
          ...(channel === "email" ? { refused: suiteRecipient("nomail", { email: false, mention: false }) } : {}),
          rateLimitNext: () => {
            adapter.rateLimitNext(2000);
          },
          delivered: () => Promise.resolve(adapter.delivered),
          logs: () => context.logger.records,
        },
      });
    },
  });
}

defineTrackerMentionSuite({
  name: "tiny tracker",
  create: () => {
    const adapter = new TinyTracker();
    return Promise.resolve({
      adapter,
      fixture: {
        board: { externalId: "tiny-board" },
        seedUser: (email: string) => {
          const userId = `tiny-user-${String(adapter.users.length + 1)}`;
          adapter.users.push({ email, userId });
          return Promise.resolve({ userId });
        },
      },
    });
  },
});
defineTrackerFilesSuite({
  name: "tiny tracker, ticketFiles none",
  create: () => {
    const adapter = new TinyTracker();
    const board = { externalId: "tiny-board" };
    const host = "https://tiny-tracker.invalid/files";
    return Promise.resolve({
      adapter,
      fixture: {
        board,
        ownUserId: null,
        files: {
          // The ticket's text links files the tracker might hold: a `none` adapter lists none of them.
          seedTicketWithFiles: () => {
            const seeded = adapter.seedTicket({
              title: "With files",
              description: `![mock.png](${host}/1/mock.png)\n\n[spec.docx](${host}/2/spec.docx)`,
            });
            return Promise.resolve({
              ...seeded,
              descriptionImage: `${host}/1/mock.png`,
              descriptionFile: `${host}/2/spec.docx`,
              commentId: "no-comment",
              commentImage: `${host}/3/broken.png`,
              attachedFile: `${host}/4/design.pdf`,
              linkAttachment: "https://www.figma.com/file/0196f1a0/History",
              spareImage: `${host}/5/progress.png`,
            });
          },
          followUpText: () =>
            Promise.resolve({
              text: `Also these: ![follow-up.png](${host}/6/follow-up.png) [numbers.xlsx](${host}/7/numbers.xlsx) [elsewhere](https://files.example.test/8/numbers.xlsx)`,
              image: `${host}/6/follow-up.png`,
              file: `${host}/7/numbers.xlsx`,
              offHost: "https://files.example.test/8/numbers.xlsx",
            }),
        },
      },
    });
  },
});
defineTrackerMilestone6Suite({
  name: "tiny tracker",
  create: () => {
    const adapter = new TinyTracker();
    return Promise.resolve({
      adapter,
      fixture: {
        board: { externalId: "tiny-board" },
        hooks: {
          seedPerson: (person: { readonly name: string; readonly email: string }) => {
            const userId = `tiny-user-${String(adapter.users.length + 1)}`;
            adapter.users.push({ email: person.email, userId, name: person.name });
            return Promise.resolve({ userId });
          },
        },
      },
    });
  },
});
defineBlobStoreFirstCases({
  name: "tiny blob store",
  create: () => Promise.resolve({ adapter: new TinyBlobStore(), fixture: {} }),
});

const repo = repoFullNameSchema.parse("test-org/test1");
const app = { appId: "42", privateKey: "-----BEGIN TEST KEY-----", slug: "ostra-tiny", name: "ostra tiny" };
const webhookBody = JSON.stringify({ action: "opened", number: 1 });
const pullRequestBody = JSON.stringify({
  action: "closed",
  installation: { id: 7 },
  repository: { id: 1001, full_name: "test-org/test1" },
  pull_request: { number: 3, state: "closed", merged: true, updated_at: "2026-11-19T10:00:00Z", head: { ref: "ostra/contract", sha: "a".repeat(40) } },
});

// Milestone 3: the three new webhooks, in GitHub's shape, and a compare's files.
const issueCommentBody = JSON.stringify({
  action: "created",
  installation: { id: 7 },
  repository: { id: 1001, full_name: "test-org/test1" },
  issue: { number: 3, pull_request: { url: "https://code-host.invalid/pulls/3" } },
  comment: { id: 5001, body: "@ostra add a test", html_url: "https://code-host.invalid/test-org/test1/pull/3#c5001", user: { id: 777, login: "member" } },
  sender: { id: 777, login: "member" },
});
const reviewCommentBody = JSON.stringify({
  action: "created",
  installation: { id: 7 },
  repository: { id: 1001, full_name: "test-org/test1" },
  pull_request: { number: 3 },
  comment: { id: 5002, body: "@ostra rename this", html_url: "https://code-host.invalid/r/5002", user: { id: 777, login: "member" }, path: "src/a.ts", side: "RIGHT", line: 12 },
  sender: { id: 777, login: "member" },
});
const pushBody = JSON.stringify({
  ref: "refs/heads/main",
  before: "1".repeat(40),
  after: "2".repeat(40),
  installation: { id: 7 },
  repository: { id: 1001, full_name: "test-org/test1" },
  commits: [{ added: ["pnpm-lock.yaml"], modified: ["package.json"], removed: [] }, { modified: ["package.json"] }],
});
// Milestone 4 (ticket 03): a review submitted, one dismissed, and a new head, in GitHub's shape.
const reviewBody = (action: string, id: number, state: string) =>
  JSON.stringify({
    action,
    installation: { id: 7 },
    repository: { id: 1001, full_name: "test-org/test1" },
    pull_request: { number: 3, head: { sha: "4".repeat(40) } },
    review: { id, user: { id: 888, login: "grace", type: "User" }, state, commit_id: "4".repeat(40), submitted_at: "2026-11-19T10:00:00Z" },
  });
const synchronizeBody = JSON.stringify({
  action: "synchronize",
  installation: { id: 7 },
  repository: { id: 1001, full_name: "test-org/test1" },
  pull_request: { number: 3, state: "open", merged: false, updated_at: "2026-11-19T10:05:00Z", head: { ref: "ostra/contract", sha: "5".repeat(40) } },
});

// Milestone 4 (ticket 47, F-136): a stranger's installation, in GitHub's shape.
const strangerAccount = { login: "stranger-co", id: 9_100, node_id: "O_stranger", type: "Organization", site_admin: false };
const installationBody = (action: string, id: number, account: Readonly<Record<string, unknown>>) =>
  JSON.stringify({
    action,
    installation: { id, account, repository_selection: "selected", app_id: 1, target_type: "Organization", suspended_at: action === "suspend" ? "2026-11-19T10:00:00Z" : null },
    repositories: [{ id: 3001, node_id: "R_3001", name: "app", full_name: "stranger-co/app", private: true }],
    requester: null,
    sender: { login: "stranger-admin", id: 9_101, type: "User" },
  });
const installationReposBody = (action: "added" | "removed", id: number, account: Readonly<Record<string, unknown>>) => {
  const repos = [{ id: 3002, node_id: "R_3002", name: "api", full_name: "stranger-co/api", private: true }];
  return JSON.stringify({
    action,
    installation: { id, account, repository_selection: "selected" },
    repository_selection: "selected",
    repositories_added: action === "added" ? repos : [],
    repositories_removed: action === "removed" ? repos : [],
    requester: null,
    sender: { login: "stranger-admin", id: 9_101, type: "User" },
  });
};
const strangerRead = { accountId: "9100", login: "stranger-co", kind: "organization" } as const;
const strangerRepo = { hostRepoId: "3002", fullName: repoFullNameSchema.parse("stranger-co/api") };

const signed = (event: string, body: string) => ({
  headers: { "x-hub-signature-256": signWebhook("hook-secret", body), "x-github-event": event },
  body,
  secret: "hook-secret",
});
const smallFile = { path: "src/a.ts", previousPath: null, status: "modified" as const, additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" };
const oauthClient = { clientId: "Iv1.tiny", clientSecret: "tiny-client-secret" };
const linkedUser = { userId: "777", login: "member" };

// Milestone 6 (ticket 03): GitHub's CI and review-request webhooks, in its shape.
const ciRepository = { id: 1001, full_name: "test-org/test1" };
const ciHead = "8".repeat(40);
const checkRunBody = JSON.stringify({ action: "completed", installation: { id: 7 }, repository: ciRepository, check_run: { id: 70_001, head_sha: ciHead, app: { slug: "github-actions" } } });
const checkSuiteBody = JSON.stringify({ action: "completed", installation: { id: 7 }, repository: ciRepository, check_suite: { id: 71_001, head_sha: ciHead, app: { slug: "circleci-checks" } } });
const statusBody = JSON.stringify({ installation: { id: 7 }, repository: ciRepository, sha: ciHead, context: "ci/jenkins", state: "pending" });
const reviewRequestBody = (action: "review_requested" | "review_request_removed") =>
  JSON.stringify({
    action,
    installation: { id: 7 },
    repository: ciRepository,
    pull_request: { number: 3, state: "open", merged: false, updated_at: "2026-11-20T10:00:00Z", head: { ref: "ostra/contract", sha: ciHead } },
    requested_reviewer: { id: 888, login: "grace" },
  });
const ciHint = (event: "check_run" | "check_suite" | "status", appSlug: string | null) =>
  ({ kind: "ci", event, action: event === "status" ? null : "completed", installationId: "7", hostRepoId: "1001", repo, headSha: ciHead, appSlug }) as const;
const reviewersHint = (action: "review_requested" | "review_request_removed") =>
  ({ kind: "pull_request_reviewers", action, installationId: "7", hostRepoId: "1001", repo, number: 3, headSha: ciHead }) as const;
const ciWebhooks = [
  { input: signed("check_run", checkRunBody), expected: ciHint("check_run", "github-actions") },
  { input: signed("check_suite", checkSuiteBody), expected: ciHint("check_suite", "circleci-checks") },
  { input: signed("status", statusBody), expected: ciHint("status", null) },
  { input: signed("pull_request", reviewRequestBody("review_requested")), expected: reviewersHint("review_requested") },
  { input: signed("pull_request", reviewRequestBody("review_request_removed")), expected: reviewersHint("review_request_removed") },
];

/** A CI log with a line no error may carry, and a character of more than one byte near the cut. */
const ciLogText = ["##[group]Run pnpm test", "TOKEN-LIKE-LINE do-not-echo-0b7f", "FAIL src/banner.test.ts > shows the name", "Expected: \"Ada\"", "Received: \"Adé\"", "##[error]Process completed with exit code 1."].join("\n");

/**
 * The tiny code host's suite. Without `ci` it declares none of milestone 6's capabilities; with
 * it, it's the fake code host, and holds the CI, reviews, reviewers and `CODEOWNERS` the suite reads.
 */
/** Milestone 8 (ticket 02): the suite's view of the fake's repos read at a commit. */
const treesFixture = (trees: FakeRepoTrees): NonNullable<CodeHostFixture["trees"]> => {
  const [publicRepo, privateRepo] = trees.repos;
  if (publicRepo === undefined || privateRepo === undefined) throw new Error("the fake has its two repos");
  return {
    publicRepo: publicRepo.fullName,
    branch: publicRepo.defaultBranch,
    privateRepo: privateRepo.fullName,
    moveBranch: () => {
      trees.commit(publicRepo.fullName, publicRepo.defaultBranch, movedSkillTree);
      return Promise.resolve();
    },
  };
};

const defineTinyCodeHostSuite = (name: string, withCi: boolean): void => {
defineCodeHostContractSuite({
  name,
  create: async () => {
    const ci = withCi ? new FakeCiHost() : undefined;
    // Milestone 8 (ticket 02): the fake code host reads repos at a commit; the tiny one declares it can't.
    const trees = withCi ? createFakeRepoTrees("test-org") : undefined;
    const host = new TinyCodeHost({
      app,
      installationId: "7",
      repos: [
        {
          hostRepoId: "1001",
          fullName: repo,
          defaultBranch: "main",
          files: { "package.json": "{}", ".github/pull_request_template.md": "## What\n" },
          branches: ["main", "ostra/contract", "signed", "ostra/reviewed", "ostra/commented"],
          rules: {
            main: { protected: true, requiresSignedCommits: false, reasons: [] },
            signed: { protected: true, requiresSignedCommits: true, reasons: [] },
          },
          refs: ["refs/ostra/wip/contract-task"],
          compares: {
            "main...ostra/ahead": { aheadBy: 2, behindBy: 0, mergeBase: "3".repeat(40), files: [smallFile] },
            "main...ostra/behind": { aheadBy: 0, behindBy: 4, mergeBase: "3".repeat(40), files: [] },
            "main...ostra/diverged": { aheadBy: 1, behindBy: 3, mergeBase: "3".repeat(40), files: [smallFile] },
            "main...ostra/huge": {
              aheadBy: 1,
              behindBy: 0,
              mergeBase: "3".repeat(40),
              files: [
                { path: "big.json", previousPath: null, status: "added", additions: 50_000, deletions: 0, patch: "+x\n".repeat(400) },
                smallFile,
                { path: "src/b.ts", previousPath: "src/old-b.ts", status: "renamed", additions: 0, deletions: 0, patch: null },
              ],
            },
          },
        },
      ],
      // Small limits, so the suite can see them applied.
      compareLimits: { maxFiles: 2, maxPatchBytes: 1024 },
      oauth: { client: oauthClient, users: [{ code: "sign-in-code", user: linkedUser }] },
      otherInstallations: [
        { installationId: "91", accountLogin: "stranger-co", accountId: "9100", accountKind: "organization", repositorySelection: "selected" },
        { installationId: "92", accountLogin: "another-co", accountId: "9200", accountKind: "organization", repositorySelection: "all" },
      ],
    }, { ...(ci === undefined ? {} : { ci }), ...(trees === undefined ? {} : { trees }) });
    // Milestone 4: a PR with reviews: a changes request later dismissed, a bot's comment and an approval.
    const reviewed = await host.openPullRequest({
      access: { app: { appId: app.appId, privateKey: app.privateKey }, installationId: "7", repo },
      head: "ostra/reviewed",
      base: "main",
      title: "Reviewed",
      body: "",
      draft: false,
    });
    if (!reviewed.ok) throw new Error(reviewed.error.message);
    const reviewedNumber = reviewed.value.number;
    const asked = host.reviewsAndChecks.addReview(repo, reviewedNumber, { userId: "888", login: "grace", isBot: false, state: "changes_requested", commitId: "1".repeat(40), submittedAt: 1_000 });
    host.reviewsAndChecks.addReview(repo, reviewedNumber, { userId: "999", login: "ci-helper[bot]", isBot: true, state: "commented", commitId: "1".repeat(40), submittedAt: 2_000 });
    host.reviewsAndChecks.addReview(repo, reviewedNumber, { userId: "777", login: "ada", isBot: false, state: "approved", commitId: "1".repeat(40), submittedAt: 3_000 });
    host.reviewsAndChecks.dismissReview(repo, reviewedNumber, asked.reviewId);
    // Milestone 6: other apps' CI on a head, a diff, requested reviewers and CODEOWNERS.
    const milestone6 =
      ci === undefined
        ? {}
        : await (async () => {
            // Its own PR, so the review the suite posts doesn't join milestone 4's reviewed PR's list.
            const commented = await host.openPullRequest({
              access: { app: { appId: app.appId, privateKey: app.privateKey }, installationId: "7", repo },
              head: "ostra/commented",
              base: "main",
              title: "Commented",
              body: "",
              draft: false,
            });
            if (!commented.ok) throw new Error(commented.error.message);
            const commentedNumber = commented.value.number;
            const actions = ci.addCheckRun(repo, { headSha: ciHead, name: "test", appSlug: "github-actions", status: "completed", conclusion: "failure", detailsUrl: "https://code-host.invalid/runs/1", startedAt: 1_000, completedAt: 2_000, log: { text: ciLogText } });
            const queued = ci.addCheckRun(repo, { headSha: ciHead, name: "deploy-preview", appSlug: "vercel", status: "queued", conclusion: null });
            const expired = ci.addCheckRun(repo, { headSha: ciHead, name: "lint", appSlug: "github-actions", status: "completed", conclusion: "success", log: "expired" });
            ci.setStatus(repo, ciHead, { context: "ci/jenkins", state: "pending", targetUrl: "https://jenkins.invalid/job/1", description: "Waiting for an executor" });
            ci.setStatus(repo, ciHead, { context: "ci/legacy", state: "success", targetUrl: null, description: "Passed" });
            const diff = [{ path: "src/banner.ts", new: [{ start: 10, end: 14 }], old: [{ start: 10, end: 12 }] }];
            ci.setDiff(repo, commentedNumber, diff);
            ci.requestReviewers(repo, commentedNumber, { users: [{ userId: "888", login: "grace" }], teams: [{ slug: "web-reviewers" }] });
            ci.setFile(repo, "main", ".github/CODEOWNERS", "* @test-org/web-reviewers\n");
            ci.setFile(repo, "ostra/contract", "docs/CODEOWNERS", "/docs/ @grace\n");
            const runView = (run: typeof actions) => ({ id: run.id, name: run.name, appSlug: run.appSlug, status: run.status, conclusion: run.conclusion, detailsUrl: run.detailsUrl, startedAt: run.startedAt, completedAt: run.completedAt });
            return {
              ci: {
                headSha: ciHead,
                expected: { checkRuns: [runView(actions), runView(queued), runView(expired)], statuses: ci.statuses(repo, ciHead) },
              },
              ciLogs: {
                checkRunId: actions.id,
                log: ciLogText,
                secretLine: "TOKEN-LIKE-LINE do-not-echo-0b7f",
                expiredCheckRunId: expired.id,
                status: { headSha: ciHead, context: "ci/jenkins", words: "Waiting for an executor" },
              },
              commentReview: {
                number: commentedNumber,
                headSha: "1".repeat(40),
                expectedLines: diff,
                onDiff: { path: "src/banner.ts", line: 12, side: "new" as const, body: "**Blocking:** the name isn't escaped" },
                offDiff: { path: "src/banner.ts", line: 40, side: "new" as const, body: "**Nit:** a far line" },
                reviewCount: () => Promise.resolve(ci.reviews(repo, commentedNumber).length),
              },
              requestedReviewers: { number: commentedNumber, expected: { users: [{ userId: "888", login: "grace" }], teams: [{ slug: "web-reviewers" }] } },
              codeOwners: {
                first: { ref: "main", text: "* @test-org/web-reviewers\n" },
                later: { ref: "ostra/contract", text: "/docs/ @grace\n" },
                none: "ostra/reviewed",
              },
            };
          })();
    return {
      adapter: host,
      fixture: {
        ...milestone6,
        ciWebhooks,
        app: { appId: app.appId, privateKey: app.privateKey },
        wrongApp: { appId: app.appId, privateKey: "wrong" },
        installationId: "7",
        access: { app: { appId: app.appId, privateKey: app.privateKey }, installationId: "7", repo },
        defaultBranch: "main",
        file: { path: "package.json", content: "{}" },
        missingPath: ".env.example",
        prTemplate: "## What\n",
        prHead: "ostra/contract",
        webhook: {
          headers: { "x-hub-signature-256": signWebhook("hook-secret", webhookBody) },
          body: webhookBody,
          secret: "hook-secret",
        },
        branchRules: [
          { branch: "main", expected: { protected: true, requiresSignedCommits: false } },
          { branch: "signed", expected: { protected: true, requiresSignedCommits: true } },
          { branch: "ostra/contract", expected: { protected: false, requiresSignedCommits: false } },
        ],
        pullRequestWebhook: {
          input: {
            headers: { "x-hub-signature-256": signWebhook("hook-secret", pullRequestBody), "x-github-event": "pull_request" },
            body: pullRequestBody,
            secret: "hook-secret",
          },
          number: 3,
          state: "merged",
        },
        deletableRef: "refs/ostra/wip/contract-task",
        compare: {
          ahead: { base: "main", head: "ostra/ahead", aheadBy: 2, behindBy: 0 },
          behind: { base: "main", head: "ostra/behind", aheadBy: 0, behindBy: 4 },
          diverged: { base: "main", head: "ostra/diverged", aheadBy: 1, behindBy: 3 },
          truncated: { base: "main", head: "ostra/huge", path: "big.json" },
        },
        commentWebhooks: {
          issueComment: { input: signed("issue_comment", issueCommentBody), number: 3, commentId: "5001", authorId: "777", body: "@ostra add a test" },
          reviewComment: { input: signed("pull_request_review_comment", reviewCommentBody), number: 3, commentId: "5002", path: "src/a.ts", line: 12, side: "new" },
          push: { input: signed("push", pushBody), ref: "refs/heads/main", after: "2".repeat(40), changedPaths: ["pnpm-lock.yaml", "package.json"] },
        },
        comment: { kind: "issue", commentId: "5001" },
        userLink: {
          client: oauthClient,
          code: "sign-in-code",
          redirectUri: "http://localhost:3000/api/github/link/callback",
          user: linkedUser,
          revokedTokens: () => host.userTokens.revoked,
          failNextRevocation: () => {
            host.failNextRevocation = true;
          },
        },
        reviews: {
          number: reviewedNumber,
          expected: [
            { reviewId: asked.reviewId, userId: "888", login: "grace", isBot: false, state: "dismissed", commitId: "1".repeat(40), submittedAt: 1_000 },
            { reviewId: "review-2", userId: "999", login: "ci-helper[bot]", isBot: true, state: "commented", commitId: "1".repeat(40), submittedAt: 2_000 },
            { reviewId: "review-3", userId: "777", login: "ada", isBot: false, state: "approved", commitId: "1".repeat(40), submittedAt: 3_000 },
          ],
        },
        checkRuns: {
          headSha: "6".repeat(40),
          otherHeadSha: "7".repeat(40),
          read: (checkRunId) => Promise.resolve(host.reviewsAndChecks.checkRun(checkRunId)),
          count: (headSha, name) => Promise.resolve(host.reviewsAndChecks.checkRuns(repo, headSha, name).length),
        },
        reviewWebhooks: {
          submitted: {
            input: signed("pull_request_review", reviewBody("submitted", 6001, "approved")),
            number: 3,
            headSha: "4".repeat(40),
            review: { reviewId: "6001", userId: "888", login: "grace", isBot: false, state: "approved", commitId: "4".repeat(40), submittedAt: Date.parse("2026-11-19T10:00:00Z") },
          },
          dismissed: { input: signed("pull_request_review", reviewBody("dismissed", 6002, "dismissed")), number: 3, reviewId: "6002" },
          synchronize: { input: signed("pull_request", synchronizeBody), number: 3, headSha: "5".repeat(40) },
        },
        manifestVisibility: (manifest) => ({ public: manifest["public"] === true, homepage: String(manifest["url"]) }),
        installations: {
          owner: { login: "test-org", accountId: "5001" },
          stranger: { installationId: "91", accountLogin: "stranger-co", accountId: "9100" },
        },
        removal: { installationId: "92", unknownInstallationId: "404404", calls: () => host.installationRemovals },
        ...(trees === undefined ? {} : { trees: treesFixture(trees) }),
        installationWebhooks: [
          ...(["created", "deleted", "suspend", "unsuspend"] as const).map((action) => ({
            input: signed("installation", installationBody(action, 91, strangerAccount)),
            expected: { kind: "installation" as const, action, installationId: "91", account: strangerRead },
          })),
          {
            input: signed("installation_repositories", installationReposBody("added", 91, strangerAccount)),
            expected: { kind: "installation_repositories" as const, action: "added", installationId: "91", account: strangerRead, reposAdded: [strangerRepo], reposRemoved: [] },
          },
          {
            input: signed("installation_repositories", installationReposBody("removed", 91, strangerAccount)),
            expected: { kind: "installation_repositories" as const, action: "removed", installationId: "91", account: strangerRead, reposAdded: [], reposRemoved: [strangerRepo] },
          },
        ],
      },
    };
  },
});
};
defineTinyCodeHostSuite("tiny code host", false);
defineTinyCodeHostSuite("the fake code host (the tiny host with CI, reviews and reviewers)", true);

defineAgentContractSuite({
  name: "tiny agent on a scripted driver",
  create: () =>
    Promise.resolve({
      adapter: new TinyAgent(scriptedDriver()),
      fixture: {
        launchInput: {
          taskId: fixtureIds.task,
          sessionId: fixtureIds.session,
          workspaceDir: path.join(tmpdir(), "ostra-tiny-workspace"),
          agentDir: path.join(tmpdir(), "ostra-tiny-agent"),
          model: {
            endpointModelId: "test-model",
            apiFormat: "anthropic-messages",
            baseUrl: "http://127.0.0.1:9/key-proxy",
            placeholderKey: "placeholder-for-this-task",
          },
          mcp: { url: "http://127.0.0.1:9/mcp" },
          instructions: null,
          extraEnv: { NODE_ENV: "test" },
        },
        secrets: ["the-real-model-token", "the-real-git-token"],
        start: () =>
          Promise.resolve({
            io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
            stop: () => Promise.resolve(),
          }),
        simplePrompt: "simple",
        longPrompt: "long",
      },
    }),
});

const nodeLaunch = (cwd: string, script: string) => ({
  command: process.execPath,
  args: ["-e", script],
  cwd,
  env: { PATH: process.env["PATH"] ?? "" },
  files: [],
});

const isAlive = (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, 0);
    return Promise.resolve(true);
  } catch (error) {
    return Promise.resolve(Reflect.get(Object(error), "code") === "EPERM");
  }
};

/** The tiny executor's fixture, shared by its plain run and its fleet run. */
const tinyExecutorFixture = (fleet?: FleetFixture): ExecutorFixture => ({
  spec: { ...taskSpecFixture, environment: { ...taskSpecFixture.environment, setupScript: "console.log('set up')" } },
  failingSetupSpec: {
    ...taskSpecFixture,
    environment: { ...taskSpecFixture.environment, setupScript: "process.exit(3)" },
  },
  proxies: { gitBaseUrl: "http://127.0.0.1:9/git", modelBaseUrl: "http://127.0.0.1:9/model", mcpUrl: "http://127.0.0.1:9/mcp" },
  echoLaunch: (box) => nodeLaunch(box.workspaceDir, "process.stdin.pipe(process.stdout)"),
  // Milestone 3: the tiny executor's checks are JavaScript, as its setup script is.
  checks: {
    passing: "process.exit(0)",
    failing: "process.exit(3)",
    slow: "setTimeout(() => {}, 60000)",
    printsEnv: "console.log(JSON.stringify(process.env))",
    noisy: "console.log('first line'); for (let i = 0; i < 400; i++) console.log('x'.repeat(60) + ' ' + i); console.log('the last line')",
  },
  detachedHelper: {
    // The agent starts a helper in its own session or console, writes its PID, and exits: the
    // helper is an orphan that walking the agent's tree can't reach.
    launch: (box) =>
      nodeLaunch(
        box.workspaceDir,
        [
          "const { spawn } = require('node:child_process');",
          "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
          "helper.unref();",
          "require('node:fs').writeFileSync('helper.pid', String(helper.pid));",
          "process.exit(0);",
        ].join("\n"),
      ),
    readPid: async (box) => {
      try {
        const pid = Number.parseInt(await readFile(path.join(box.workspaceDir, "helper.pid"), "utf8"), 10);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
      } catch {
        return null;
      }
    },
    isAlive,
    kill: killTree,
  },
  cleanEnvHelper: {
    launch: (box) =>
      nodeLaunch(
        box.workspaceDir,
        [
          "const { spawn } = require('node:child_process');",
          "const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};",
          "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env });",
          "helper.unref();",
          "require('node:fs').writeFileSync('helper.pid', String(helper.pid));",
          "process.exit(0);",
        ].join("\n"),
      ),
    readPid: async (box) => {
      try {
        const pid = Number.parseInt(await readFile(path.join(box.workspaceDir, "helper.pid"), "utf8"), 10);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
      } catch {
        return null;
      }
    },
    isAlive,
    kill: killTree,
  },
  knownGaps: {
    detachedHelper: "the tiny executor only ends the agent's own process tree",
    cleanEnvHelper: "the tiny executor only ends the agent's own process tree",
  },
  ...(fleet === undefined ? {} : { fleet }),
});

defineExecutorContractSuite({
  name: "tiny executor",
  create: () => Promise.resolve({ adapter: new TinyExecutor(), fixture: tinyExecutorFixture() }),
});

/** Every file under a folder, but the one left out, as `[path, text]`. */
const filesUnder = async (dir: string, leaveOut: string | null): Promise<readonly (readonly [string, string])[]> => {
  const found: (readonly [string, string])[] = [];
  const walk = async (at: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (full !== leaveOut) {
        found.push([full, await readFile(full, "utf8")]);
      }
    }
  };
  await walk(dir);
  return found;
};

// Milestone 5 (ticket 02): the tiny executor's fleet variant, which takes sizes, registry images, the
// task token and a node wait, so the fleet's cases run on one executor of each kind of answer before
// `docker` (ticket 09) and `kubernetes` (ticket 07) give their own fixtures.
defineExecutorContractSuite({
  name: "tiny executor, fleet variant",
  create: () => {
    const adapter = new TinyExecutor({ fleet: true });
    const tokenFile = (box: BoxRef): string | null => {
      const dir = adapter.inspect(box)?.sidecarDir ?? null;
      return dir === null ? null : path.join(dir, TASK_TOKEN_FILE);
    };
    const fleet: FleetFixture = {
      limitsOf: (box) => Promise.resolve(adapter.inspect(box)?.limits ?? null),
      image: {
        ref: "registry.example/ostra/snapshots/suite",
        digest: `sha256:${"e".repeat(64)}`,
        pull: { username: "ostra-pull-suite", token: "pull-token-suite-5d7c9e1b3a" },
      },
      pulls: () => Promise.resolve(adapter.pulls()),
      surface: async (box) => {
        const record = adapter.inspect(box);
        if (record === undefined) return [];
        const processes = record.launches.map((launch, index) => ({ where: `the agent's process ${String(index)}`, text: JSON.stringify(launch) }));
        const files = (await filesUnder(record.root, tokenFile(box))).map(([file, text]) => ({ where: file, text }));
        return [...processes, ...files];
      },
      tokenAtSidecar: async (box) => {
        const file = tokenFile(box);
        if (file === null) return null;
        try {
          return await readFile(file, "utf8");
        } catch {
          return null;
        }
      },
      holdNextBox: (ms) => {
        adapter.holdNextBox(ms);
      },
      objectsOf: async (box) => {
        const root = adapter.inspect(box)?.root;
        if (root === undefined) return [];
        return (await filesUnder(root, null)).map(([file]) => file).concat(await stat(root).then(() => [root], () => []));
      },
    };
    return Promise.resolve({ adapter, fixture: tinyExecutorFixture(fleet) });
  },
});

defineModelProviderContractSuite({
  name: "tiny model provider",
  create: () => {
    const endpoints = [
      {
        baseUrl: "http://stub.invalid/openai/v1",
        token: "stub-openai-token",
        apiFormat: "openai-compatible",
        authScheme: "bearer",
        models: ["gpt-test", "custom-model"],
      },
      {
        baseUrl: "http://stub.invalid/anthropic",
        token: "stub-anthropic-token",
        apiFormat: "anthropic-messages",
        authScheme: "x-api-key",
        models: ["claude-test"],
      },
    ] as const;
    return Promise.resolve({
      adapter: new TinyModelProvider(endpoints),
      fixture: {
        endpoints,
        wrongToken: "wrong-token",
        catalog: [
          {
            catalogId: "gpt-test",
            name: "GPT Test",
            aliases: [],
            contextWindow: 128_000,
            maxOutputTokens: 8192,
            inputPricePerMTok: 1,
            outputPricePerMTok: 2,
            cacheReadPricePerMTok: 0.1,
            cacheWritePricePerMTok: null,
            logoPath: null,
            reasoning: { supported: false },
            reasoningPriceDiffers: false,
          },
        ],
        knownModelId: "gpt-test",
        unknownModelId: "custom-model",
      },
    });
  },
});

defineSecretStoreContractSuite({
  name: "tiny secret store",
  create: () =>
    Promise.resolve({
      adapter: new TinySecretStore(memorySecretRowStore()),
      fixture: {
        organizationId: organizationIdSchema.parse("org-a"),
        otherOrganizationId: organizationIdSchema.parse("org-b"),
      },
    }),
});
