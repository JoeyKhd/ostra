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

beforeAll(async () => {
  harness = await createApiHarness();
  harness.fakes.codeHost.apps.set(APP_ID, {
    privateKey: PEM,
    info: { appId: APP_ID, slug: "ostra-draft-app", name: "ostra draft app", permissions: { checks: "write", actions: "read" }, events: [] },
    bot: { name: "ostra-draft-app[bot]", email: "2+ostra-draft-app[bot]@users.noreply.github.com" },
    installations: [{ installationId, accountLogin: "ostra-test", accountKind: "organization", repositorySelection: "all" }],
    repos: new Map([[installationId, [{ hostRepoId: "31", fullName: "ostra-test/shop", defaultBranch: "main", private: true, cloneUrl: "https://github.example/ostra-test/shop.git" }]]]),
  });
  harness.fakes.codeHost.files.set("ostra-test/shop", repoFiles);
  const connected = await (await harness.as(harness.fixture.a.admin)).github.connectExisting({ appId: APP_ID, privateKey: PEM, webhookSecret: "whsec-0123456789" });
  connectionId = connected.connectionId;
});

afterAll(async () => {
  await harness.dispose();
});

const create = async (slug: string) =>
  (await harness.as(harness.fixture.a.admin)).projects.create({ name: slug, slug, access: "open", repo: { connectionId, installationId, fullName: "ostra-test/shop" } });

describe("environment detection", () => {
  it("F-112: creating a project drafts its environment from the repo's lockfiles, tool versions, .env.example, devcontainer.json and compose files, with no agent and no model", async () => {
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

  it("F-050, F-112: the draft stays a draft until a project admin saves it, edited, and a member can't", async () => {
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
