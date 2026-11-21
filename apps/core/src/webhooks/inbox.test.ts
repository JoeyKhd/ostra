import { createHmac, randomUUID } from "node:crypto";

import { GitHubAdapter } from "@ostra/adapter-github";
import { LinearAdapter } from "@ostra/adapter-linear";
import { createLogger, silentLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { CodeHostAdapter, LogRecord, TrackerAdapter } from "@ostra/adapter-sdk";
import { createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import type { JiraSite } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedInstallation, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { systemClock } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { JobContext, Jobs } from "@ostra/jobs";
import { connectionIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCoreServer } from "../server.ts";
import type { CoreServer } from "../server.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { createWebhookInbox, parseBlockedWebhooks, WEBHOOK_BODY_MAX_BYTES } from "./inbox.ts";
import type { WebhookKind } from "./inbox.ts";
import { webhookProcessHandler } from "./process.ts";
import type { WebhookDeliveryContext, WebhookOutcome } from "./process.ts";

// Ticket 13's cases: the inbox's order (verify, claim, 200), duplicates and replays, the deadline,
// refusals, and `webhook.process` acting once. The Jira fake stands in for Linear's verifier: both
// are tracker adapters, and the inbox only calls `verifyWebhook` through the shared interface.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let site: JiraSite;
let otherSite: JiraSite;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => {
  records.push(record);
});
let linearA: ConnectionId;
let linearB: ConnectionId;
let revoked: ConnectionId;
let githubA: ConnectionId;
const servers: CoreServer[] = [];

const APP_ID = "4242001";
const LINKED_INSTALLATION = 5150;

const keep = async (organizationId: OrganizationId, value: string): Promise<string> => {
  const ref = await secretStore.put({ organizationId, purpose: "linear.webhook-secret" }, value);
  if (!ref.ok) throw new Error("the fake secret store refused");
  return ref.value;
};

const startInbox = async (
  options: {
    readonly deadlineMs?: number;
    readonly blocked?: ReadonlySet<WebhookKind>;
    /** The real adapters' verifiers in place of the fakes: the vendors' own headers and signatures. */
    readonly vendors?: { readonly linear: Pick<TrackerAdapter, "verifyWebhook">; readonly github: Pick<CodeHostAdapter, "verifyWebhook"> };
  } = {},
): Promise<string> => {
  const inbox = createWebhookInbox({
    db: test.db,
    jobs,
    secretStore,
    trackerVerifiers: { linear: options.vendors?.linear ?? new JiraFakeAdapter({ site }) },
    codeHost: options.vendors?.github ?? codeHost,
    clock: systemClock,
    logger,
    insertDeadlineMs: options.deadlineMs ?? 2000,
    blocked: options.blocked ?? new Set(),
  });
  const server = createCoreServer({ routes: [inbox.handle], upgrade: () => undefined, logger: silentLogger });
  servers.push(server);
  const port = await server.listen(0, "127.0.0.1");
  return `http://127.0.0.1:${String(port)}`;
};

let base: string;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  site = createJiraSite();
  otherSite = createJiraSite();
  const orgA = fixture.a.organization.id;
  const orgB = fixture.b.organization.id;
  const linear = async (organizationId: OrganizationId, appId: string, secret: string, state: "active" | "revoked" = "active"): Promise<ConnectionId> => {
    const row = await test.db.connection.create({
      data: { organizationId, kind: "linear", appId, state, credentialKind: "app_oauth", webhookSecretSecretRef: await keep(organizationId, secret) },
    });
    return connectionIdSchema.parse(row.id);
  };
  linearA = await linear(orgA, "client-a", site.webhookSecret);
  linearB = await linear(orgB, "client-b", otherSite.webhookSecret);
  revoked = await linear(orgB, "client-revoked", site.webhookSecret, "revoked");
  const github = await test.db.connection.create({
    data: { organizationId: orgA, kind: "github", appId: APP_ID, webhookSecretSecretRef: await keep(orgA, codeHost.webhookSecret) },
  });
  githubA = connectionIdSchema.parse(github.id);
  // Milestone 4 (F-136): GitHub's deliveries are stored only from a linked installation.
  await seedInstallation(test.db, { organizationId: orgA, connectionId: githubA, installationId: String(LINKED_INSTALLATION) });
  base = await startInbox();
});

