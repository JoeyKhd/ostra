import { hmacSha256Hex } from "@ostra/adapter-sdk";
import { describe, expect, it } from "vitest";

import { JIRA_WEBHOOK_EVENTS, JIRA_WEBHOOK_MAX_AGE_MS, jiraWebhookHint, verifyJiraWebhook, webhookJql } from "./webhooks.ts";

// The admin webhook's signature, as Atlassian documents it
// (https://developer.atlassian.com/cloud/jira/platform/webhooks/, "Securing admin webhooks"):
// `X-Hub-Signature: sha256=<hex>`, an HMAC-SHA256 of the body with the shared secret.

const SECRET = "jira-webhook-secret";
const NOW = 1_795_428_000_000;

const delivery = (body: unknown, options: { readonly secret?: string; readonly identifier?: string; readonly method?: string } = {}) => {
  const rawBody = new TextEncoder().encode(JSON.stringify(body));
  return {
    rawBody,
    headers: {
      "x-hub-signature": `${options.method ?? "sha256"}=${hmacSha256Hex(options.secret ?? SECRET, rawBody)}`,
      "x-atlassian-webhook-identifier": options.identifier ?? "4242",
    },
    secret: SECRET,
    now: NOW,
  };
};

const issueEvent = (event: string, sentAt = NOW - 1000, accountId = "557058:person") => ({
  timestamp: sentAt,
  webhookEvent: event,
  user: { accountId, accountType: "atlassian" },
  issue: { id: "10042", key: "PROJ-7", fields: { project: { id: "10000", key: "PROJ" }, summary: "Fix $(whoami)" } },
});

