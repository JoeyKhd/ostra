import { randomUUID } from "node:crypto";

import { createDb, utcConnectionString } from "@ostra/db";
import { createTestDatabase } from "@ostra/db/testing";
import type { TestDatabase } from "@ostra/db/testing";
import { organizationIdSchema, ticketWriteIdSchema } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { cronPeriodSeconds, FORWARDING_HEARTBEAT_SECONDS, FORWARDING_QUEUE, queueSettings } from "./definitions.ts";
import { createJobs } from "./jobs.ts";
import type { Jobs } from "./jobs.ts";
import { createProducer } from "./producer.ts";

// Ticket 01: the gaps ADR 0037 lists after spike 8. The forwarding queue's heartbeat and its boot
// check, a schedule's slot, a group's limit, the panel's start against an empty schema, and UTC.

let test: TestDatabase;
const running: Jobs[] = [];

const start = async (role: "worker" | "enqueue-only", databaseUrl = test.url): Promise<Jobs> => {
  const jobs = createJobs({ databaseUrl, role, pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 5 });
  await jobs.start();
  running.push(jobs);
  return jobs;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await sleep(100);
  }
};

beforeAll(async () => {
  test = await createTestDatabase();
});

afterEach(async () => {
  for (const jobs of running.splice(0)) {
    await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  }
});

afterAll(async () => {
  await test.dispose();
});

const organizationId = organizationIdSchema.parse("org-jobs-m2");

