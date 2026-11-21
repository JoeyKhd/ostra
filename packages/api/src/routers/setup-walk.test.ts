import { repoFullNameSchema, runnerIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureFirstAdmin } from "../auth/first-admin.ts";
import { createBareHarness, cookieHeaderFrom, TEST_PASSWORD } from "../testing/index.ts";
import type { BareHarness } from "../testing/index.ts";
import { createContext } from "../trpc/context.ts";

// F-076: a new organization walks the first-run checklist through the panel's own API, in its
// order: the admin account, a model provider, the GitHub App, the first project (its repo and its
// environment), a runner online, the first task from a prompt. Each step ticks only when the thing
// it asks for exists, and `next` is always the first step not done, whatever order the admin
// does them in. Only the code host and the model endpoint are fakes; the runner is a row, as core's
// gateway writes it (the real runner signing in is `apps/web/e2e/03-first-run.spec.ts`).

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nWALK-KEY-BODY-0123456789\n-----END RSA PRIVATE KEY-----";
const APP_ID = "7700001";
const MODEL_BASE_URL = "https://walk-models.example.com/v1";
const MODEL_TOKEN = "sk-walk-model-token-0123456789abcdef";

let harness: BareHarness;

beforeAll(async () => {
  harness = await createBareHarness();
});

afterAll(async () => {
  await harness.dispose();
});

const signedIn = async () => {
  const { headers } = await harness.auth.api.signInUsername({ body: { username: "walker", password: TEST_PASSWORD }, returnHeaders: true });
  return harness.callerFor(await createContext(harness.deps, { headers: cookieHeaderFrom(headers), resHeaders: new Headers() }));
};

