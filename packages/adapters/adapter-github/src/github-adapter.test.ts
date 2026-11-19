import { readFile } from "node:fs/promises";

import { defineCodeHostContractSuite, memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import type { CodeHostFixture } from "@ostra/adapter-sdk/testing";
import { repoFullNameSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFakeGitHub } from "./fake-github.ts";
import type { FakeGitHub } from "./fake-github.ts";
import { GITHUB_COM_LFS_ACTION_HOSTS, GitHubAdapter } from "./github-adapter.ts";

const template = "## What\n\n## Why\n";
const test1 = repoFullNameSchema.parse("fake-org/test1");
const test2 = repoFullNameSchema.parse("fake-org/test2");

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
        branches: ["main", "ostra/contract", "ostra/other", "ostra/third", "ostra/fourth", "ostra/classic", "ostra/review", "ostra/open"],
        protectedBranches: ["ostra/classic"],
        rulesets: {
          main: ["deletion", "required_signatures"],
          "ostra/review": ["pull_request"],
        },
        refs: ["refs/ostra/wip/task-contract"],
      },
      { id: 1002, owner: "fake-org", name: "test2", defaultBranch: "main", files: { "secret.txt": "other repo\n" }, branches: ["main"] },
      // Private, in a free organization: rulesets and rules answer 403 "Upgrade to GitHub Pro".
      { id: 1003, owner: "fake-org", name: "free", defaultBranch: "main", files: {}, branches: ["main"], plan: "free" },
      // The rules endpoint refuses the App, as for a missing permission.
      { id: 1004, owner: "fake-org", name: "refused", defaultBranch: "main", files: {}, branches: ["main", "locked"], protectedBranches: ["locked"], rulesRefused: true },
    ],
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
  };
};

// The code host contract suite, against the fake GitHub.
let suiteFake: FakeGitHub | undefined;
defineCodeHostContractSuite({
  name: "github, against a fake GitHub",
  create: async () => {
    suiteFake = await startFake();
    return {
      adapter: new GitHubAdapter({ apiUrl: suiteFake.apiUrl, webUrl: suiteFake.webUrl }),
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
    adapter = new GitHubAdapter({ apiUrl: fake.apiUrl, webUrl: fake.webUrl }, context);
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
      expect(adapter.parseWebhook({ headers: { "x-github-event": "push" }, body: "not json at all", secret: "" })).toEqual({
        ok: true,
        value: { kind: "other", event: "push" },
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
    it("declares check runs, PR templates and exactly the LFS hosts of Q119", () => {
      expect(adapter.capabilities).toEqual({
        checkRuns: true,
        prTemplates: true,
        lfsActionHosts: ["github-cloud.githubusercontent.com", "github-cloud.s3.amazonaws.com", "lfs.github.com"],
        branchRules: true,
      });
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