afterAll(async () => {
  for (const server of servers) await server.close();
  await jobs.stop({ graceful: false });
  await test.dispose();
});

type Delivery = { readonly rawBody: Uint8Array; readonly headers: Readonly<Record<string, string>> };

const issueDelivery = (sentAt = Date.now()): Delivery => {
  const issue = site.createIssue(site.projects[0]?.id ?? "", { summary: "A ticket" });
  return site.signedDelivery({ externalId: issue.externalId, byAccountId: site.personAccountId, sentAt });
};

/** A delivery signed with the site's secret, its body chosen by the test. */
const customDelivery = (body: Record<string, unknown>, secret = site.webhookSecret): Delivery => {
  const rawBody = new TextEncoder().encode(JSON.stringify(body));
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-atlassian-webhook-identifier": randomUUID(),
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
    },
  };
};

const post = async (path: string, delivery: { readonly rawBody: Uint8Array | string; readonly headers: Readonly<Record<string, string>> }, url = base) => {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: delivery.headers, body: delivery.rawBody });
  const body: unknown = await response.json();
  return { status: response.status, body };
};

const deliveryIdOf = (delivery: Delivery): string => delivery.headers["x-atlassian-webhook-identifier"] ?? "";

const rowsOf = (connectionId: ConnectionId, deliveryId: string) => test.db.webhookDelivery.findMany({ where: { connectionId, deliveryId } });

const jobsOf = async (organizationId: OrganizationId, connectionId: ConnectionId, deliveryId: string) =>
  jobs.find("webhook.process", { organizationId, connectionId, deliveryId: webhookDeliveryIdSchema.parse(deliveryId) });

const jobContext = (organizationId: OrganizationId, connectionId: ConnectionId, deliveryId: string, retryCount = 0): JobContext<"webhook.process"> => ({
  job: "webhook.process",
  jobId: jobIdSchema.parse(randomUUID()),
  key: null,
  retryCount,
  payload: { organizationId, connectionId, deliveryId: webhookDeliveryIdSchema.parse(deliveryId) },
  logger,
});

