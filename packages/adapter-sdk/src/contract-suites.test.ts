import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { organizationIdSchema, repoFullNameSchema } from "@ostra/protocol";
import { fixtureIds, taskSpecFixture } from "@ostra/protocol/testing";

import { memorySecretRowStore } from "./testing/memory.ts";
import { defineAgentContractSuite } from "./testing/agent-suite.ts";
import { defineCodeHostContractSuite } from "./testing/code-host-suite.ts";
import { defineExecutorContractSuite } from "./testing/executor-suite.ts";
import { defineBlobStoreContractSuite, defineNotificationContractSuite } from "./testing/first-case-suites.ts";
import { createJiraFakeSuiteSubject } from "./testing/jira-fake.ts";
import { defineTrackerContractSuite, defineTrackerFirstCases } from "./testing/tracker-suite.ts";
import { defineModelProviderContractSuite } from "./testing/model-provider-suite.ts";
import { defineSecretStoreContractSuite } from "./testing/secret-store-suite.ts";
import {
  killTree,
  scriptedDriver,
  signWebhook,
  TinyAgent,
  TinyBlobStore,
  TinyCodeHost,
  TinyExecutor,
  TinyModelProvider,
  TinyNotifier,
  TinySecretStore,
  TinyTracker,
} from "./test-adapters/tiny-adapters.ts";

// Every contract suite, run against this package's tiny adapters: the suites pass against an
// adapter that does what its kind promises.

defineTrackerFirstCases({ name: "tiny tracker", create: () => Promise.resolve({ adapter: new TinyTracker(), fixture: {} }) });
defineTrackerContractSuite({
  name: "the Jira fake",
  create: () => {
    const { adapter, fixture } = createJiraFakeSuiteSubject();
    return Promise.resolve({ adapter, fixture });
  },
});
defineNotificationContractSuite({
  name: "tiny notifier",
  create: () => Promise.resolve({ adapter: new TinyNotifier(), fixture: {} }),
});
defineBlobStoreContractSuite({
  name: "tiny blob store",
  create: () => Promise.resolve({ adapter: new TinyBlobStore(), fixture: {} }),
});

const repo = repoFullNameSchema.parse("test-org/test1");
const app = { appId: "42", privateKey: "-----BEGIN TEST KEY-----", slug: "ostra-tiny", name: "ostra tiny" };
const webhookBody = JSON.stringify({ action: "opened", number: 1 });

defineCodeHostContractSuite({
  name: "tiny code host",
  create: () =>
    Promise.resolve({
      adapter: new TinyCodeHost({
        app,
        installationId: "7",
        repos: [
          {
            hostRepoId: "1001",
            fullName: repo,
            defaultBranch: "main",
            files: { "package.json": "{}", ".github/pull_request_template.md": "## What\n" },
            branches: ["main", "ostra/contract"],
          },
        ],
      }),
      fixture: {
        app: { appId: app.appId, privateKey: app.privateKey },
        wrongApp: { appId: app.appId, privateKey: "wrong" },
        installationId: "7",
        access: { app: { appId: app.appId, privateKey: app.privateKey }, installationId: "7", repo },
        defaultBranch: "main",
        file: { path: "package.json", content: "{}" },
        missingPath: ".env.example",
        prTemplate: "## What\n",
        prHead: "ostra/contract",
        webhook: {
          headers: { "x-hub-signature-256": signWebhook("hook-secret", webhookBody) },
          body: webhookBody,
          secret: "hook-secret",
        },
      },
    }),
});

defineAgentContractSuite({
  name: "tiny agent on a scripted driver",
  create: () =>
    Promise.resolve({
      adapter: new TinyAgent(scriptedDriver()),
      fixture: {
        launchInput: {
          taskId: fixtureIds.task,
          sessionId: fixtureIds.session,
          workspaceDir: path.join(tmpdir(), "ostra-tiny-workspace"),
          agentDir: path.join(tmpdir(), "ostra-tiny-agent"),
          model: {
            endpointModelId: "test-model",
            apiFormat: "anthropic-messages",
            baseUrl: "http://127.0.0.1:9/key-proxy",
            placeholderKey: "placeholder-for-this-task",
          },
          mcp: { url: "http://127.0.0.1:9/mcp" },
          instructions: null,
          extraEnv: { NODE_ENV: "test" },
        },
        secrets: ["the-real-model-token", "the-real-git-token"],
        start: () =>
          Promise.resolve({
            io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
            stop: () => Promise.resolve(),
          }),
        simplePrompt: "simple",
        longPrompt: "long",
      },
    }),
});

