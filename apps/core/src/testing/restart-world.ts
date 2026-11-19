import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { FakeGitHub } from "@ostra/adapter-github/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { generateSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { seedInstallation } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { providerIdSchema } from "@ostra/protocol";

import { openSecretStore } from "../secrets.ts";
import { freePort } from "./restart.ts";
import type { World } from "./world.ts";

// The world the restart harness's tests share (ticket 21's `restart.test.ts`, ticket 38's
// `failure-suite.test.ts`): organization A's model provider, model and OpenCode profile, the fake
// GitHub's App and repo, and a Linear connection made as the dev seed makes it (an API key, webhooks
// on) with the fake team's board. Secrets go into the store core reads, under the same key and data
// folder, and `env` is what a core process of the harness starts with.

export type RestartWorld = {
  readonly world: World;
  readonly env: NodeJS.ProcessEnv;
  readonly dataDir: string;
  readonly linearConnectionId: string;
  readonly boardId: string;
};

export const seedRestartWorld = async (input: {
  readonly test: TestDatabase;
  readonly fixture: IsolationFixture;
  readonly github: FakeGitHub;
  readonly linear: FakeLinear;
  /** The Linear connection's webhook secret, which the test signs its deliveries with. */
  readonly linearWebhookSecret: string;
}): Promise<RestartWorld> => {
  const { test, fixture, github, linear } = input;
  const dataDir = await mkdtemp(path.join(tmpdir(), "ostra-restart-"));
  const secretsKey = generateSecretsKey();
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OSTRA_") && name !== "DATABASE_URL")),
    NODE_ENV: "test",
    DATABASE_URL: test.url,
    OSTRA_DATA_DIR: dataDir,
    OSTRA_SECRETS_KEY: secretsKey,
    OSTRA_CORE_PORT: String(await freePort()),
    OSTRA_GITHUB_API_URL: github.apiUrl,
    OSTRA_CATALOG_FETCH: "false",
    CORE_TEST_LINEAR_API_URL: linear.apiUrl,
  };
  const secrets = await openSecretStore(test.db, { secretsKey, dataDir }, { logger: silentLogger, clock: adapterClock });
  const organizationId = fixture.a.organization.id;
  const projectId = fixture.a.openProject.id;
  const token = await secrets.put({ organizationId, purpose: "model-provider.token" }, "sk-restart-provider");
  const key = await secrets.put({ organizationId, purpose: "github-app.private-key" }, github.privateKey);
  if (!token.ok || !key.ok) {
    throw new Error("the secret store refused");
  }
  const provider = await test.db.modelProvider.create({
    data: { organizationId, name: "Dev", baseUrl: "https://models.example/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: token.value, allowOnPersonalRunners: true },
  });
  await test.db.providerListEntry.create({ data: { organizationId, projectId: null, providerId: provider.id } });
  const model = await test.db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId: "dev-model-1" } });
  const profile = await test.db.agentProfile.create({ data: { organizationId, name: "OpenCode", adapter: "opencode", modelId: model.id, builtIn: true } });
  await test.db.project.update({ where: { id: projectId }, data: { defaultCodeProfileId: profile.id } });
  const connection = await test.db.connection.create({
    data: { organizationId, kind: "github", appId: github.appId, slug: github.appSlug, botName: "ostra-fake[bot]", botEmail: "1+ostra-fake[bot]@users.noreply.github.com", privateKeySecretRef: key.value },
  });
  await seedInstallation(test.db, { organizationId, connectionId: connection.id, installationId: github.installationId });
  const repo = await test.db.repo.create({
    data: { organizationId, projectId, connectionId: connection.id, installationId: github.installationId, hostRepoId: "101", fullName: "fake-org/test1", defaultBranch: "main", checkoutDir: "test1" },
  });
  const world: World = { organizationId, projectId, providerId: providerIdSchema.parse(provider.id), profileId: profile.id, repoId: repo.id };
  const linearKey = await secrets.put({ organizationId, purpose: "linear.access-token" }, linear.adminApiKey);
  const webhookSecret = await secrets.put({ organizationId, purpose: "linear.webhook-secret" }, input.linearWebhookSecret);
  if (!linearKey.ok || !webhookSecret.ok) {
    throw new Error("the secret store refused");
  }
  const linearConnection = await test.db.connection.create({
    data: {
      organizationId,
      kind: "linear",
      appId: "api-key",
      state: "active",
      credentialKind: "api_key",
      webhookMode: "webhooks",
      accessTokenSecretRef: linearKey.value,
      webhookSecretSecretRef: webhookSecret.value,
      externalWorkspaceId: linear.organization.id,
    },
  });
  const states = linear.states(linear.team.id);
  const stateOf = (type: string, name?: string): string => states.find((state) => state.type === type && (name === undefined || state.name === name))?.id ?? "";
  const board = await test.db.board.create({
    data: {
      organizationId,
      projectId,
      connectionId: linearConnection.id,
      externalId: linear.team.id,
      key: linear.team.key,
      name: linear.team.name,
      statusMap: {
        open: [stateOf("triage"), stateOf("backlog"), stateOf("unstarted")],
        started: stateOf("started", "In Progress"),
        inReview: stateOf("started", "In Review"),
        done: stateOf("completed"),
        doneBy: "ostra",
        magicWord: "Closes",
      },
    },
  });
  return { world, env, dataDir, linearConnectionId: linearConnection.id, boardId: board.id };
};
