import { createLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { dispatchTask, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { providerIdSchema } from "@ostra/protocol";
import type { EventsFrame, ProviderId, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { runnerEvent } from "../testing/seed.ts";
import { dispatchPayload, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import type { QueuedTask } from "../testing/world.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "./ingest.ts";
import type { Ingest } from "./ingest.ts";
import { createLiveTextWriter } from "./live-text.ts";
import type { LiveTextWriter } from "./live-text.ts";

// F-088, F-089 (ticket 26): a rate limit the key proxy saw reaches the server as the runner's
// `provider.rate_limited` event, and holds the next dispatch on that provider, only.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let ingest: Ingest;
let liveText: LiveTextWriter;
let world: World;
let otherWorld: World;
let ours: RunnerRef;
let secondProviderId: ProviderId;
const logger = createLogger(() => undefined);

const rateLimited = (providerId: ProviderId, retryAfterSeconds: number): TaskEvent => ({ kind: "provider.rate_limited", providerId, retryAfterSeconds });
const frame = (...events: EventsFrame["events"]): EventsFrame => ({ type: "events", events });

const dispatch = (task: QueuedTask) =>
  test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger }, dispatchPayload(task)),
  );

const heldUntil = async (providerId: string): Promise<Date | null> =>
  (await test.db.modelProvider.findUniqueOrThrow({ where: { id: providerId } })).dispatchHeldUntil;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  const fakes = { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() };
  world = await seedWorld(test.db, fakes, fixture.a.organization.id, fixture.a.openProject.id);
  otherWorld = await seedWorld(test.db, fakes, fixture.b.organization.id, fixture.b.project.id, { fullName: "other-org/repo" });
  // A second provider in our own organization, which our task's model doesn't run on.
  const second = await test.db.modelProvider.create({
    data: { organizationId: world.organizationId, name: "Other endpoint", baseUrl: "https://other.example/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "ref" },
  });
  secondProviderId = providerIdSchema.parse(second.id);
  liveText = createLiveTextWriter({ db: test.db, logger, intervalMs: 50 });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger });
  ours = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 4);
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("a model provider's rate limit", () => {
  it("holds the next dispatch on that provider, and no other provider", async () => {
    const running = await seedQueuedTask(test.db, world, fixture.a.member, ours.runnerId);
    expect(await dispatch(running)).toMatchObject({ ok: true, runnerId: ours.runnerId });
    const waiting = await seedQueuedTask(test.db, world, fixture.a.member, ours.runnerId);

    const before = Date.now();
    const replies = await ingest(ours, frame(runnerEvent({ sessionId: running.sessionId }, 1, rateLimited(world.providerId, 120))));
    expect(replies).toEqual([{ type: "ack", sessionId: running.sessionId, upTo: 1 }]);

    const until = await heldUntil(world.providerId);
    expect(until?.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(until?.getTime()).toBeLessThanOrEqual(Date.now() + 120_000);
    // Another organization's provider, and another provider of ours, are untouched.
    expect(await heldUntil(otherWorld.providerId)).toBeNull();
    expect(await heldUntil(secondProviderId)).toBeNull();

    // The next dispatch waits, with the reason on the task.
    expect(await dispatch(waiting)).toMatchObject({ ok: false, error: "no-runner" });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: waiting.taskId } })).dispatchNote).toContain("rate limit");

    // A later, shorter hold never shortens it.
    await ingest(ours, frame(runnerEvent({ sessionId: running.sessionId }, 2, rateLimited(world.providerId, 5))));
    expect((await heldUntil(world.providerId))?.getTime()).toBe(until?.getTime());

    // Once the hold ends, the dispatch goes.
    await test.db.modelProvider.update({ where: { id: world.providerId }, data: { dispatchHeldUntil: new Date(Date.now() - 1_000) } });
    expect(await dispatch(waiting)).toMatchObject({ ok: true, runnerId: ours.runnerId });
  });

  it("holds only the provider the session's own model runs on", async () => {
    const task = await seedQueuedTask(test.db, world, fixture.a.member, ours.runnerId);
    expect(await dispatch(task)).toMatchObject({ ok: true });
    const replies = await ingest(
      ours,
      frame(
        runnerEvent({ sessionId: task.sessionId }, 1, rateLimited(otherWorld.providerId, 60)),
        runnerEvent({ sessionId: task.sessionId }, 2, rateLimited(secondProviderId, 60)),
      ),
    );
    // Both events are saved (the log keeps what the runner said); neither holds anything.
    expect(replies).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 2 }]);
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "provider.rate_limited" } })).toBe(2);
    expect(await heldUntil(otherWorld.providerId)).toBeNull();
    expect(await heldUntil(secondProviderId)).toBeNull();
    // Its own provider's earlier hold ended in the first case, and nothing here renewed it.
    expect((await heldUntil(world.providerId))?.getTime() ?? 0).toBeLessThan(Date.now());
  });
});
