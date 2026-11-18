import { describe, expect, it } from "vitest";

import type { CodeHostAdapter, CodeHostAppCredentials, RepoAccess, WebhookInput } from "../code-host/base.ts";
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
};

export const defineCodeHostContractSuite = (options: ContractSuiteOptions<CodeHostAdapter, CodeHostFixture>): void => {
  describe(`code host contract: ${options.name}`, () => {
    const subject = useSubject(options);

    defineCommonCases(subject, "code-host", { checkRuns: "boolean", prTemplates: "boolean", lfsActionHosts: "array" });

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
    });

    it("verifies a webhook's signature and refuses a tampered body", () => {
      const { adapter, fixture } = subject();
      expect(adapter.verifyWebhook(fixture.webhook)).toBe(true);
      expect(adapter.verifyWebhook({ ...fixture.webhook, body: `${fixture.webhook.body} ` })).toBe(false);
      expect(adapter.verifyWebhook({ ...fixture.webhook, secret: `${fixture.webhook.secret}x` })).toBe(false);
    });
  });
};
