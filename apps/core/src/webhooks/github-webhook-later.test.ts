import { createHmac, randomUUID } from "node:crypto";

import { appEvents, GitHubAdapter } from "@ostra/adapter-github";
import { createFakeGitHub } from "@ostra/adapter-github/testing";
import type { FakeGitHub } from "@ostra/adapter-github/testing";
import { LinearAdapter } from "@ostra/adapter-linear";
import { silentLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import { createApiHarness, trpcFailure } from "@ostra/api/testing";
import type { ApiHarness, AppCaller } from "@ostra/api/testing";
import type { SeededMember } from "@ostra/db/testing";
import { systemClock } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import type { ConnectionId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCoreServer } from "../server.ts";
import type { CoreServer } from "../server.ts";
import { createWebhookInbox } from "./inbox.ts";

// F-006/c4: an App the manifest flow made while the server had no public address has no webhook
// and no events. The panel's API says so, and once the address is public it finishes the webhook
// later: ostra keeps a new secret and answers the App's own webhook address, the secret once and
// the events, for the App's settings on GitHub. Proved on the real GitHub adapter against the fake
// GitHub (its `no-hook-code` conversion hands back no webhook secret, as GitHub does for a
// manifest without `hook_attributes`), and on core's webhook inbox, which takes GitHub's
// deliveries for the App only once the secret is there.

const PRIVATE_URL = "http://localhost:8787";
const PUBLIC_URL = "https://ostra.example.com";

let harness: ApiHarness;
let github: FakeGitHub;
let host: GitHubAdapter;
let jobs: Jobs;
let server: CoreServer;
let base: string;

/** A caller as this member, with core at `corePublicUrl` and the real GitHub adapter on the fake GitHub. */
const callerAt = async (member: SeededMember, corePublicUrl: string): Promise<AppCaller> => {
  const context = await harness.contextOf(member);
  const { deps } = context;
  return harness.callerFor({
    ...context,
    deps: {
      ...deps,
      settings: { ...deps.settings, corePublicUrl },
      ports: { ...deps.ports, adapters: { ...deps.ports.adapters, codeHost: host } },
    },
  });
};

/** A `pull_request` delivery on the App's own installation, signed as GitHub signs it with `secret`. */
const delivery = (secret: string) => {
  const body = JSON.stringify({ action: "opened", number: 1, installation: { id: Number(github.installationId) } });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": randomUUID(),
      "x-github-hook-installation-target-id": github.appId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
  };
};

/** Posts a delivery to core's inbox at the path of a webhook address GitHub was given. */
const deliver = async (webhookUrl: string, sent: ReturnType<typeof delivery>): Promise<number> => {
  const response = await fetch(`${base}${new URL(webhookUrl).pathname}`, { method: "POST", headers: sent.headers, body: sent.body });
  await response.arrayBuffer();
  return response.status;
};

const rowOf = (connectionId: ConnectionId) => harness.test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });

