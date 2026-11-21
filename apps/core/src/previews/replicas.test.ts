import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  createPanelPreviewTokens,
  dispatchTask,
  openView,
  panelPreviewPaths,
  postgresChangeNotices,
  postgresCommandOutbox,
  REPLICA_SIGNATURE_HEADER,
  signReplicaRequest,
  systemClock,
} from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { previewKeySchema, runnerPaths, tokenResponseSchema } from "@ostra/protocol";
import type { PreviewInputEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connectPeer, signAssertion } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { postJson } from "../testing/harness.ts";
import { connectFakeBox, openPanelStream } from "../testing/previews.ts";
import type { FakeBox, PanelStream } from "../testing/previews.ts";
import { freePort, registerRunnerAt, spawnCore, waitFor } from "../testing/restart.ts";
import type { CoreProcess, RegisteredAt } from "../testing/restart.ts";
import { dispatchPayload, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

// Milestone 8's ticket 19 (F-141, Q305, ADR 0068): two core processes on one database, each with
// its own `OSTRA_CORE_REPLICA_URL`, sharing the secrets key and the runner token key as replicas
// do. The box's preview connection lands on one; the panel's stream and input reach the other,
// which forwards them, signed, to the one in the view's presence. A forwarded request that doesn't
// verify is refused.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let a: CoreProcess | null = null;
let b: CoreProcess | null = null;
let runner: RegisteredAt;
let world: World;
let peer: FakePeer | null = null;
const secretsKey = generateSecretsKey();
const panelTokens = createPanelPreviewTokens(secretsKey);
const web = previewKeySchema.parse("app-web");
const scope = (): MemberScope => ({ organizationId: fixture.a.member.organizationId, memberId: fixture.a.member.id, role: "member", projectRoles: new Map() });

const started = (core: CoreProcess | null): CoreProcess => {
  if (core === null) {
    throw new Error("core isn't running");
  }
  return core;
};

const tokenAt = async (url: string): Promise<string> => {
  const response = await postJson(`${url}${runnerPaths.token}`, signAssertion(runner.key, runner.runnerId));
  return tokenResponseSchema.parse(response.body).accessToken;
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  // The queue's schema, installed once before either core starts.
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, fixture.a.organization.id, fixture.a.openProject.id);
  const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
  await test.db.appProcess.create({
    data: { organizationId: world.organizationId, projectId: world.projectId, environmentId: environment.id, repoId: world.repoId, name: "web", command: "pnpm dev", port: 5173, readyKind: "http", readyValue: "/", label: "Web", primary: true },
  });
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OSTRA_") && name !== "DATABASE_URL")),
    NODE_ENV: "test",
    DATABASE_URL: test.url,
    OSTRA_DATA_DIR: await mkdtemp(path.join(tmpdir(), "ostra-replicas-")),
    OSTRA_SECRETS_KEY: secretsKey,
    OSTRA_RUNNER_TOKEN_KEY: randomBytes(32).toString("hex"),
    OSTRA_CATALOG_FETCH: "false",
    OSTRA_BOOTSTRAP_JOIN_TOKEN: "false",
    // The seeded GitHub connection is a fake: nothing leaves this machine.
    OSTRA_GITHUB_API_URL: "http://127.0.0.1:9",
  };
  const replicaEnv = async (): Promise<NodeJS.ProcessEnv> => {
    const port = await freePort();
    return { ...env, OSTRA_CORE_PORT: String(port), OSTRA_CORE_REPLICA_URL: `http://127.0.0.1:${String(port)}` };
  };
  a = await spawnCore(await replicaEnv(), null);
  b = await spawnCore(await replicaEnv(), null);

  // The member's runner on `host`, at minor 7, connected to replica A.
  runner = await registerRunnerAt(a.url, test.db, fixture.a.member);
  peer = await connectPeer(a.url, await tokenAt(a.url), runner.runnerId, { preview: { stream: true, tunnel: true } });
  await peer.next("welcome");
}, 240_000);

