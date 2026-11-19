import { describe, expect, expectTypeOf, it } from "vitest";
import { boxIdSchema, taskIdSchema, uploadIdSchema } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";

import { AgentAdapter } from "./agent/base.ts";
import type { AgentLaunch, MappedUpdate } from "./agent/base.ts";
import type { AgentCapabilities } from "./agent/capabilities.ts";
import { BlobStoreAdapter } from "./blob-store/base.ts";
import { CodeHostAdapter } from "./code-host/base.ts";
import type { AdapterResult, HealthReport } from "./common/result.ts";
import { ExecutorAdapter } from "./executor/base.ts";
import { ModelProviderAdapter } from "./model-provider/base.ts";
import { NotificationAdapter } from "./notification/base.ts";
import { adapterKinds, createAdapterRegistry } from "./registry.ts";
import type { AdapterByKind } from "./registry.ts";
import { SecretStoreAdapter } from "./secret-store/base.ts";
import { TrackerAdapter } from "./tracker/base.ts";
import { memoryAdapterContext, memorySecretRowStore } from "./testing/memory.ts";
import {
  scriptedDriver,
  TinyAgent,
  TinyBlobStore,
  TinyCodeHost,
  TinyExecutor,
  TinyModelProvider,
  TinyNotifier,
  TinySecretStore,
  TinyTracker,
} from "./test-adapters/tiny-adapters.ts";

const ok = (): Promise<HealthReport> => Promise.resolve({ status: "ok" });

describe("the eight base classes", () => {
  const world = {
    app: { appId: "1", privateKey: "pem", slug: "tiny", name: "Tiny" },
    installationId: "1",
    repos: [],
  };
  const adapters = {
    tracker: new TinyTracker(),
    "code-host": new TinyCodeHost(world),
    agent: new TinyAgent(scriptedDriver()),
    executor: new TinyExecutor(),
    "model-provider": new TinyModelProvider([]),
    notification: new TinyNotifier(),
    "secret-store": new TinySecretStore(memorySecretRowStore()),
    "blob-store": new TinyBlobStore(),
  } satisfies AdapterByKind;

  it.each(adapterKinds.map((kind) => [kind] as const))("registers a %s adapter and looks it up typed", (kind) => {
    const registry = createAdapterRegistry();
    for (const adapter of Object.values(adapters)) {
      registry.register(adapter);
    }
    const found = registry.get(kind, adapters[kind].name);
    expect(found).toBe(adapters[kind]);
    expect(found?.kind).toBe(kind);
    expect(registry.list(kind)).toEqual([adapters[kind]]);
    expect(registry.get(kind, "nobody")).toBeUndefined();
  });

  it("types a lookup by kind as that kind's base class", () => {
    const registry = createAdapterRegistry();
    expectTypeOf(registry.get("code-host", "github")).toEqualTypeOf<CodeHostAdapter | undefined>();
    expectTypeOf(registry.get("executor", "host")).toEqualTypeOf<ExecutorAdapter | undefined>();
    expectTypeOf(registry.get("agent", "opencode")).toEqualTypeOf<AgentAdapter | undefined>();
    expectTypeOf(registry.list("secret-store")).toEqualTypeOf<readonly SecretStoreAdapter[]>();
  });

  it("refuses a second adapter of a kind with the same name", () => {
    const registry = createAdapterRegistry();
    registry.register(new TinyTracker());
    expect(() => {
      registry.register(new TinyTracker());
    }).toThrow(/already registered/);
  });

  it("gives every adapter the shared plumbing, with its kind and name on every log line", async () => {
    const context = memoryAdapterContext();
    class LoggingTracker extends TinyTracker {
      override readonly name = "logging-tracker";
      override health(): Promise<HealthReport> {
        this.plumbing.logger.info("checked", { boardCount: 0 });
        return ok();
      }
    }
    await new LoggingTracker(context).health();
    expect(context.logger.records).toEqual([
      {
        level: "info",
        message: "checked",
        fields: { adapterKind: "tracker", adapter: "logging-tracker", boardCount: 0 },
      },
    ]);
  });
});

