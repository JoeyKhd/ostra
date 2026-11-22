import { projectIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-112: creating a project drafts its environment from the repo's files, with no agent and no
// model; the draft stays a draft until a project admin saves it, edited. Against the fake code
// host (GitHub is the external service). The browser's side is apps/web/e2e/05-environment.spec.ts.

const APP_ID = "5821041";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nDRAFT-KEY-BODY-0123456789\n-----END RSA PRIVATE KEY-----";
const installationId = "9101";

const repoFiles = new Map([
  ["package.json", '{"name":"shop","packageManager":"pnpm@10.4.1"}'],
  ["pnpm-lock.yaml", "lockfileVersion: 9"],
  [".nvmrc", "v22.11.0\n"],
  [".env.example", "API_URL=\nSTRIPE_SECRET_KEY=\n"],
  [".devcontainer/devcontainer.json", '{\n  // the dev image\n  "image": "mcr.microsoft.com/devcontainers/typescript-node:22",\n  "postCreateCommand": "pnpm run codegen"\n}\n'],
  ["compose.yaml", "services:\n  redis:\n    image: redis:7\n    ports:\n      - 6379:6379\n"],
]);

let harness: ApiHarness;
let connectionId: string;

const hostRepo = (hostRepoId: string, fullName: string) => ({ hostRepoId, fullName, defaultBranch: "main", private: true, cloneUrl: `https://github.example/${fullName}.git` });

beforeAll(async () => {
  harness = await createApiHarness();
  harness.fakes.codeHost.apps.set(APP_ID, {
    privateKey: PEM,
    info: { appId: APP_ID, slug: "ostra-draft-app", name: "ostra draft app", permissions: { checks: "write", actions: "read" }, events: [] },
    bot: { name: "ostra-draft-app[bot]", email: "2+ostra-draft-app[bot]@users.noreply.github.com" },
    installations: [{ installationId, accountLogin: "ostra-test", accountKind: "organization", repositorySelection: "all" }],
    repos: new Map([[installationId, [hostRepo("31", "ostra-test/shop"), hostRepo("32", "ostra-test/api"), hostRepo("33", "ostra-test/notes"), hostRepo("34", "ostra-test/ml")]]]),
  });
  harness.fakes.codeHost.files.set("ostra-test/shop", repoFiles);
  // F-112/c1's other repos: one on npm, one with nothing detection knows, one on pip.
  harness.fakes.codeHost.files.set("ostra-test/api", new Map([["package.json", '{"name":"api"}'], ["package-lock.json", "{}"], [".env.example", "API_TOKEN=\n"]]));
  harness.fakes.codeHost.files.set("ostra-test/notes", new Map([["README.md", "# notes\n"]]));
  harness.fakes.codeHost.files.set("ostra-test/ml", new Map([["requirements.txt", "numpy==2.1.0\n"]]));
  const connected = await (await harness.as(harness.fixture.a.admin)).github.connectExisting({ appId: APP_ID, privateKey: PEM, webhookSecret: "whsec-0123456789" });
  connectionId = connected.connectionId;
});

afterAll(async () => {
  await harness.dispose();
});

const create = async (slug: string) =>
  (await harness.as(harness.fixture.a.admin)).projects.create({ name: slug, slug, access: "open", repo: { connectionId, installationId, fullName: "ostra-test/shop" } });

describe("environment detection", () => {
  it("F-112/c1: creating a project drafts its environment from the repo's lockfiles, tool versions, .env.example, devcontainer.json and compose files, with no agent and no model", async () => {
    const tasksBefore = await harness.test.db.task.count();
    const sessionsBefore = await harness.test.db.session.count();
    const created = await create("shop");
    const { detection } = created;

    // Each kind of file, and its reason.
    expect(detection.setupLines).toEqual(["corepack enable", "pnpm install --frozen-lockfile", "pnpm run codegen"]);
    expect(detection.tools).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "node", version: "22.11.0", source: ".nvmrc" })]));
    expect(detection.variables.map((variable) => [variable.name, variable.secret])).toEqual([
      ["API_URL", false],
      ["STRIPE_SECRET_KEY", true],
    ]);
    expect(detection.baseImage).toBe("mcr.microsoft.com/devcontainers/typescript-node:22");
    expect(detection.services).toMatchObject([{ name: "redis", image: "redis:7", ports: [6379], runsOnHost: false }]);
    expect(detection.reasons.map((reason) => reason.file)).toEqual(
      expect.arrayContaining(["pnpm-lock.yaml", ".nvmrc", ".env.example", ".devcontainer/devcontainer.json", "compose.yaml"]),
    );

    // Stored as a draft: the setup script and base image detection made, nothing saved by anyone.
    const environment = await harness.test.db.environment.findFirstOrThrow({ where: { projectId: created.projectId } });
    expect(environment).toMatchObject({
      status: "draft",
      setupScript: "set -euo pipefail\ncorepack enable\npnpm install --frozen-lockfile\npnpm run codegen\n",
      baseImage: "mcr.microsoft.com/devcontainers/typescript-node:22",
      savedAt: null,
    });

    // No agent ran and no model was called: no task, no session, no model endpoint reached.
    expect(await harness.test.db.task.count()).toBe(tasksBefore);
    expect(await harness.test.db.session.count()).toBe(sessionsBefore);
    expect(harness.fakes.modelProvider.testedTokens).toEqual([]);
  });

  it("F-050/c1, F-112/c2: the draft stays a draft until a project admin saves it, edited, and a member can't", async () => {
    const created = await create("shop-two");
    const projectId = projectIdSchema.parse(created.projectId);
    const member = await harness.as(harness.fixture.a.member);
    expect(await member.environments.get({ projectId })).toMatchObject({ status: "draft", savedAt: null });

    const [repo] = (await member.environments.get({ projectId })).repos;
    if (repo === undefined) throw new Error("no repo");
    const edited = {
      baseImage: null,
      setupScript: "corepack enable\npnpm install --frozen-lockfile\n",
      envFiles: [],
      entries: [{ kind: "variable" as const, repoId: repo.repoId, name: "API_URL", value: "http://localhost:4000", availableDuringSetup: false }],
    };
    await expect(member.environments.save({ projectId, environment: edited })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await member.environments.get({ projectId })).toMatchObject({ status: "draft" });

    await (await harness.as(harness.fixture.a.admin)).environments.save({ projectId, environment: edited });
    const saved = await member.environments.get({ projectId });
    expect(saved).toMatchObject({ status: "saved", baseImage: null, setupScript: edited.setupScript });
    expect(saved.savedAt).not.toBeNull();
    expect(saved.entries).toEqual([expect.objectContaining({ kind: "variable", name: "API_URL", value: "http://localhost:4000" })]);
  });
});