describe("the webhook inbox", () => {
  it("stores a valid delivery once, with its payload, transit and signature hash, and enqueues webhook.process once", async () => {
    const delivery = issueDelivery(Date.now() - 1500);
    const answer = await post(`/webhooks/linear/${linearA}`, delivery);
    expect(answer).toEqual({ status: 200, body: { status: "accepted" } });
    const rows = await rowsOf(linearA, deliveryIdOf(delivery));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ organizationId: fixture.a.organization.id, status: "received", event: "unknown" });
    expect(row?.signatureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.transitMs).toBeGreaterThanOrEqual(1500);
    expect(row?.payload).toMatchObject({ webhookEvent: "jira:issue_updated" });
    expect(await jobsOf(fixture.a.organization.id, linearA, deliveryIdOf(delivery))).toHaveLength(1);
  });

  it("stores and enqueues once when the same delivery arrives twice at the same moment", async () => {
    const delivery = issueDelivery();
    const answers = await Promise.all([post(`/webhooks/linear/${linearA}`, delivery), post(`/webhooks/linear/${linearA}`, delivery), post(`/webhooks/linear/${linearA}`, delivery)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(answers.filter((answer) => JSON.stringify(answer.body).includes("accepted"))).toHaveLength(1);
    expect(await rowsOf(linearA, deliveryIdOf(delivery))).toHaveLength(1);
    expect(await jobsOf(fixture.a.organization.id, linearA, deliveryIdOf(delivery))).toHaveLength(1);
  });

  it("claims a Linear delivery by its signature too: the same body under a new delivery ID is a duplicate", async () => {
    const delivery = issueDelivery();
    await post(`/webhooks/linear/${linearA}`, delivery);
    const again = { ...delivery, headers: { ...delivery.headers, "x-atlassian-webhook-identifier": randomUUID() } };
    expect(await post(`/webhooks/linear/${linearA}`, again)).toEqual({ status: 200, body: { status: "duplicate" } });
    expect(await rowsOf(linearA, deliveryIdOf(again))).toHaveLength(0);
  });

  it("answers 503 to an insert past its deadline, and stores nothing half-done; the sender's retry is stored", async () => {
    const slow = await startInbox({ deadlineMs: 300 });
    const delivery = issueDelivery();
    const deliveryId = deliveryIdOf(delivery);
    // Another transaction holds the same delivery's claim, uncommitted: the insert waits on it.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const blocker = test.db
      .$transaction(
        async (tx) => {
          await tx.webhookDelivery.create({ data: { organizationId: fixture.a.organization.id, connectionId: linearA, deliveryId, event: "blocker" } });
          inserted();
          await gate;
          throw new Error("roll the blocker back");
        },
        { timeout: 20_000 },
      )
      .catch(() => undefined);
    await holding;
    const started = Date.now();
    const answer = await post(`/webhooks/linear/${linearA}`, delivery, slow);
    expect(answer.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2000);
    // Past the insert's own timeout, the blocker rolls back: the slow insert must not land now.
    await new Promise((resolve) => setTimeout(resolve, 700));
    release();
    await blocker;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await rowsOf(linearA, deliveryId)).toHaveLength(0);
    expect(await jobsOf(fixture.a.organization.id, linearA, deliveryId)).toHaveLength(0);
    // The sender retries (Linear: after a minute): now it's stored, once.
    expect((await post(`/webhooks/linear/${linearA}`, delivery)).status).toBe(200);
    expect(await rowsOf(linearA, deliveryId)).toHaveLength(1);
    expect(await jobsOf(fixture.a.organization.id, linearA, deliveryId)).toHaveLength(1);
  });

  it("refuses a bad signature and a stale timestamp with 400, stores nothing, and logs why without the body", async () => {
    const marker = `ticket-text-${randomUUID()}`;
    const forged = customDelivery({ timestamp: Date.now(), webhookEvent: "jira:issue_updated", summary: marker }, "not-the-secret");
    expect(await post(`/webhooks/linear/${linearA}`, forged)).toEqual({ status: 400, body: { error: "bad-signature" } });
    const stale = customDelivery({ timestamp: Date.now() - 120_000, webhookEvent: "jira:issue_updated", summary: marker });
    expect(await post(`/webhooks/linear/${linearA}`, stale)).toEqual({ status: 400, body: { error: "stale" } });
    const unsigned = { rawBody: forged.rawBody, headers: { "content-type": "application/json" } };
    expect((await post(`/webhooks/linear/${linearA}`, unsigned)).status).toBe(400);
    expect(await rowsOf(linearA, deliveryIdOf(forged))).toHaveLength(0);
    expect(await rowsOf(linearA, deliveryIdOf(stale))).toHaveLength(0);
    const refusals = records.filter((record) => record.message === "webhook.refused");
    expect(refusals.some((record) => record.fields["reason"] === "stale" && record.fields["connectionId"] === linearA)).toBe(true);
    expect(JSON.stringify(records)).not.toContain(marker);
  });

  it("refuses another organization's connection, an unknown one and a revoked one, and stores nothing", async () => {
    // Organization A's delivery sent to organization B's address: B's secret doesn't verify it.
    const delivery = issueDelivery();
    expect((await post(`/webhooks/linear/${linearB}`, delivery)).status).toBe(400);
    expect(await rowsOf(linearB, deliveryIdOf(delivery))).toHaveLength(0);
    expect((await post(`/webhooks/linear/${randomUUID()}`, delivery)).status).toBe(404);
    expect((await post(`/webhooks/linear/${revoked}`, delivery)).status).toBe(404);
    // A GitHub connection's ID on the Linear route is no Linear connection.
    expect((await post(`/webhooks/linear/${githubA}`, delivery)).status).toBe(404);
    expect(await test.db.webhookDelivery.count({ where: { deliveryId: deliveryIdOf(delivery) } })).toBe(0);
  });

  it("refuses a body over 1 MiB with 413", async () => {
    const big = customDelivery({ timestamp: Date.now(), webhookEvent: "jira:issue_updated", padding: "x".repeat(WEBHOOK_BODY_MAX_BYTES) });
    expect((await post(`/webhooks/linear/${linearA}`, big)).status).toBe(413);
  });

  it("stores a skewed sender's transit and logs a warning naming the connection", async () => {
    const delivery = issueDelivery(Date.now() - 30_000);
    expect((await post(`/webhooks/linear/${linearA}`, delivery)).status).toBe(200);
    const [row] = await rowsOf(linearA, deliveryIdOf(delivery));
    expect(row?.transitMs).toBeGreaterThanOrEqual(30_000);
    expect(records.some((record) => record.message === "webhook.clock-skew" && record.fields["connectionId"] === linearA)).toBe(true);
  });

  it("takes GitHub's deliveries on the connection's address and on milestone 1's App-wide one", async () => {
    const body = JSON.stringify({ action: "opened", zen: "hello", installation: { id: LINKED_INSTALLATION } });
    const headers = codeHost.sign(body, "pull_request");
    expect(await post(`/webhooks/github/${githubA}`, { rawBody: body, headers })).toEqual({ status: 200, body: { status: "accepted" } });
    const [row] = await rowsOf(githubA, headers["x-github-delivery"] ?? "");
    expect(row).toMatchObject({ event: "pull_request", signatureHash: null, transitMs: null });
    const appWide = codeHost.sign(body, "pull_request");
    expect((await post("/webhooks/github", { rawBody: body, headers: { ...appWide, "x-github-hook-installation-target-id": APP_ID } })).status).toBe(200);
    expect(await rowsOf(githubA, appWide["x-github-delivery"] ?? "")).toHaveLength(1);
    // A bad signature, and the App-wide address without the App's ID.
    expect((await post(`/webhooks/github/${githubA}`, { rawBody: body, headers: { ...headers, "x-hub-signature-256": "sha256=00" } })).status).toBe(400);
    expect((await post("/webhooks/github", { rawBody: body, headers: codeHost.sign(body, "ping") })).status).toBe(404);
  });

  it("answers 503 and stores nothing on a blocked route (OSTRA_DEV_BLOCK_WEBHOOKS), outside production only", async () => {
    expect([...parseBlockedWebhooks("linear, github", "development")]).toEqual(["linear", "github"]);
    expect([...parseBlockedWebhooks("linear", "production")]).toEqual([]);
    expect([...parseBlockedWebhooks(undefined, "development")]).toEqual([]);
    const blocked = await startInbox({ blocked: parseBlockedWebhooks("linear", "development") });
    const delivery = issueDelivery();
    expect((await post(`/webhooks/linear/${linearA}`, delivery, blocked)).status).toBe(503);
    expect(await rowsOf(linearA, deliveryIdOf(delivery))).toHaveLength(0);
    const body = JSON.stringify({ action: "closed", installation: { id: LINKED_INSTALLATION } });
    expect((await post(`/webhooks/github/${githubA}`, { rawBody: body, headers: codeHost.sign(body, "pull_request") }, blocked)).status).toBe(200);
  });

  it("measures the time to the 200 over 200 deliveries", async () => {
    const times: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const delivery = issueDelivery();
      const started = performance.now();
      const answer = await post(`/webhooks/linear/${linearA}`, delivery);
      times.push(performance.now() - started);
      expect(answer.status).toBe(200);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)] ?? 0;
    const p99 = times[Math.floor(times.length * 0.99)] ?? 0;
    console.info(`webhook inbox, 200 deliveries: p50 ${p50.toFixed(1)} ms, p99 ${p99.toFixed(1)} ms`);
    expect(p99).toBeLessThan(2000);
  });

  it("F-046/c1: a delivery its vendor sends again is stored and handled once, by the vendor's delivery ID: Linear's retry signed afresh under its Linear-Delivery, GitHub's redelivery under its X-GitHub-Delivery", async () => {
    const context = { logger: silentLogger, clock: adapterClock };
    const vendors = { linear: new LinearAdapter({ auth: { kind: "oauth", token: "verify-only" } }, context), github: new GitHubAdapter({}, context) };
    const url = await startInbox({ vendors });
    const organizationId = fixture.a.organization.id;
    // Organization A's connections and their secrets, signed here as the vendors sign.
    const [linear, linearSecret, github, githubSecret] = [linearA, site.webhookSecret, githubA, codeHost.webhookSecret];

    // Linear: one payload, its delivery ID; each attempt is stamped and signed when it's sent, so a retry's signature differs.
    const linearId = randomUUID();
    const linearAttempt = (sentAt: number) => {
      const rawBody = JSON.stringify({ type: "Issue", action: "update", data: { id: "issue-vendor-1" }, createdAt: new Date(sentAt - 500).toISOString(), webhookTimestamp: sentAt });
      const signature = createHmac("sha256", linearSecret).update(rawBody).digest("hex");
      return { rawBody, headers: { "content-type": "application/json", "linear-delivery": linearId, "linear-event": "Issue", "linear-signature": signature } };
    };
    const first = linearAttempt(Date.now() - 2000);
    const retry = linearAttempt(Date.now());
    expect(retry.headers["linear-signature"]).not.toBe(first.headers["linear-signature"]);
    expect(await post(`/webhooks/linear/${linear}`, first, url)).toEqual({ status: 200, body: { status: "accepted" } });
    expect(await post(`/webhooks/linear/${linear}`, retry, url)).toEqual({ status: 200, body: { status: "duplicate" } });
    expect(await rowsOf(linear, linearId)).toHaveLength(1);
    expect(await jobsOf(organizationId, linear, linearId)).toHaveLength(1);

    // GitHub: a redelivery carries the original's X-GitHub-Delivery and body.
    const githubId = randomUUID();
    const rawBody = JSON.stringify({ action: "synchronize", number: 7, installation: { id: LINKED_INSTALLATION } });
    const signed = {
      rawBody,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": githubId,
        "x-hub-signature-256": `sha256=${createHmac("sha256", githubSecret).update(rawBody).digest("hex")}`,
      },
    };
    expect(await post(`/webhooks/github/${github}`, signed, url)).toEqual({ status: 200, body: { status: "accepted" } });
    expect(await post(`/webhooks/github/${github}`, signed, url)).toEqual({ status: 200, body: { status: "duplicate" } });
    expect(await rowsOf(github, githubId)).toHaveLength(1);
    expect(await jobsOf(organizationId, github, githubId)).toHaveLength(1);
  });
});