const nodeLaunch = (cwd: string, script: string) => ({
  command: process.execPath,
  args: ["-e", script],
  cwd,
  env: { PATH: process.env["PATH"] ?? "" },
  files: [],
});

const isAlive = (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, 0);
    return Promise.resolve(true);
  } catch (error) {
    return Promise.resolve(Reflect.get(Object(error), "code") === "EPERM");
  }
};

defineExecutorContractSuite({
  name: "tiny executor",
  create: () =>
    Promise.resolve({
      adapter: new TinyExecutor(),
      fixture: {
        spec: { ...taskSpecFixture, environment: { ...taskSpecFixture.environment, setupScript: "console.log('set up')" } },
        failingSetupSpec: {
          ...taskSpecFixture,
          environment: { ...taskSpecFixture.environment, setupScript: "process.exit(3)" },
        },
        proxies: { gitBaseUrl: "http://127.0.0.1:9/git", modelBaseUrl: "http://127.0.0.1:9/model", mcpUrl: "http://127.0.0.1:9/mcp" },
        echoLaunch: (box) => nodeLaunch(box.workspaceDir, "process.stdin.pipe(process.stdout)"),
        detachedHelper: {
          // The agent starts a helper in its own session or console, writes its PID, and exits: the
          // helper is an orphan that walking the agent's tree can't reach.
          launch: (box) =>
            nodeLaunch(
              box.workspaceDir,
              [
                "const { spawn } = require('node:child_process');",
                "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
                "helper.unref();",
                "require('node:fs').writeFileSync('helper.pid', String(helper.pid));",
                "process.exit(0);",
              ].join("\n"),
            ),
          readPid: async (box) => {
            try {
              const pid = Number.parseInt(await readFile(path.join(box.workspaceDir, "helper.pid"), "utf8"), 10);
              return Number.isInteger(pid) && pid > 0 ? pid : null;
            } catch {
              return null;
            }
          },
          isAlive,
          kill: killTree,
        },
        cleanEnvHelper: {
          launch: (box) =>
            nodeLaunch(
              box.workspaceDir,
              [
                "const { spawn } = require('node:child_process');",
                "const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};",
                "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env });",
                "helper.unref();",
                "require('node:fs').writeFileSync('helper.pid', String(helper.pid));",
                "process.exit(0);",
              ].join("\n"),
            ),
          readPid: async (box) => {
            try {
              const pid = Number.parseInt(await readFile(path.join(box.workspaceDir, "helper.pid"), "utf8"), 10);
              return Number.isInteger(pid) && pid > 0 ? pid : null;
            } catch {
              return null;
            }
          },
          isAlive,
          kill: killTree,
        },
        knownGaps: {
          detachedHelper: "the tiny executor only ends the agent's own process tree",
          cleanEnvHelper: "the tiny executor only ends the agent's own process tree",
        },
      },
    }),
});

defineModelProviderContractSuite({
  name: "tiny model provider",
  create: () => {
    const endpoints = [
      {
        baseUrl: "http://stub.invalid/openai/v1",
        token: "stub-openai-token",
        apiFormat: "openai-compatible",
        authScheme: "bearer",
        models: ["gpt-test", "custom-model"],
      },
      {
        baseUrl: "http://stub.invalid/anthropic",
        token: "stub-anthropic-token",
        apiFormat: "anthropic-messages",
        authScheme: "x-api-key",
        models: ["claude-test"],
      },
    ] as const;
    return Promise.resolve({
      adapter: new TinyModelProvider(endpoints),
      fixture: {
        endpoints,
        wrongToken: "wrong-token",
        catalog: [
          {
            catalogId: "gpt-test",
            name: "GPT Test",
            aliases: [],
            contextWindow: 128_000,
            maxOutputTokens: 8192,
            inputPricePerMTok: 1,
            outputPricePerMTok: 2,
            logoPath: null,
          },
        ],
        knownModelId: "gpt-test",
        unknownModelId: "custom-model",
      },
    });
  },
});

defineSecretStoreContractSuite({
  name: "tiny secret store",
  create: () =>
    Promise.resolve({
      adapter: new TinySecretStore(memorySecretRowStore()),
      fixture: {
        organizationId: organizationIdSchema.parse("org-a"),
        otherOrganizationId: organizationIdSchema.parse("org-b"),
      },
    }),
});