describe("the first-run checklist, walked (F-076)", () => {
  it("F-076/c1: a new organization's checklist runs admin, model provider, GitHub App, project, runner, first task, and each step ticks only once done; once all are, setup stays done with every runner offline", async () => {
    const seeded = await ensureFirstAdmin({
      db: harness.test.db,
      settings: { firstAdmin: { email: "walker@example.com", username: "walker", password: TEST_PASSWORD, organizationName: "Walk Co" } },
      hashPassword: harness.deps.hashPassword,
      ports: harness.deps.ports,
      logger: harness.deps.logger,
    });
    if (seeded === null) throw new Error("the install already had an account");
    const admin = await signedIn();

    const status = async () => {
      const current = await admin.setup.status();
      return { order: current.steps.map((step) => step.id), done: current.steps.filter((step) => step.state === "done").map((step) => step.id), next: current.next };
    };
    const order = ["admin", "model-provider", "github", "linear", "project", "runner", "first-task"];

    // A new organization: only the admin account is done, and the next step is the model provider.
    expect(await status()).toEqual({ order, done: ["admin"], next: "model-provider" });

    // The GitHub App first, out of order: it ticks, but the next step is still the model provider.
    harness.fakes.codeHost.apps.set(APP_ID, {
      privateKey: PEM,
      info: { appId: APP_ID, slug: "walk-app", name: "walk", permissions: { checks: "write", actions: "read" }, events: [] },
      bot: { name: "walk-app[bot]", email: "1+walk-app[bot]@users.noreply.github.com" },
      installations: [{ installationId: "9100", accountLogin: "ostra-test", accountKind: "organization", repositorySelection: "all" }],
      repos: new Map([
        ["9100", [{ hostRepoId: "77", fullName: "ostra-test/test1", defaultBranch: "main", private: true, cloneUrl: "https://github.example/ostra-test/test1.git" }]],
      ]),
    });
    harness.fakes.codeHost.files.set("ostra-test/test1", new Map([["package.json", JSON.stringify({ scripts: { test: "vitest run" } })]]));
    const connected = await admin.github.connectExisting({ appId: APP_ID, privateKey: PEM, webhookSecret: "whsec-walk-0123456789" });
    expect(await status()).toEqual({ order, done: ["admin", "github"], next: "model-provider" });

    // A model provider.
    harness.fakes.modelProvider.endpoints.set(MODEL_BASE_URL, {
      token: MODEL_TOKEN,
      apiFormat: "anthropic-messages",
      authScheme: "x-api-key",
      models: [{ endpointModelId: "walk-model", displayName: "Walk model", contextWindow: 100_000 }],
    });
    const provider = await admin.providers.create({
      name: "Walk models",
      baseUrl: MODEL_BASE_URL,
      apiFormat: "anthropic-messages",
      authScheme: "x-api-key",
      sessionsAtOnce: null,
      allowOnPersonalRunners: true,
      token: MODEL_TOKEN,
    });
    const [model] = await admin.providers.models({ providerId: provider.providerId });
    if (model === undefined) throw new Error("the provider listed no model");
    await admin.agentProfiles.setDefaultModel({ modelId: model.id });
    // Linear is optional, and open until it is connected or set aside.
    expect(await status()).toEqual({ order, done: ["admin", "model-provider", "github"], next: "linear" });
    await admin.setup.skip({ step: "linear" });
    expect((await admin.setup.status()).steps.find((step) => step.id === "linear")?.state).toBe("skipped");
    expect(await status()).toEqual({ order, done: ["admin", "model-provider", "github"], next: "project" });

    // The first project, on a repo of the App's installation: it comes with its repo and its drafted environment.
    const project = await admin.projects.create({
      name: "Calculator",
      slug: "calculator",
      access: "open",
      repo: { connectionId: connected.connectionId, installationId: "9100", fullName: repoFullNameSchema.parse("ostra-test/test1") },
    });
    const row = await harness.test.db.project.findUniqueOrThrow({ where: { id: project.projectId }, include: { repos: true, environment: true } });
    expect(row.repos.map((repo) => repo.fullName)).toEqual(["ostra-test/test1"]);
    expect(row.environment?.status).toBe("draft");
    expect(await status()).toEqual({ order, done: ["admin", "model-provider", "github", "project"], next: "runner" });

    // A runner that is registered but offline doesn't tick the step; online, it does.
    const runner = await harness.test.db.runner.create({
      data: {
        organizationId: seeded.organizationId,
        kind: "personal",
        ownerMemberId: seeded.memberId,
        name: "walk-laptop",
        publicKey: "w".repeat(43),
        executor: "host",
        capacity: 1,
        version: "0.0.0",
        state: "offline",
      },
    });
    expect((await status()).next).toBe("runner");
    await harness.test.db.runner.update({ where: { id: runner.id }, data: { state: "online" } });
    expect(await status()).toEqual({ order, done: ["admin", "model-provider", "github", "project", "runner"], next: "first-task" });

    // The first task, from a prompt: the checklist is done.
    await admin.tasks.create({ projectId: project.projectId, prompt: "Add a short CONTRIBUTING.md", runnerId: runnerIdSchema.parse(runner.id) });
    expect(await status()).toEqual({ order, done: order.filter((id) => id !== "linear"), next: null });

    // Setup is done for good (2026-11-21): when every runner goes offline later, the runner step
    // opens again, and setup stays complete, from the time it was first done. Home says no runner is
    // online instead of bringing the checklist back; a member reads the same.
    const done = await admin.setup.status();
    expect(done).toMatchObject({ complete: true, runnerOnline: true });
    expect(done.completedAt).not.toBeNull();
    expect((await harness.test.db.organizationSetting.findUniqueOrThrow({ where: { organizationId: seeded.organizationId } })).setupCompletedAt?.getTime()).toBe(done.completedAt);
    await harness.test.db.runner.update({ where: { id: runner.id }, data: { state: "offline" } });
    const offline = await admin.setup.status();
    expect(offline).toMatchObject({ complete: true, completedAt: done.completedAt, runnerOnline: false, next: "runner" });
    expect(offline.steps.find((step) => step.id === "runner")?.state).toBe("open");
    // And when it comes back, nothing about the time it was done changes.
    await harness.test.db.runner.update({ where: { id: runner.id }, data: { state: "online" } });
    expect(await admin.setup.status()).toMatchObject({ complete: true, completedAt: done.completedAt, runnerOnline: true });
  });
});
