import { projectIdSchema, repoIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, trpcFailure } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-112/c1, for a repo added after the environment was saved (Q345 option (b), the maintainer
// 2026-11-22): `projects.addRepo` runs detection for the new repo, with no agent and no model, and
// holds its draft beside the saved setup, which stays as it is until a project admin applies it,
// edits it first or dismisses it. Against the fake code host (GitHub is the external service) and
// Postgres. The browser's side is apps/web/e2e/28-environment-repo-draft.spec.ts.

const APP_ID = "5821077";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nREPO-DRAFT-KEY-0123456789\n-----END RSA PRIVATE KEY-----";
const installationId = "9177";

let harness: ApiHarness;
let connectionId: string;

const hostRepo = (hostRepoId: string, fullName: string) => ({ hostRepoId, fullName, defaultBranch: "main", private: true, cloneUrl: `https://github.example/${fullName}.git` });

beforeAll(async () => {
  harness = await createApiHarness();
  harness.fakes.codeHost.apps.set(APP_ID, {
    privateKey: PEM,
    info: { appId: APP_ID, slug: "ostra-repo-drafts", name: "ostra repo drafts", permissions: { checks: "write", actions: "read" }, events: [] },
    bot: { name: "ostra-repo-drafts[bot]", email: "3+ostra-repo-drafts[bot]@users.noreply.github.com" },
    installations: [{ installationId, accountLogin: "ostra-test", accountKind: "organization", repositorySelection: "all" }],
    repos: new Map([[installationId, [hostRepo("71", "ostra-test/web"), hostRepo("72", "ostra-test/engine"), hostRepo("73", "ostra-test/docs"), hostRepo("74", "ostra-test/site")]]]),
  });
  harness.fakes.codeHost.files.set("ostra-test/web", new Map([["package.json", '{"name":"web","packageManager":"pnpm@10.4.1"}'], ["pnpm-lock.yaml", "lockfileVersion: 9"]]));
  harness.fakes.codeHost.files.set(
    "ostra-test/engine",
    new Map([
      ["uv.lock", "version = 1"],
      [".python-version", "3.12\n"],
      [".env.example", "ENGINE_LOG_LEVEL=info\nENGINE_API_KEY=\n"],
      ["compose.yaml", "services:\n  redis:\n    image: redis:7\n    ports:\n      - 6379:6379\n"],
    ]),
  );
  harness.fakes.codeHost.files.set("ostra-test/docs", new Map([["README.md", "# docs\n"]]));
  // A second Node repo: the same lines detection drafted for web.
  harness.fakes.codeHost.files.set("ostra-test/site", new Map([["package.json", '{"name":"site","packageManager":"pnpm@10.4.1"}'], ["pnpm-lock.yaml", "lockfileVersion: 9"]]));
  const connected = await (await harness.as(harness.fixture.a.admin)).github.connectExisting({ appId: APP_ID, privateKey: PEM, webhookSecret: "whsec-0123456789" });
  connectionId = connected.connectionId;
});

afterAll(async () => {
  await harness.dispose();
});

const CASE_SCRIPT = ["set -euo pipefail", 'case "$OSTRA_REPO" in', "  'ostra-test/web')", "    corepack enable", "    pnpm install --frozen-lockfile", "    ;;", "esac", ""].join("\n");
const PLAIN_SCRIPT = "set -euo pipefail\ncorepack enable\npnpm install --frozen-lockfile\n";

/** A project on `ostra-test/web` whose environment a project admin saved with this script. */
const savedProject = async (slug: string, setupScript: string): Promise<ProjectId> => {
  const admin = await harness.as(harness.fixture.a.admin);
  const created = await admin.projects.create({ name: slug, slug, access: "open", repo: { connectionId, installationId, fullName: "ostra-test/web" } });
  const projectId = projectIdSchema.parse(created.projectId);
  await admin.environments.save({ projectId, environment: { baseImage: null, setupScript, envFiles: [], entries: [] } });
  return projectId;
};

const stored = (projectId: string) => harness.test.db.environment.findFirstOrThrow({ where: { projectId }, select: { status: true, setupScript: true } });

const noAgentNoModel = async <T,>(run: () => Promise<T>): Promise<T> => {
  const tasks = await harness.test.db.task.count();
  const sessions = await harness.test.db.session.count();
  const result = await run();
  expect(await harness.test.db.task.count()).toBe(tasks);
  expect(await harness.test.db.session.count()).toBe(sessions);
  expect(harness.fakes.modelProvider.testedTokens).toEqual([]);
  return result;
};

describe("a repo added after the environment was saved (F-112/c1, Q345 option (b))", () => {
  it("F-112/c1: adding a repo to a project whose environment is saved drafts that repo's setup from its files beside the saved one, with no agent and no model, and the saved environment stays as it is", async () => {
    const projectId = await savedProject("drafts-case", CASE_SCRIPT);
    const admin = await harness.as(harness.fixture.a.admin);
    const added = await noAgentNoModel(() => admin.projects.addRepo({ projectId, fullName: "ostra-test/engine" }));
    expect(added.drafted).toBe(true);
    // The saved environment runs as it is.
    expect(await stored(projectId)).toEqual({ status: "saved", setupScript: CASE_SCRIPT });

    // Anyone who can open the project reads the draft: what detection found, and what Apply would save.
    const [draft, ...more] = await (await harness.as(harness.fixture.a.member)).environments.repoDrafts({ projectId });
    expect(more).toEqual([]);
    expect(draft).toMatchObject({
      repoId: added.repoId,
      fullName: "ostra-test/engine",
      kind: "case",
      envFile: ".env",
      language: "python",
      tool: "uv",
      savedTool: "pnpm",
      variables: [
        { name: "ENGINE_LOG_LEVEL", secret: false, source: ".env.example" },
        { name: "ENGINE_API_KEY", secret: true, source: ".env.example" },
      ],
      tools: [{ tool: "python", version: "3.12", source: ".python-version" }],
      services: [{ name: "redis", image: "redis:7", ports: [6379], source: "compose.yaml" }],
    });
    // Who added the repo, by name.
    const adder = await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.userId }, select: { name: true } });
    expect(draft?.createdBy).toBe(adder.name);
    expect(draft?.reasons.map((reason) => reason.file)).toEqual(expect.arrayContaining(["uv.lock", ".python-version", ".env.example", "compose.yaml"]));
    expect(draft?.lines.filter((line) => line.kind === "add").map((line) => line.text)).toEqual(["  'ostra-test/engine')", "    uv sync --frozen", "    ;;"]);
    expect(draft?.script).toBe(CASE_SCRIPT.replace("esac\n", "  'ostra-test/engine')\n    uv sync --frozen\n    ;;\nesac\n"));
  });

  it("F-112/c1: a project admin reviews the draft before it's saved: Apply saves the repo's branch and variables at once, audited and versioned, and the snapshot rebuilds; a member can't", async () => {
    const projectId = await savedProject("drafts-apply", CASE_SCRIPT);
    const admin = await harness.as(harness.fixture.a.admin);
    const { repoId } = await admin.projects.addRepo({ projectId, fullName: "ostra-test/engine" });
    const member = await harness.as(harness.fixture.a.member);
    expect(await trpcFailure(member.environments.applyRepoDraft({ projectId, repoId }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await stored(projectId)).toEqual({ status: "saved", setupScript: CASE_SCRIPT });

    // The first save's rebuild is queued already: only this one's is looked for.
    harness.fakes.jobs.clear();
    const applied = await noAgentNoModel(() => admin.environments.applyRepoDraft({ projectId, repoId }));
    // The secret has no value to keep yet: the page asks for it.
    expect(applied.secretsWithoutValue).toEqual(["ENGINE_API_KEY"]);
    expect(await stored(projectId)).toEqual({ status: "saved", setupScript: CASE_SCRIPT.replace("esac\n", "  'ostra-test/engine')\n    uv sync --frozen\n    ;;\nesac\n") });
    const view = await member.environments.get({ projectId });
    expect(view.entries).toEqual([{ kind: "variable", repoId, name: "ENGINE_LOG_LEVEL", value: "", availableDuringSetup: false }]);
    // A save like any other: audited (naming the draft's repo), a new version, and the snapshot rebuilds.
    const saves = await harness.test.db.auditEntry.findMany({ where: { projectId, action: "environment.saved" }, orderBy: { createdAt: "asc" }, select: { data: true } });
    expect(saves).toHaveLength(2);
    expect(saves[1]?.data).toMatchObject({ repoDraft: "ostra-test/engine", variables: 1, hasSetupScript: true });
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "snapshot.schedule").map((job) => job.payload)).toEqual([expect.objectContaining({ projectId, reason: "environment-changed" })]);
    // The draft is done.
    expect(await member.environments.repoDrafts({ projectId })).toEqual([]);
    expect(await trpcFailure(admin.environments.applyRepoDraft({ projectId, repoId }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-112/c1: a plain saved script becomes a case on Apply, the old lines under the repo that ran them and the new lines under the new repo", async () => {
    const projectId = await savedProject("drafts-plain", PLAIN_SCRIPT);
    const admin = await harness.as(harness.fixture.a.admin);
    const { repoId } = await admin.projects.addRepo({ projectId, fullName: "ostra-test/engine" });
    const [draft] = await admin.environments.repoDrafts({ projectId });
    expect(draft).toMatchObject({ kind: "plain", savedTool: "pnpm", language: "python" });
    await admin.environments.applyRepoDraft({ projectId, repoId });
    expect((await stored(projectId)).setupScript).toBe(
      ["set -euo pipefail", 'case "$OSTRA_REPO" in', "  'ostra-test/web')", "corepack enable", "pnpm install --frozen-lockfile", "    ;;", "  'ostra-test/engine')", "    uv sync --frozen", "    ;;", "esac", ""].join("\n"),
    );
  });

  it("F-112/c1: Edit first saves through environments.save, which takes the draft in; Dismiss leaves the environment as it is, with Undo; removing the repo drops its draft", async () => {
    const projectId = await savedProject("drafts-dismiss", CASE_SCRIPT);
    const admin = await harness.as(harness.fixture.a.admin);
    const engine = await admin.projects.addRepo({ projectId, fullName: "ostra-test/engine" });
    const docs = await admin.projects.addRepo({ projectId, fullName: "ostra-test/docs" });
    // Two waiting, in the order they were added; detection found nothing in docs.
    expect((await admin.environments.repoDrafts({ projectId })).map((draft) => [draft.fullName, draft.kind])).toEqual([
      ["ostra-test/engine", "case"],
      ["ostra-test/docs", "nothing"],
    ]);
    expect(await trpcFailure(admin.environments.applyRepoDraft({ projectId, repoId: docs.repoId }))).toMatchObject({ code: "BAD_REQUEST" });

    await admin.environments.dismissRepoDraft({ projectId, repoId: docs.repoId });
    expect((await admin.environments.repoDrafts({ projectId })).map((draft) => draft.fullName)).toEqual(["ostra-test/engine"]);
    expect(await stored(projectId)).toEqual({ status: "saved", setupScript: CASE_SCRIPT });
    expect(await harness.test.db.auditEntry.count({ where: { projectId, action: "environment.repo-draft-dismissed" } })).toBe(1);
    await admin.environments.undoDismissRepoDraft({ projectId, repoId: docs.repoId });
    expect((await admin.environments.repoDrafts({ projectId })).map((draft) => draft.fullName)).toEqual(["ostra-test/engine", "ostra-test/docs"]);
    expect(await harness.test.db.auditEntry.count({ where: { projectId, action: "environment.repo-draft-restored" } })).toBe(1);

    // Edit first: the page puts the lines in its editors and saves them, naming the draft it took in.
    const [draft] = await admin.environments.repoDrafts({ projectId });
    await admin.environments.save({ projectId, environment: { baseImage: null, setupScript: draft?.script ?? null, envFiles: [], entries: [] }, repoDrafts: [engine.repoId] });
    expect((await admin.environments.repoDrafts({ projectId })).map((one) => one.fullName)).toEqual(["ostra-test/docs"]);

    // Removing the repo drops its draft.
    await admin.projects.removeRepo({ projectId, repoId: docs.repoId });
    expect(await admin.environments.repoDrafts({ projectId })).toEqual([]);
    expect(await harness.test.db.environmentRepoDraft.count({ where: { projectId } })).toBe(0);
  });

  it("F-112/c1: nothing waits when the saved script already runs what detection found, and a project still in draft is drafted again instead", async () => {
    const projectId = await savedProject("drafts-same", PLAIN_SCRIPT);
    const admin = await harness.as(harness.fixture.a.admin);
    expect((await admin.projects.addRepo({ projectId, fullName: "ostra-test/site" })).drafted).toBe(false);
    expect(await admin.environments.repoDrafts({ projectId })).toEqual([]);

    const draftProject = await admin.projects.create({ name: "drafts-draft", slug: "drafts-draft", access: "open", repo: { connectionId, installationId, fullName: "ostra-test/web" } });
    const added = await admin.projects.addRepo({ projectId: projectIdSchema.parse(draftProject.projectId), fullName: "ostra-test/engine" });
    expect(added.drafted).toBe(false);
    expect(await harness.test.db.environmentRepoDraft.count({ where: { repoId: repoIdSchema.parse(added.repoId) } })).toBe(0);
    expect((await stored(draftProject.projectId)).status).toBe("draft");
  });
});
