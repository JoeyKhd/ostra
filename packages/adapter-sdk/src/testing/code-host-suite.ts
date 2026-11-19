import { describe, expect, it } from "vitest";

import type {
  BranchRules,
  CodeHostAdapter,
  CodeHostAppCredentials,
  CodeHostOAuthClient,
  CommentRef,
  LinkedUser,
  RepoAccess,
  WebhookInput,
} from "../code-host/base.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";

// The cases every code host adapter passes (ADR 0025, spec section 8): against a fake host, and,
// gated on `github.env` and `github-test.env`, against `ostra-test/test1`.

export type CodeHostFixture = {
  readonly app: CodeHostAppCredentials;
  /** An App the host refuses: its credentials are wrong. */
  readonly wrongApp: CodeHostAppCredentials;
  readonly installationId: string;
  readonly access: RepoAccess;
  readonly defaultBranch: string;
  /** A file that exists at the default branch, with its content. */
  readonly file: { readonly path: string; readonly content: string };
  readonly missingPath: string;
  /** The repo's PR template, or `null` when it has none. */
  readonly prTemplate: string | null;
  /**
   * A branch, ahead of the default branch, that the suite may open a PR from. `null` skips the PR
   * cases. The factory's `dispose` closes the PR and deletes the branch.
   */
  readonly prHead: string | null;
  /** A webhook signed with its secret; the suite checks it and a tampered copy. */
  readonly webhook: WebhookInput;
  // ---- milestone 2: absent, the case is skipped (an adapter adds them as it builds each one) ----
  /** Branches with known rules, and what `readBranchRules` must answer for each. */
  readonly branchRules?: readonly { readonly branch: string; readonly expected: Omit<BranchRules, "reasons"> }[];
  /** A signed `pull_request` webhook, and the PR it's about. */
  readonly pullRequestWebhook?: { readonly input: WebhookInput; readonly number: number; readonly state: "open" | "closed" | "merged" };
  /** A ref the suite may delete, such as a hidden ref made for it. */
  readonly deletableRef?: string;
  // ---- milestone 3: absent, the case is skipped; without the capability, the call must be `unsupported` ----
  /** Pairs of a base and a head the host knows, with their counts, and a file over the host's patch limit. */
  readonly compare?: {
    readonly ahead: ComparePair;
    readonly behind: ComparePair;
    readonly diverged: ComparePair;
    /** A pair whose `path` is over the patch limit, and which changes more files than the host lists. */
    readonly truncated: { readonly base: string; readonly head: string; readonly path: string };
  };
  /** Signed webhooks of the three new kinds, and what each must read as. */
  readonly commentWebhooks?: {
    readonly issueComment: { readonly input: WebhookInput; readonly number: number; readonly commentId: string; readonly authorId: string; readonly body: string };
    readonly reviewComment: {
      readonly input: WebhookInput;
      readonly number: number;
      readonly commentId: string;
      readonly path: string;
      readonly line: number;
      readonly side: "old" | "new";
    };
    readonly push: { readonly input: WebhookInput; readonly ref: string; readonly after: string; readonly changedPaths: readonly string[] };
  };
  /** A comment the suite may react to. */
  readonly comment?: CommentRef;
  /** The App's OAuth client, a sign-in's code and the account it stands for, and the host's count of revoked tokens. */
  readonly userLink?: {
    readonly client: CodeHostOAuthClient;
    readonly code: string;
    readonly redirectUri: string;
    readonly user: LinkedUser;
    readonly revokedTokens: () => number;
    /** Makes the host's next revocation fail. */
    readonly failNextRevocation: () => void;
  };
};

/** A base and a head the host can compare, and the counts it must report. */
export type ComparePair = { readonly base: string; readonly head: string; readonly aheadBy: number; readonly behindBy: number };