beforeAll(async () => {
  harness = await createApiHarness();
  github = await createFakeGitHub({ repos: [{ id: 101, owner: "fake-org", name: "web", defaultBranch: "main", files: {}, branches: ["main"] }] });
  // A manifest without `hook_attributes` subscribes the App to no events.
  github.setAppEvents([]);
  const context = { logger: silentLogger, clock: adapterClock };
  host = new GitHubAdapter({ apiUrl: github.apiUrl, userAgent: "ostra-core/test" }, context);
  jobs = createJobs({ databaseUrl: harness.test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  const inbox = createWebhookInbox({
    db: harness.test.db,
    jobs,
    secretStore: harness.fakes.secretStore,
    trackerVerifiers: { linear: new LinearAdapter({ auth: { kind: "oauth", token: "verify-only" } }, context) },
    codeHost: host,
    clock: systemClock,
    logger: silentLogger,
    insertDeadlineMs: 5000,
    blocked: new Set(),
  });
  server = createCoreServer({ routes: [inbox.handle], upgrade: () => undefined, logger: silentLogger });
  base = `http://127.0.0.1:${String(await server.listen(0, "127.0.0.1"))}`;
});

afterAll(async () => {
  await server.close();
  await jobs.stop({ graceful: false });
  await github.close();
  await harness.dispose();
});

describe("F-006: an App made without a public address", () => {
  it("F-006/c4: has no webhook and no events, the API says so, and once the address is public it finishes the webhook later, which GitHub's deliveries then reach", async () => {
    const { a, b } = harness.fixture;
    const offline = await callerAt(a.admin, PRIVATE_URL);

    // The manifest flow with a private address: no webhook in the manifest, and GitHub hands back no secret.
    const started = await offline.github.startManifest({ ownerLogin: null });
    expect(started.webhookEnabled).toBe(false);
    expect(started.manifest).not.toHaveProperty("hook_attributes");
    expect(started.manifest).not.toHaveProperty("default_events");
    const { connectionId } = await offline.github.completeManifest({ code: "no-hook-code", state: started.state });
    expect((await rowOf(connectionId)).webhookSecretSecretRef).toBeNull();

    // The panel's API says the App takes no events: no webhook, and every event ostra uses missing.
    const [before] = await offline.github.connections();
    expect(before).toMatchObject({ connectionId, webhook: { kind: "none" }, missingEvents: [...appEvents] });
    // Core's inbox takes no delivery for it, whatever it's signed with.
    expect(await deliver(before?.webhookUrl ?? "", delivery("any-secret"))).toBe(404);

    // Finishing it waits for a public address: GitHub refuses a private one.
    const refused = await trpcFailure(offline.github.turnOnWebhook({ connectionId }));
    expect(refused.code).toBe("PRECONDITION_FAILED");
    expect(refused.message).toContain("OSTRA_CORE_PUBLIC_URL");
    expect((await rowOf(connectionId)).webhookSecretSecretRef).toBeNull();
    expect(await harness.test.db.auditEntry.count({ where: { action: "github.webhook-secret-set" } })).toBe(0);

    // Later, with a public address: the App's own webhook address, a secret shown once, and the events.
    const online = await callerAt(a.admin, PUBLIC_URL);
    const turned = await online.github.turnOnWebhook({ connectionId });
    expect(turned).toMatchObject({ connectionId, webhookUrl: `${PUBLIC_URL}/webhooks/github/${connectionId}`, events: [...appEvents], replaced: false });
    expect(turned.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    const row = await rowOf(connectionId);
    expect(row.webhookSecretSecretRef).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(turned.webhookSecret);
    expect(harness.fakes.secretStore.values()).toContain(turned.webhookSecret);
    const audit = await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "github.webhook-secret-set", organizationId: a.organization.id } });
    expect(audit).toMatchObject({ entityId: connectionId, data: { replaced: false } });
    expect(JSON.stringify(audit)).not.toContain(turned.webhookSecret);
    expect(JSON.stringify(harness.logs)).not.toContain(turned.webhookSecret);
    // Shown once: no view returns it.
    const [after] = await online.github.connections();
    expect(JSON.stringify([after, await online.github.connection()])).not.toContain(turned.webhookSecret);
    expect(after).toMatchObject({ webhookUrl: turned.webhookUrl, webhook: { kind: "receiving", lastDeliveryAt: null } });
    // Until the admin subscribes to them in the App's settings, the events are still missing.
    expect(after?.missingEvents).toEqual([...appEvents]);
    github.setAppEvents([...appEvents]);
    expect((await online.github.connections())[0]?.missingEvents).toEqual([]);

    // GitHub's deliveries, signed with that secret, now reach ostra; one signed otherwise doesn't.
    const first = delivery(turned.webhookSecret);
    expect(await deliver(turned.webhookUrl, first)).toBe(200);
    expect(await harness.test.db.webhookDelivery.count({ where: { connectionId, deliveryId: first.headers["x-github-delivery"] } })).toBe(1);
    expect(await deliver(turned.webhookUrl, delivery("not-the-secret"))).toBe(400);

    // A lost secret: called again, it replaces it, and the old one is gone from the store and refused.
    const again = await online.github.turnOnWebhook({ connectionId });
    expect(again.replaced).toBe(true);
    expect(again.webhookSecret).not.toBe(turned.webhookSecret);
    expect(harness.fakes.secretStore.values()).not.toContain(turned.webhookSecret);
    expect(await deliver(again.webhookUrl, delivery(turned.webhookSecret))).toBe(400);
    expect(await deliver(again.webhookUrl, delivery(again.webhookSecret))).toBe(200);

    // An organization admin's alone, and for the organization's own Apps.
    await expect((await callerAt(a.member, PUBLIC_URL)).github.turnOnWebhook({ connectionId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await callerAt(b.admin, PUBLIC_URL)).github.turnOnWebhook({ connectionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(harness.fakes.secretStore.values()).not.toContain(turned.webhookSecret);
  });
});