describe("environment detection over several repos", () => {
  const repoInput = (fullName: string) => ({ connectionId, installationId, fullName });
  const storedDraft = async (projectId: string) => harness.test.db.environment.findFirstOrThrow({ where: { projectId }, select: { status: true, setupScript: true, baseImage: true } });
  const noAgentNoModel = async (run: () => Promise<void>) => {
    const tasks = await harness.test.db.task.count();
    const sessions = await harness.test.db.session.count();
    await run();
    expect(await harness.test.db.task.count()).toBe(tasks);
    expect(await harness.test.db.session.count()).toBe(sessions);
    expect(harness.fakes.modelProvider.testedTokens).toEqual([]);
  };

  it("F-112/c1: creating a project with several repos drafts its environment from each repo's files, each repo's setup under its own name, with no agent and no model", async () => {
    await noAgentNoModel(async () => {
      const admin = await harness.as(harness.fixture.a.admin);
      const created = await admin.projects.create({
        name: "several",
        slug: "several",
        access: "open",
        repo: repoInput("ostra-test/shop"),
        moreRepos: [repoInput("ostra-test/api"), repoInput("ostra-test/notes")],
      });
      // The setup script runs once per repo, in its folder, with OSTRA_REPO set: each repo gets its
      // own lines, and the repo with nothing to go on runs none.
      expect(await storedDraft(created.projectId)).toEqual({
        status: "draft",
        setupScript: [
          "set -euo pipefail",
          'case "$OSTRA_REPO" in',
          "  'ostra-test/shop')",
          "    corepack enable",
          "    pnpm install --frozen-lockfile",
          "    pnpm run codegen",
          "    ;;",
          "  'ostra-test/api')",
          "    npm ci",
          "    ;;",
          "esac",
          "",
        ].join("\n"),
        baseImage: "mcr.microsoft.com/devcontainers/typescript-node:22",
      });
      // Each repo's findings are there for the review, the second repo's variables too.
      const detected = await admin.environments.detect({ projectId: projectIdSchema.parse(created.projectId) });
      expect(detected.map((entry) => [entry.fullName, entry.detection.setupLines])).toEqual([
        ["ostra-test/shop", ["corepack enable", "pnpm install --frozen-lockfile", "pnpm run codegen"]],
        ["ostra-test/api", ["npm ci"]],
        ["ostra-test/notes", []],
      ]);
      expect(detected[1]?.detection.variables.map((variable) => variable.name)).toEqual(["API_TOKEN"]);
    });
  });

  it("F-112/c1: adding a repo to a project whose environment is still a draft drafts it again from each repo's files, with no agent and no model", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const created = await admin.projects.create({ name: "growing", slug: "growing", access: "open", repo: repoInput("ostra-test/shop") });
    const projectId = projectIdSchema.parse(created.projectId);
    expect((await storedDraft(projectId)).setupScript).toBe("set -euo pipefail\ncorepack enable\npnpm install --frozen-lockfile\npnpm run codegen\n");

    await noAgentNoModel(async () => {
      await admin.projects.addRepo({ projectId, fullName: "ostra-test/ml" });
    });
    expect(await storedDraft(projectId)).toEqual({
      status: "draft",
      setupScript: [
        "set -euo pipefail",
        'case "$OSTRA_REPO" in',
        "  'ostra-test/shop')",
        "    corepack enable",
        "    pnpm install --frozen-lockfile",
        "    pnpm run codegen",
        "    ;;",
        "  'ostra-test/ml')",
        "    pip install -r requirements.txt",
        "    ;;",
        "esac",
        "",
      ].join("\n"),
      baseImage: "mcr.microsoft.com/devcontainers/typescript-node:22",
    });
  });

  it("adding a repo leaves an environment a project admin saved as they saved it", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const created = await admin.projects.create({ name: "reviewed", slug: "reviewed", access: "open", repo: repoInput("ostra-test/shop") });
    const projectId = projectIdSchema.parse(created.projectId);
    await admin.environments.save({ projectId, environment: { baseImage: null, setupScript: "pnpm install\n", envFiles: [], entries: [] } });
    await admin.projects.addRepo({ projectId, fullName: "ostra-test/api" });
    expect(await storedDraft(projectId)).toEqual({ status: "saved", setupScript: "pnpm install\n", baseImage: null });
  });
});