// A missing operation is a type error: each class below leaves one out, and the compiler refuses it.
describe("a missing operation", () => {
  it("is a type error for every kind", () => {
    // @ts-expect-error getTicket and the others are missing.
    class NoTracker extends TrackerAdapter {
      readonly name = "no";
      readonly capabilities = {
        agentSessions: false,
        subIssues: false,
        statusGraph: false,
        webhooks: false,
        commentEdit: false,
        attachments: false,
        transitions: false,
        mentions: false,
      };
      health(): Promise<HealthReport> {
        return ok();
      }
    }
    // @ts-expect-error openPullRequest and the others are missing.
    class NoCodeHost extends CodeHostAdapter {
      readonly name = "no";
      readonly capabilities = { checkRuns: false, prTemplates: false, lfsActionHosts: [], branchRules: false, compare: false, draftPullRequests: false, prComments: false, userLink: false };
      health(): Promise<HealthReport> {
        return ok();
      }
    }
    // @ts-expect-error prepareLaunch is missing.
    class NoAgent extends AgentAdapter {
      readonly name = "no";
      readonly capabilities = {
        steerMidTurn: false,
        sessionLoad: false,
        nativePlan: false,
        rejectAndContinue: false,
        elicitationForm: false,
        modelBaseUrlAndPlaceholderKey: false,
        sessionArchive: false,
        permissionRules: "runner-only" as const,
        planMode: "none" as const,
        skills: false,
        mcp: { http: false, stdio: false },
        projectConfigOverride: false,
      };
      health(): Promise<HealthReport> {
        return ok();
      }
      protected mapUpdate(): MappedUpdate {
        return { handled: false };
      }
    }
    // @ts-expect-error create, prepare and the others are missing.
    class NoExecutor extends ExecutorAdapter {
      readonly name = "no";
      readonly capabilities = {
        isolation: "none",
        services: false,
        boxSizes: false,
        snapshots: "none",
        processContainment: "process-tree",
      } as const;
      health(): Promise<HealthReport> {
        return ok();
      }
    }
    // @ts-expect-error testConnection and the others are missing.
    class NoModelProvider extends ModelProviderAdapter {
      readonly name = "no";
      readonly capabilities = { apiFormats: [], modelList: false, usageInStream: false };
      health(): Promise<HealthReport> {
        return ok();
      }
    }
    // @ts-expect-error send is missing.
    class NoNotifier extends NotificationAdapter {
      readonly name = "no";
      readonly capabilities = { channels: [], edits: false };
      health(): Promise<HealthReport> {
        return ok();
      }
    }
    // @ts-expect-error put, get and delete are missing.
    class NoSecretStore extends SecretStoreAdapter {
      readonly name = "no";
      readonly capabilities = { rotation: false };
      health(): Promise<HealthReport> {
        return ok();
      }
    }
    // @ts-expect-error put and the others are missing.
    class NoBlobStore extends BlobStoreAdapter {
      readonly name = "no";
      readonly capabilities = { resumableUpload: false };
      health(): Promise<HealthReport> {
        return ok();
      }
    }
    expect([NoTracker, NoCodeHost, NoAgent, NoExecutor, NoModelProvider, NoNotifier, NoSecretStore, NoBlobStore]).toHaveLength(8);
  });

  it("is also a type error for a capability left out", () => {
    // @ts-expect-error steerMidTurn and the rest are missing from the declaration.
    const partial: AgentCapabilities = { sessionLoad: false };
    expect(partial).toEqual({ sessionLoad: false });
  });

  it("keeps launch results typed", async () => {
    const agent = new TinyAgent(scriptedDriver());
    expectTypeOf<Awaited<ReturnType<TinyAgent["prepareLaunch"]>>>().toEqualTypeOf<AdapterResult<AgentLaunch>>();
    expect(await agent.health()).toEqual({ status: "ok" });
  });
});

describe("milestone 2's executor operations", () => {
  it("answer unsupported until an executor has them", async () => {
    const executor = new TinyExecutor();
    const box = { taskId: taskIdSchema.parse("task-unsupported"), boxId: boxIdSchema.parse("box-unsupported") };
    const ran = await executor.runAgentCommand({ box, command: { command: "node", args: [], env: {}, cwd: "." }, timeoutMs: 1_000 });
    expect(ran.ok ? "ok" : ran.error.code).toBe("unsupported");
    const resumed = await executor.resumeBox({ ...box, spec: taskSpecFixture, proxies: { gitBaseUrl: "http://127.0.0.1:9", modelBaseUrl: "http://127.0.0.1:9", mcpUrl: "http://127.0.0.1:9" } });
    expect(resumed.ok ? "ok" : resumed.error.code).toBe("unsupported");
  });
});

describe("milestone 2's blob store operation", () => {
  it("abortUpload has nothing to drop by default, so a store that keeps its uploads in rows the server owns needs no code for it", async () => {
    const store = new TinyBlobStore();
    expect(await store.abortUpload(uploadIdSchema.parse("upload-that-never-was"))).toEqual({ ok: true, value: undefined });
  });
});