afterAll(async () => {
  peer?.close();
  await Promise.all([a?.kill(), b?.kill()]);
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
}, 60_000);

const click: PreviewInputEvent = { kind: "mouse", action: "down", x: 10, y: 20, button: "left", clickCount: 1, modifiers: 0 };

describe("two core replicas", () => {
  it("F-141/c3: a view whose box connection is on the other replica streams, and a forwarded request with a wrong signature is refused", async () => {
    const replicaA = started(a);
    const replicaB = started(b);
    const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    const dispatched = await test.db.$transaction((tx) =>
      dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, personalSlots: 50 }, dispatchPayload(task, 1)),
    );
    expect(dispatched).toMatchObject({ ok: true, runnerId: runner.runnerId });
    await test.db.lease.updateMany({ where: { taskId: task.taskId }, data: { acceptedAt: new Date() } });
    const view = await openView(
      { db: test.db, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, settings: { warmMinutes: 60 }, panelTokens },
      { kind: "member", scope: scope() },
      { taskId: task.taskId, key: web, mode: "stream", viewport: null },
    );
    if (!view.ok) {
      throw new Error(view.error);
    }

    // The box's preview connection reaches replica A, which writes the view's presence.
    const box: FakeBox = await connectFakeBox(replicaA.url, view.viewId, 1, await tokenAt(replicaA.url));
    await waitFor("the view's presence on A", async () => (await test.db.previewView.findUniqueOrThrow({ where: { id: view.viewId } })).replicaUrl === replicaA.url, 10_000);

    // The panel's stream reaches replica B, which forwards it to A: the frames come through.
    const panel: PanelStream = await openPanelStream(replicaB.url, view.viewId, { authorization: `Bearer ${view.panelToken}` });
    expect(panel.status).toBe(200);
    box.sendFrame(1);
    expect((await panel.next("frame", 10_000)).header.seq).toBe(1);
    expect((await box.next("ack", 10_000)).ack.seq).toBe(1);
    box.sendFrame(2);
    expect((await panel.next("frame", 10_000)).header.seq).toBe(2);
    // So does the input, the other way.
    const input = await fetch(`${replicaB.url}${panelPreviewPaths.input(view.viewId)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${view.panelToken}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [click] }),
    });
    expect(input.status).toBe(204);
    expect((await box.next("control", 10_000)).control).toMatchObject({ kind: "input", events: [click] });

    // A forwarded request is taken on its signature alone, so one that doesn't verify is refused:
    // a wrong MAC, a key that isn't the replicas' own, and a signature older than 30 s.
    const path = panelPreviewPaths.stream(view.viewId);
    const forwarded = (signature: string): Promise<Response> => fetch(`${replicaA.url}${path}`, { headers: { [REPLICA_SIGNATURE_HEADER]: signature } });
    const refusals = [
      `${String(Date.now())}.${"A".repeat(43)}`,
      signReplicaRequest("not-the-replicas-key", { method: "GET", path, viewId: view.viewId, at: Date.now() }),
      signReplicaRequest(secretsKey, { method: "GET", path, viewId: view.viewId, at: Date.now() - 60_000 }),
      signReplicaRequest(secretsKey, { method: "GET", path: panelPreviewPaths.input(view.viewId), viewId: view.viewId, at: Date.now() }),
    ];
    for (const signature of refusals) {
      const answer = await forwarded(signature);
      expect([answer.status, await answer.json()]).toEqual([403, { error: { code: "forbidden", message: "a forwarded request whose signature doesn't verify" } }]);
    }
    // One signed under the shared key is a replica's: A serves it.
    const signed = await openPanelStream(replicaA.url, view.viewId, { [REPLICA_SIGNATURE_HEADER]: signReplicaRequest(secretsKey, { method: "GET", path, viewId: view.viewId, at: Date.now() }) });
    expect(signed.status).toBe(200);
    expect((await signed.next("frame", 10_000)).header.seq).toBe(2);
    signed.abort();
    panel.abort();
    box.close();
    await box.closed;
  }, 120_000);
});