describe("the admin webhook", () => {
  it("F-008/c3: matches Atlassian's own test vector for the signature", () => {
    // From the docs: secret "It's a Secret to Everybody", payload "Hello World!".
    const signature = hmacSha256Hex("It's a Secret to Everybody", new TextEncoder().encode("Hello World!"));
    expect(`sha256=${signature}`).toBe("sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9");
  });

  it("F-008/c3: verifies a signed delivery, and refuses a bad signature, none, another method, and a wrong secret", () => {
    const good = delivery(issueEvent("jira:issue_updated"));
    const verified = verifyJiraWebhook(good);
    expect(verified).toMatchObject({ ok: true, deliveryId: "4242", sentAt: NOW - 1000 });
    if (!verified.ok) return;
    expect(verified.signatureHash).toMatch(/^[0-9a-f]{64}$/);

    const tampered = new Uint8Array(good.rawBody);
    tampered[10] = (tampered[10] ?? 0) ^ 1;
    expect(verifyJiraWebhook({ ...good, rawBody: tampered })).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyJiraWebhook({ ...good, secret: `${SECRET}x` })).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyJiraWebhook({ ...good, secret: "" })).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyJiraWebhook({ ...good, headers: { ...good.headers, "x-hub-signature": "sha256=" } })).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyJiraWebhook({ ...good, headers: { ...good.headers, "x-hub-signature": "not-a-signature" } })).toEqual({ ok: false, reason: "bad-signature" });
    // Jira "might start using another method": one ostra doesn't know is refused, never trusted.
    expect(verifyJiraWebhook(delivery(issueEvent("jira:issue_updated"), { method: "sha1" }))).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyJiraWebhook({ ...good, headers: { "x-atlassian-webhook-identifier": "4242" } })).toEqual({ ok: false, reason: "missing-signature" });
  });

  it("F-008/c3: refuses an old delivery, and one stamped too far ahead, as stale", () => {
    const old = delivery(issueEvent("jira:issue_updated", NOW - JIRA_WEBHOOK_MAX_AGE_MS - 1));
    expect(verifyJiraWebhook(old)).toEqual({ ok: false, reason: "stale" });
    // A retry inside Jira's window still counts: its secondary flow takes up to 15 min.
    expect(verifyJiraWebhook(delivery(issueEvent("jira:issue_updated", NOW - 15 * 60 * 1000))).ok).toBe(true);
    expect(verifyJiraWebhook(delivery(issueEvent("jira:issue_updated", NOW + JIRA_WEBHOOK_MAX_AGE_MS + 1)))).toEqual({ ok: false, reason: "stale" });
    // The window is the adapter's setting.
    expect(verifyJiraWebhook(delivery(issueEvent("jira:issue_updated", NOW - 61_000)), 60_000)).toEqual({ ok: false, reason: "stale" });
  });

  it("F-008/c3: gives a replay the same claim key, whatever identifier it carries, so core's inbox takes it once", () => {
    const body = issueEvent("jira:issue_updated");
    const first = verifyJiraWebhook(delivery(body, { identifier: "4242" }));
    const again = verifyJiraWebhook(delivery(body, { identifier: "4242" }));
    const renamed = verifyJiraWebhook(delivery(body, { identifier: "9999" }));
    if (!first.ok || !again.ok || !renamed.ok) throw new Error("a replay was refused before its claim");
    // The same delivery again: the same delivery ID and the same signature hash.
    expect(again).toMatchObject({ deliveryId: first.deliveryId, signatureHash: first.signatureHash });
    // The identifier isn't signed: a replay under a new one still carries the first's signature.
    expect(renamed.signatureHash).toBe(first.signatureHash);
    // A replay past the window is stale, so the inbox never needs to remember it longer.
    expect(verifyJiraWebhook({ ...delivery(body), now: NOW + JIRA_WEBHOOK_MAX_AGE_MS })).toEqual({ ok: false, reason: "stale" });
  });

  it("F-008/c3: refuses a delivery that isn't JSON, or has no identifier or no timestamp, as malformed", () => {
    const rawBody = new TextEncoder().encode("not json");
    const signed = { "x-hub-signature": `sha256=${hmacSha256Hex(SECRET, rawBody)}`, "x-atlassian-webhook-identifier": "1" };
    expect(verifyJiraWebhook({ rawBody, headers: signed, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: "malformed" });
    const noId = delivery(issueEvent("jira:issue_updated"));
    expect(verifyJiraWebhook({ ...noId, headers: { "x-hub-signature": noId.headers["x-hub-signature"] } })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyJiraWebhook(delivery({ webhookEvent: "jira:issue_updated" }))).toEqual({ ok: false, reason: "malformed" });
  });

  it("F-008/c3: reads each of the six events into a hint about the issue, never its text", () => {
    const hints = JIRA_WEBHOOK_EVENTS.map((event) => {
      const read = jiraWebhookHint({ body: event.startsWith("comment_") ? { ...issueEvent(event), user: undefined, comment: { id: "1", author: { accountId: "557058:person" } } } : issueEvent(event), ownUserId: "app:ostra-bot" });
      if (!read.ok) throw new Error(read.error.message);
      return read.value;
    });
    expect(hints.map((hint) => [hint.event, hint.subject, hint.action])).toEqual([
      ["jira:issue_created", "ticket", "create"],
      ["jira:issue_updated", "ticket", "update"],
      ["jira:issue_deleted", "ticket", "remove"],
      ["comment_created", "comment", "create"],
      ["comment_updated", "comment", "update"],
      ["comment_deleted", "comment", "remove"],
    ]);
    for (const hint of hints) {
      expect(hint).toMatchObject({ ticketExternalId: "10042", ticketKey: "PROJ-7", boardExternalId: "10000", byOwnUser: false });
      expect(JSON.stringify(hint)).not.toContain("whoami");
    }
  });

  it("F-008/c3: marks ostra's own change, by the issue event's user or a comment's author, and tolerates fields it doesn't know", () => {
    expect(jiraWebhookHint({ body: { ...issueEvent("jira:issue_updated", NOW, "app:ostra-bot"), somethingNew: { nested: true } }, ownUserId: "app:ostra-bot" })).toMatchObject({ ok: true, value: { byOwnUser: true } });
    const comment = { timestamp: NOW, webhookEvent: "comment_created", issue: { id: 10042, key: "PROJ-7" }, comment: { id: "5", author: { accountId: "app:ostra-bot" }, updateAuthor: { accountId: "app:ostra-bot" } } };
    expect(jiraWebhookHint({ body: comment, ownUserId: "app:ostra-bot" })).toMatchObject({ ok: true, value: { byOwnUser: true, ticketExternalId: "10042", boardExternalId: null } });
    expect(jiraWebhookHint({ body: comment, ownUserId: null })).toMatchObject({ ok: true, value: { byOwnUser: false } });
    expect(jiraWebhookHint({ body: { nope: true }, ownUserId: null })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it("suggests the JQL that narrows the webhook to the boards' projects", () => {
    expect(webhookJql(["PROJ", "SHOP", "OPS"])).toBe("project in (PROJ, SHOP, OPS)");
    expect(webhookJql(["PROJ", "bad) OR (1=1"])).toBe("project in (PROJ)");
    expect(webhookJql([])).toBeNull();
  });
});
