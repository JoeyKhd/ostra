// The services the end-to-end specs fake: the stub model endpoints and the fake GitHub. `stack.ts`
// starts them with its own stack. Run alone (`node e2e/fakes.ts`), they serve a stack someone else
// started, such as `docker compose up` on deploy/compose.yaml (F-076, ticket 22, `compose-e2e.sh`):
// the stack file the specs read is written as usual, and `.fakes.env` holds the fake GitHub's
// address for the server's OSTRA_GITHUB_API_URL. Both stop on SIGTERM or SIGINT.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { createFakeGitHub } from "@ostra/adapter-github/testing";
import type { FakeGitHub } from "@ostra/adapter-github/testing";
import { createFakeLinear, createScenarioBrain, startAnthropicStub, startOpenAiStub } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";

import { e2eGitHubOrgB, e2eModelToken, e2eOpenAiStubPort, e2eRepo, e2eStubModels, e2eStubPort } from "./settings.ts";

export type E2eFakes = {
  readonly github: FakeGitHub;
  /** Milestone 6 (ticket 34): the fake Linear the panel and core reach through OSTRA_LINEAR_API_URL. */
  readonly linear: FakeLinear;
  readonly close: () => Promise<void>;
};

/** Starts the two stub model endpoints and the fake GitHub, all on loopback. */
export const startFakes = async (): Promise<E2eFakes> => {
  // A stub model endpoint in Anthropic's format, for "Add a model provider" (spec section 8).
  const stub = await startAnthropicStub({
    realKey: e2eModelToken,
    models: e2eStubModels,
    brain: createScenarioBrain({}),
    host: "127.0.0.1",
    port: e2eStubPort,
  });
  // And one in the OpenAI-compatible format, so a provider is added in each format the form offers (F-088).
  const openAiStub = await startOpenAiStub({
    realKey: e2eModelToken,
    models: e2eStubModels,
    brain: createScenarioBrain({}),
    host: "127.0.0.1",
    port: e2eOpenAiStubPort,
  });

  // A fake GitHub the panel and core talk to through OSTRA_GITHUB_API_URL (ticket 37): one org with
  // one repo, and an App whose key and webhook secret the setup spec types into the panel.
  const github = await createFakeGitHub({
    // F-136: a second account with the App installed, waiting to be linked, and a second App another account owns.
    otherAccounts: [{ login: e2eGitHubOrgB.login, id: e2eGitHubOrgB.id, type: "Organization", installationId: e2eGitHubOrgB.installationId }],
    secondApp: { slug: "client-c-ostra", owner: { login: "client-c", id: 6_003, type: "Organization", installationId: 9 } },
    repos: [
      { id: 4_002, owner: e2eGitHubOrgB.login, name: e2eGitHubOrgB.repo, defaultBranch: "main", branches: ["main"], files: { "README.md": "# billing\n" } },
      {
        id: 4_001,
        owner: e2eRepo.owner,
        name: e2eRepo.name,
        defaultBranch: "main",
        branches: ["main"],
        files: {
          "package.json": JSON.stringify({ name: "test1", scripts: { test: "vitest run" }, packageManager: "pnpm@11.0.0" }),
          "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
          ".nvmrc": "24\n",
          "README.md": "# test1\n",
        },
      },
      // F-098 (ticket 39): a second repo of the same installation, for a project with several repos.
      { id: 4_003, owner: e2eRepo.owner, name: "test2", defaultBranch: "main", branches: ["main"], files: { "README.md": "# test2\n" } },
    ],
  });

  // Milestone 6 (ticket 34): a fake Linear (team `OST`, Linear's default states), which a spec
  // reaches with the admin's API key the stack file names: it seeds tickets and reads back what
  // core wrote, as the refine draft's "Update ticket" and "Mark ready" do.
  const linear = await createFakeLinear();

  const close = async (): Promise<void> => {
    await linear.close().catch(() => undefined);
    await github.close().catch(() => undefined);
    await stub.close().catch(() => undefined);
    await openAiStub.close().catch(() => undefined);
  };
  return { github, linear, close };
};

/**
 * The stack file the specs read (`readStack` in helpers.ts, gitignored): the database's address and
 * the fake GitHub's two Apps.
 */
export const writeStackFile = async (file: string, databaseUrl: string, github: FakeGitHub, linear: FakeLinear, dataDir: string | null = null): Promise<void> => {
  await writeFile(
    file,
    JSON.stringify({
      databaseUrl,
      // The server's data folder (its secrets key), for a seed that stores a secret; `null` for an outside stack.
      dataDir,
      linear: { apiUrl: linear.apiUrl, apiKey: linear.adminApiKey, teamId: linear.team.id, teamKey: linear.team.key },
      github: { appId: github.appId, privateKey: github.privateKey, webhookSecret: github.webhookSecret, slug: github.appSlug },
      githubB: {
        login: e2eGitHubOrgB.login,
        repo: e2eGitHubOrgB.repo,
        appId: github.secondApp?.appId ?? "",
        privateKey: github.secondApp?.privateKey ?? "",
        slug: github.secondApp?.appSlug ?? "",
      },
    }),
  );
};

const main = async (): Promise<void> => {
  const fakes = await startFakes();
  // An outside stack's database is its own; a spec that seeds rows needs OSTRA_E2E_DATABASE_URL.
  await writeStackFile(path.join(import.meta.dirname, ".stack.json"), process.env["OSTRA_E2E_DATABASE_URL"] ?? "", fakes.github, fakes.linear);
  await writeFile(path.join(import.meta.dirname, ".fakes.env"), `OSTRA_GITHUB_API_URL=${fakes.github.apiUrl}\nOSTRA_LINEAR_API_URL=${fakes.linear.apiUrl}\n`);
  console.log(`the fakes are up: GitHub at ${fakes.github.apiUrl}, the model stubs on ports ${String(e2eStubPort)} and ${String(e2eOpenAiStubPort)}`);
  const stop = (): void => {
    void fakes.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