describe("the forwarding queue's heartbeat and the boot check", () => {
  it("sets the heartbeat at a worker's start, and a forwarded occurrence carries it", async () => {
    const jobs = await start("worker");
    expect(await jobs.bootCheck()).toEqual({ ok: true });
    const rows = z
      .array(z.object({ heartbeat_seconds: z.number().nullable() }))
      .parse(await test.db.$queryRawUnsafe(`SELECT heartbeat_seconds FROM pgboss.queue WHERE name = '${FORWARDING_QUEUE}'`));
    expect(rows).toEqual([{ heartbeat_seconds: FORWARDING_HEARTBEAT_SECONDS }]);
    // A job takes its queue's heartbeat when it's inserted: a batch the cron pass forwards can't be
    // stranded for 15 minutes by a replica killed while it holds it.
    await test.db.$executeRawUnsafe(
      `INSERT INTO pgboss.job (name, data, heartbeat_seconds) SELECT name, '{}'::jsonb, heartbeat_seconds FROM pgboss.queue WHERE name = '${FORWARDING_QUEUE}'`,
    );
    const job = z
      .array(z.object({ heartbeat_seconds: z.number().nullable() }))
      .parse(await test.db.$queryRawUnsafe(`SELECT heartbeat_seconds FROM pgboss.job WHERE name = '${FORWARDING_QUEUE}' LIMIT 1`));
    expect(job[0]?.heartbeat_seconds).toBe(FORWARDING_HEARTBEAT_SECONDS);
    await test.db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = '${FORWARDING_QUEUE}'`);
  });

  it("refuses a forwarding queue without its heartbeat", async () => {
    const jobs = await start("worker");
    await test.db.$executeRawUnsafe(`UPDATE pgboss.queue SET heartbeat_seconds = NULL WHERE name = '${FORWARDING_QUEUE}'`);
    const checked = await jobs.bootCheck();
    expect(checked.ok).toBe(false);
    expect(checked.ok ? "" : checked.problems.join(" ")).toContain("heartbeatSeconds");
    // The next worker's start sets it again, and passes.
    const next = await start("worker");
    expect(await next.bootCheck()).toEqual({ ok: true });
  });

  it("refuses to start a worker whose sessions don't run in UTC", async () => {
    const url = new URL(test.url);
    url.searchParams.set("options", "-c TimeZone=Asia/Kolkata");
    const jobs = createJobs({ databaseUrl: url.toString(), role: "worker" });
    await expect(jobs.start()).rejects.toThrow(/not UTC/);
  });
});

describe("UTC on every connection (Q158)", () => {
  it("adds the time zone to a URL, keeps one already there, and the database reads UTC", async () => {
    expect(new URL(utcConnectionString("postgresql://u:p@h:5432/d")).searchParams.get("options")).toBe("-c TimeZone=UTC");
    expect(new URL(utcConnectionString("postgresql://u:p@h:5432/d?options=-c%20statement_timeout%3D5000")).searchParams.get("options")).toBe(
      "-c statement_timeout=5000 -c TimeZone=UTC",
    );
    const zoned = "postgresql://u:p@h:5432/d?options=-c%20TimeZone%3DEurope%2FParis";
    expect(utcConnectionString(zoned)).toBe(zoned);
    const db = createDb(test.url);
    try {
      expect(z.array(z.object({ TimeZone: z.string() })).parse(await db.$queryRawUnsafe("SHOW timezone"))).toEqual([{ TimeZone: "UTC" }]);
    } finally {
      await db.$disconnect();
    }
  });
});

describe("a schedule's slot", () => {
  it("is the cron's period, for the forms ostra uses", () => {
    expect(cronPeriodSeconds("* * * * *")).toBe(60);
    expect(cronPeriodSeconds("*/5 * * * *")).toBe(300);
    expect(cronPeriodSeconds("17 * * * *")).toBe(3600);
    expect(cronPeriodSeconds("0 3 * * *")).toBe(86_400);
    expect(cronPeriodSeconds("0 */6 * * *")).toBe(21_600);
    expect(cronPeriodSeconds("0 0 1 * *")).toBe(60);
  });

  it("is stored on the schedule with its key, so a replayed tick falls in the same slot", async () => {
    const jobs = await start("worker");
    await jobs.schedule("catalog.refresh", "daily", "0 3 * * *", {});
    const rows = z
      .array(z.object({ options: z.looseObject({ singletonKey: z.string(), singletonSeconds: z.number() }) }))
      .parse(await test.db.$queryRawUnsafe(`SELECT options FROM pgboss.schedule WHERE name = 'catalog.refresh' AND key = 'daily'`));
    expect(rows.map((row) => [row.options.singletonKey, row.options.singletonSeconds])).toEqual([["catalog:refresh", 86_400]]);
    await jobs.unschedule("catalog.refresh", "daily");
  });
});

describe("a throttled job's group", () => {
  it("never runs more than the group's limit at once, for the handlers", async () => {
    const limit = queueSettings["ticket.sync"].groupConcurrency;
    expect(limit).toBe(2);
    const jobs = await start("worker");
    let running = 0;
    let most = 0;
    let done = 0;
    await jobs.work(
      "ticket.sync",
      async () => {
        running += 1;
        most = Math.max(most, running);
        await sleep(300);
        running -= 1;
        done += 1;
      },
      { localConcurrency: 6 },
    );
    const group = { id: `connection-${randomUUID()}` };
    await test.db.$transaction(async (tx) => {
      for (let index = 0; index < 6; index += 1) {
        await jobs.enqueueInTx(tx, "ticket.sync", { organizationId, ticketWriteId: ticketWriteIdSchema.parse(`tw-${randomUUID()}`) }, { group });
      }
    });
    await waitFor(() => done === 6, 30_000);
    expect(most).toBeLessThanOrEqual(2);
    expect(most).toBeGreaterThan(0);
  }, 60_000);

  it("returns the first job for a duplicate send", async () => {
    const jobs = await start("worker");
    const payload = { organizationId, ticketWriteId: ticketWriteIdSchema.parse(`tw-${randomUUID()}`) };
    const [first, second] = await test.db.$transaction(async (tx) => [
      await jobs.sendInTx(tx, "ticket.sync", payload, { startAfterMs: 60_000 }),
      await jobs.sendInTx(tx, "ticket.sync", payload, { startAfterMs: 60_000 }),
    ]);
    expect(first.kind).toBe("enqueued");
    expect(second).toEqual({ kind: "existing", jobId: first.kind === "enqueued" ? first.jobId : null });
  });
});

describe("the panel's producer (Q157)", () => {
  it("reports itself starting against a database with no queue schema, and connects once core has made it", async () => {
    const empty = await createTestDatabase();
    try {
      const producer = createProducer(createJobs({ databaseUrl: empty.url, role: "enqueue-only" }), { initialDelayMs: 100, maxDelayMs: 400 });
      await sleep(300);
      expect(producer.state()).toBe("starting");
      await expect(
        empty.db.$transaction(async (tx) => {
          await producer.enqueueInTx(tx, "catalog.refresh", {});
        }),
      ).rejects.toThrow(/isn't installed yet/);
      // Core starts and installs the schema.
      await start("worker", empty.url);
      await producer.ready();
      expect(producer.state()).toBe("ready");
      await empty.db.$transaction(async (tx) => {
        await producer.enqueueInTx(tx, "catalog.refresh", {});
      });
      await producer.stop();
      expect(producer.state()).toBe("stopped");
    } finally {
      for (const jobs of running.splice(0)) {
        await jobs.stop({ graceful: false, timeoutMs: 2_000 });
      }
      await empty.dispose();
    }
  }, 60_000);
});