export const defineCodeHostContractSuite = (options: ContractSuiteOptions<CodeHostAdapter, CodeHostFixture>): void => {
  describe(`code host contract: ${options.name}`, () => {
    const subject = useSubject(options);

    defineCommonCases(subject, "code-host", {
      checkRuns: "boolean",
      prTemplates: "boolean",
      lfsActionHosts: "array",
      branchRules: "boolean",
      compare: "boolean",
      draftPullRequests: "boolean",
      prComments: "boolean",
      userLink: "boolean",
    });

    it("builds a manifest that points the App's webhooks at the given address", () => {
      const { manifest, createUrl } = subject().adapter.appManifest({
        name: "ostra-contract",
        homepageUrl: "http://localhost:3000",
        webhookUrl: "https://example.com/hooks/abc",
        redirectUrl: "http://localhost:3000/setup/github/callback",
        ownerLogin: null,
      });
      expect(createUrl).toMatch(/^https:\/\//);
      expect(JSON.stringify(manifest)).toContain("https://example.com/hooks/abc");
    });

    it("reads the App, and refuses wrong credentials", async () => {
      const { adapter, fixture } = subject();
      const app = await adapter.readApp(fixture.app);
      expect(app).toMatchObject({ ok: true, value: { appId: fixture.app.appId } });
      const wrong = await adapter.readApp(fixture.wrongApp);
      expect(wrong).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    });

    it("lists the installation and its repo", async () => {
      const { adapter, fixture } = subject();
      const installations = await adapter.listInstallations(fixture.app);
      expect(installations.ok && installations.value.map((item) => item.installationId)).toContain(fixture.installationId);
      const repos = await adapter.listRepos(fixture.app, fixture.installationId);
      expect(repos.ok && repos.value.map((repo) => repo.fullName)).toContain(fixture.access.repo);
    });

    it("reads the default branch, files and the PR template", async () => {
      const { adapter, fixture } = subject();
      expect(await adapter.getDefaultBranch(fixture.access)).toEqual({ ok: true, value: fixture.defaultBranch });
      const files = await adapter.readFiles(fixture.access, fixture.defaultBranch, [fixture.file.path, fixture.missingPath]);
      expect(files).toEqual({ ok: true, value: { files: [fixture.file], missing: [fixture.missingPath] } });
      expect(await adapter.getPullRequestTemplate(fixture.access, fixture.defaultBranch)).toEqual({
        ok: true,
        value: fixture.prTemplate,
      });
    });

    it("mints a token for the one repo, with an expiry ahead", async () => {
      const { adapter, fixture } = subject();
      const token = await adapter.mintRepoToken(fixture.access, { contents: "write", metadata: "read" });
      expect(token.ok).toBe(true);
      if (token.ok) {
        expect(token.value.token.length).toBeGreaterThan(0);
        expect(token.value.expiresAt).toBeGreaterThan(Date.now());
      }
    });

    it("names the App's bot as the commit author", async () => {
      const { adapter, fixture } = subject();
      const bot = await adapter.getBotIdentity(fixture.app);
      expect(bot.ok && bot.value.name).toMatch(/\[bot\]$/);
    });

    it("opens a PR once: a second open is a conflict, and find returns it", async (context) => {
      const { adapter, fixture } = subject();
      if (fixture.prHead === null) {
        context.skip();
        return;
      }
      expect(await adapter.findPullRequest(fixture.access, fixture.prHead)).toEqual({ ok: true, value: null });
      const input = {
        access: fixture.access,
        head: fixture.prHead,
        base: fixture.defaultBranch,
        title: "ostra contract suite",
        body: "Opened by the code host contract suite.",
        draft: false,
      };
      const opened = await adapter.openPullRequest(input);
      expect(opened).toMatchObject({ ok: true, value: { state: "open", headBranch: fixture.prHead } });
      expect(await adapter.openPullRequest(input)).toMatchObject({ ok: false, error: { code: "conflict" } });
      const found = await adapter.findPullRequest(fixture.access, fixture.prHead);
      expect(found.ok && found.value?.number).toBe(opened.ok ? opened.value.number : -1);
      // Milestone 2: the reconcile reads it back by number.
      if (opened.ok) {
        const byNumber = await adapter.getPullRequest(fixture.access, opened.value.number);
        if (!byNumber.ok && byNumber.error.code === "unsupported") {
          return;
        }
        expect(byNumber).toMatchObject({ ok: true, value: { number: opened.value.number, state: "open", merged: false } });
        expect(byNumber.ok && byNumber.value.headSha.length).toBeGreaterThan(0);
      }
    });

    it("reads a branch's protection and signed-commit rule (F-055, F-060)", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.branchRules) {
        expect(await adapter.readBranchRules(fixture.access, fixture.defaultBranch)).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (fixture.branchRules === undefined) {
        context.skip();
        return;
      }
      for (const { branch, expected } of fixture.branchRules) {
        const rules = await adapter.readBranchRules(fixture.access, branch);
        expect(rules, branch).toMatchObject({ ok: true, value: expected });
        if (rules.ok && (rules.value.protected === "unknown" || rules.value.requiresSignedCommits === "unknown")) {
          expect(rules.value.reasons.length, "an unknown says why").toBeGreaterThan(0);
        }
      }
    });

    it("reads a pull_request webhook into its PR, and another event as other", (context) => {
      const { adapter, fixture } = subject();
      if (fixture.pullRequestWebhook === undefined) {
        context.skip();
        return;
      }
      const { input, number, state } = fixture.pullRequestWebhook;
      expect(adapter.verifyWebhook(input)).toBe(true);
      expect(adapter.parseWebhook(input)).toMatchObject({ ok: true, value: { kind: "pull_request", number, state } });
      // Milestone 3 reads `push` too, so the event no milestone reads is a star.
      const other = adapter.parseWebhook({ ...input, headers: { ...input.headers, "x-github-event": "star" } });
      expect(other).toMatchObject({ ok: true, value: { kind: "other" } });
    });

    it("deletes a ref once, and deleting it again isn't an error", async (context) => {
      const { adapter, fixture } = subject();
      if (fixture.deletableRef === undefined) {
        context.skip();
        return;
      }
      expect(await adapter.deleteRef(fixture.access, fixture.deletableRef)).toEqual({ ok: true, value: { deleted: true } });
      expect(await adapter.deleteRef(fixture.access, fixture.deletableRef)).toEqual({ ok: true, value: { deleted: false } });
    });

    // ---------- milestone 3 (ADR 0051, ADR 0052) ----------

    it("F-027: compares an ahead, a behind and a diverged branch, with their counts", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.compare) {
        expect(await adapter.compare(fixture.access, "a", "b")).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (fixture.compare === undefined) {
        context.skip();
        return;
      }
      for (const [name, pair] of Object.entries({ ahead: fixture.compare.ahead, behind: fixture.compare.behind, diverged: fixture.compare.diverged })) {
        const compared = await adapter.compare(fixture.access, pair.base, pair.head);
        expect(compared, name).toMatchObject({ ok: true, value: { aheadBy: pair.aheadBy, behindBy: pair.behindBy } });
        if (compared.ok) {
          expect(compared.value.limits.maxFiles).toBeGreaterThan(0);
          expect(compared.value.limits.maxPatchBytes).toBeGreaterThan(0);
        }
      }
      expect((await adapter.compare(fixture.access, "no-such-base", "no-such-head")).ok).toBe(false);
    });

    it("F-027: reports the host's limits: a file over the patch limit is truncated, and a long list is cut, never hidden", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.compare || fixture.compare === undefined) {
        context.skip();
        return;
      }
      const { base, head, path } = fixture.compare.truncated;
      const compared = await adapter.compare(fixture.access, base, head);
      if (!compared.ok) throw new Error(compared.error.message);
      const file = compared.value.files.find((candidate) => candidate.path === path);
      expect(file).toMatchObject({ truncated: true, patch: null });
      expect(compared.value.filesTruncated).toBe(true);
      expect(compared.value.files.length).toBeLessThanOrEqual(compared.value.limits.maxFiles);
      // Every other file's patch is whole.
      expect(compared.value.files.filter((candidate) => candidate.path !== path).every((candidate) => !candidate.truncated)).toBe(true);
    });

    it("F-054: makes a PR a draft and back", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.draftPullRequests) {
        expect(await adapter.setPullRequestDraft(fixture.access, 1, true)).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (fixture.prHead === null) {
        context.skip();
        return;
      }
      const existing = await adapter.findPullRequest(fixture.access, fixture.prHead);
      if (!existing.ok) throw new Error(existing.error.message);
      const pr =
        existing.value ??
        (await adapter.openPullRequest({ access: fixture.access, head: fixture.prHead, base: fixture.defaultBranch, title: "ostra contract suite", body: "x", draft: false }));
      const number = "number" in pr ? pr.number : pr.ok ? pr.value.number : -1;
      expect(await adapter.setPullRequestDraft(fixture.access, number, true)).toMatchObject({ ok: true, value: { number, draft: true } });
      expect(await adapter.setPullRequestDraft(fixture.access, number, false)).toMatchObject({ ok: true, value: { number, draft: false } });
      expect((await adapter.setPullRequestDraft(fixture.access, 999_999, true)).ok).toBe(false);
    });

    it("F-053: reads a PR comment, a line comment and a push from their signed webhooks, and refuses a bad signature", (context) => {
      const { adapter, fixture } = subject();
      const hooks = fixture.commentWebhooks;
      if (!adapter.capabilities.prComments || hooks === undefined) {
        context.skip();
        return;
      }
      for (const hook of [hooks.issueComment, hooks.reviewComment, hooks.push]) {
        expect(adapter.verifyWebhook(hook.input)).toBe(true);
        expect(adapter.verifyWebhook({ ...hook.input, body: `${hook.input.body} ` })).toBe(false);
      }
      expect(adapter.parseWebhook(hooks.issueComment.input)).toMatchObject({
        ok: true,
        value: {
          kind: "issue_comment",
          number: hooks.issueComment.number,
          onPullRequest: true,
          comment: { commentId: hooks.issueComment.commentId, authorId: hooks.issueComment.authorId, body: hooks.issueComment.body },
        },
      });
      expect(adapter.parseWebhook(hooks.reviewComment.input)).toMatchObject({
        ok: true,
        value: {
          kind: "pull_request_review_comment",
          number: hooks.reviewComment.number,
          path: hooks.reviewComment.path,
          line: hooks.reviewComment.line,
          side: hooks.reviewComment.side,
          comment: { commentId: hooks.reviewComment.commentId },
        },
      });
      const push = adapter.parseWebhook(hooks.push.input);
      expect(push).toMatchObject({ ok: true, value: { kind: "push", ref: hooks.push.ref, after: hooks.push.after } });
      if (push.ok && push.value.kind === "push") {
        expect([...(push.value.changedPaths ?? [])].sort()).toEqual([...hooks.push.changedPaths].sort());
      }
      // A body that isn't the event it says is refused, never read as something else.
      expect(adapter.parseWebhook({ ...hooks.push.input, body: "{}" })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    });

    it("F-053: a reaction twice is one reaction", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.prComments) {
        expect(await adapter.addReaction(fixture.access, { kind: "issue", commentId: "1" }, "eyes")).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (fixture.comment === undefined) {
        context.skip();
        return;
      }
      expect(await adapter.addReaction(fixture.access, fixture.comment, "eyes")).toEqual({ ok: true, value: { created: true } });
      expect(await adapter.addReaction(fixture.access, fixture.comment, "eyes")).toEqual({ ok: true, value: { created: false } });
    });

    it("F-119: links a member's account, and revokes the sign-in's token before it answers", async (context) => {
      const { adapter, fixture } = subject();
      const link = fixture.userLink;
      if (!adapter.capabilities.userLink) {
        expect(adapter.userAuthorizeUrl({ clientId: "x", clientSecret: "y" }, "state", "https://x")).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (link === undefined) {
        context.skip();
        return;
      }
      const url = adapter.userAuthorizeUrl(link.client, "state-123", link.redirectUri);
      expect(url.ok).toBe(true);
      if (url.ok) {
        const parsed = new URL(url.value);
        expect(parsed.protocol).toBe("https:");
        expect(parsed.searchParams.get("state")).toBe("state-123");
        expect(parsed.searchParams.get("redirect_uri")).toBe(link.redirectUri);
        expect(url.value).not.toContain(link.client.clientSecret);
      }
      const before = link.revokedTokens();
      expect(await adapter.exchangeUserCode(link.client, link.code, link.redirectUri)).toEqual({ ok: true, value: link.user });
      expect(link.revokedTokens()).toBe(before + 1);
      // A revocation that fails is an error, never a link made with a live token.
      link.failNextRevocation();
      expect((await adapter.exchangeUserCode(link.client, link.code, link.redirectUri)).ok).toBe(false);
      expect(link.revokedTokens()).toBe(before + 1);
      expect((await adapter.exchangeUserCode(link.client, "a-wrong-code", link.redirectUri)).ok).toBe(false);
    });

    it("verifies a webhook's signature and refuses a tampered body", () => {
      const { adapter, fixture } = subject();
      expect(adapter.verifyWebhook(fixture.webhook)).toBe(true);
      expect(adapter.verifyWebhook({ ...fixture.webhook, body: `${fixture.webhook.body} ` })).toBe(false);
      expect(adapter.verifyWebhook({ ...fixture.webhook, secret: `${fixture.webhook.secret}x` })).toBe(false);
    });
  });
};
