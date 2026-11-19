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
        branches: ["main", "ostra/contract", "ostra/other", "ostra/third"],
      },
      { id: 1002, owner: "fake-org", name: "test2", defaultBranch: "main", files: { "secret.txt": "other repo\n" }, branches: ["main"] },
    ],
  });

const fixtureOf = (fake: FakeGitHub): CodeHostFixture => {
  const app = { appId: fake.appId, privateKey: fake.privateKey };
  const body = JSON.stringify({ action: "opened", number: 1 });
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
      pr.state = "closed";
      pr.merged = true;
      expect(await adapter.findPullRequest(fixture.access, "ostra/third")).toMatchObject({ ok: true, value: { state: "merged" } });
      pr.merged = false;
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
        branchRules: false,
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