describe("webhook.process", () => {
  const counting = () => {
    const seen: WebhookDeliveryContext[] = [];
    let answer: WebhookOutcome | Error = { outcome: "processed", ticketKey: "JIRA-1" };
    const handler = (context: WebhookDeliveryContext): Promise<WebhookOutcome> => {
      seen.push(context);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    };
    return {
      seen,
      set: (next: WebhookOutcome | Error) => {
        answer = next;
      },
      deps: { db: test.db, clock: systemClock, handlers: { linear: handler, github: handler } },
    };
  };

  it("dispatches by kind, marks the delivery processed with its ticket key, sets lastEventAt, and never acts twice", async () => {
    const handlers = counting();
    const delivery = issueDelivery();
    await post(`/webhooks/linear/${linearA}`, delivery);
    const deliveryId = deliveryIdOf(delivery);
    const run = webhookProcessHandler(handlers.deps);
    await run(jobContext(fixture.a.organization.id, linearA, deliveryId));
    await run(jobContext(fixture.a.organization.id, linearA, deliveryId));
    expect(handlers.seen).toHaveLength(1);
    expect(handlers.seen[0]?.payload).toMatchObject({ webhookEvent: "jira:issue_updated" });
    const [row] = await rowsOf(linearA, deliveryId);
    expect(row).toMatchObject({ status: "processed", ticketKey: "JIRA-1", error: null });
    expect(row?.processedAt).not.toBeNull();
    const connection = await test.db.connection.findUniqueOrThrow({ where: { id: linearA } });
    expect(connection.lastEventAt?.getTime()).toBe(row?.receivedAt.getTime());
  });

  it("a replay of every stored delivery changes nothing: no new row, no new job, no second act", async () => {
    const handlers = counting();
    const run = webhookProcessHandler(handlers.deps);
    const delivery = issueDelivery();
    await post(`/webhooks/linear/${linearA}`, delivery);
    const body = JSON.stringify({ action: "synchronize", installation: { id: LINKED_INSTALLATION } });
    const github = { rawBody: body, headers: codeHost.sign(body, "pull_request") };
    await post(`/webhooks/github/${githubA}`, github);
    const stored = await test.db.webhookDelivery.findMany({ where: { connectionId: { in: [linearA, githubA] }, event: { not: "blocker" } } });
    for (const row of stored) {
      await run(jobContext(fixture.a.organization.id, connectionIdSchema.parse(row.connectionId), row.deliveryId));
    }
    const acted = handlers.seen.length;
    const before = await test.db.webhookDelivery.count();
    for (const replay of [delivery, delivery]) {
      expect((await post(`/webhooks/linear/${linearA}`, replay)).body).toEqual({ status: "duplicate" });
    }
    expect((await post(`/webhooks/github/${githubA}`, github)).body).toEqual({ status: "duplicate" });
    for (const row of stored) {
      expect(await jobsOf(fixture.a.organization.id, connectionIdSchema.parse(row.connectionId), row.deliveryId)).toHaveLength(1);
      await run(jobContext(fixture.a.organization.id, connectionIdSchema.parse(row.connectionId), row.deliveryId));
    }
    expect(await test.db.webhookDelivery.count()).toBe(before);
    expect(handlers.seen.length).toBe(acted);
  });

  it("marks an ignored or failed delivery with its reason, retries a thrown error, and fails it on the last retry", async () => {
    const handlers = counting();
    const run = webhookProcessHandler(handlers.deps);
    const ignored = issueDelivery();
    await post(`/webhooks/linear/${linearA}`, ignored);
    handlers.set({ outcome: "ignored", reason: "the connection's own change" });
    await run(jobContext(fixture.a.organization.id, linearA, deliveryIdOf(ignored)));
    expect((await rowsOf(linearA, deliveryIdOf(ignored)))[0]).toMatchObject({ status: "ignored", error: "the connection's own change" });

    const flaky = issueDelivery();
    await post(`/webhooks/linear/${linearA}`, flaky);
    handlers.set(new Error("tracker down"));
    await expect(run(jobContext(fixture.a.organization.id, linearA, deliveryIdOf(flaky)))).rejects.toThrow("tracker down");
    expect((await rowsOf(linearA, deliveryIdOf(flaky)))[0]?.status).toBe("received");
    await run(jobContext(fixture.a.organization.id, linearA, deliveryIdOf(flaky), 8));
    const [failed] = await rowsOf(linearA, deliveryIdOf(flaky));
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("gave up after 9 attempts");
  });
});
