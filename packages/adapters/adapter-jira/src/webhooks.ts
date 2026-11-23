import { adapterError, ok, sha256Hex, verifyHmacSha256Hex } from "@ostra/adapter-sdk";
import type { AdapterResult, ParseWebhookInput, TrackerWebhookHint, TrackerWebhookRequest, WebhookVerification } from "@ostra/adapter-sdk";
import { externalTicketIdSchema, ticketKeySchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import { z } from "zod";

// Jira's admin webhook (ADR 0047), as Atlassian documents it
// (https://developer.atlassian.com/cloud/jira/platform/webhooks/, "Securing admin webhooks", read
// 2026-11-23):
// - With a secret set, Jira signs each delivery in `X-Hub-Signature`, "formatted as
//   method=signature": `sha256=<hex>`, an HMAC-SHA256 of the payload with the secret. The page warns
//   that Jira "might start using another method", so a method ostra doesn't know is refused.
// - `X-Atlassian-Webhook-Identifier` names the delivery, the same across Jira's retries.
// - No header carries a time, and the signature covers only the body: the body's `timestamp` (ms)
//   is when Jira made the event. Jira sends a "primary" delivery within about 30 s and a
//   "secondary" one (bulk changes) within 15 min, and retries up to five times 5 to 15 min apart.
//   So a delivery is fresh for 20 min by default: past it, it's refused as stale and the board's
//   reconcile poll picks the change up. A replay inside the window repeats the same signature,
//   which core's inbox claims once per connection (`signatureHash`), whatever identifier it carries.
//
// Pure: no call is made, so core answers within Jira's deadline. The body is untrusted, and only
// IDs are read from it.

/** How long after Jira made it a delivery is taken: Jira's secondary flow, with room to spare. */
export const JIRA_WEBHOOK_MAX_AGE_MS = 20 * 60 * 1000;

/** The events the admin webhook sends (jira-connect.md, step 3). */
export const JIRA_WEBHOOK_EVENTS = [
  "jira:issue_created",
  "jira:issue_updated",
  "jira:issue_deleted",
  "comment_created",
  "comment_updated",
  "comment_deleted",
] as const;

export type JiraWebhookEvent = (typeof JIRA_WEBHOOK_EVENTS)[number];

const signedBodySchema = z.looseObject({ timestamp: z.number().int().nonnegative(), webhookEvent: z.string().min(1) });

const accountRef = z.looseObject({ accountId: z.string().min(1) }).nullish();

const payloadSchema = z.looseObject({
  webhookEvent: z.string().min(1),
  user: accountRef,
  issue: z
    .looseObject({
      id: z.union([z.string(), z.number()]).transform(String),
      key: z.string().optional(),
      fields: z.looseObject({ project: z.looseObject({ id: z.union([z.string(), z.number()]).transform(String) }).nullish() }).nullish(),
    })
    .nullish(),
  comment: z.looseObject({ author: accountRef, updateAuthor: accountRef }).nullish(),
});

/** Checks a delivery's signature and freshness, and reads its delivery ID. */
export const verifyJiraWebhook = (request: TrackerWebhookRequest, maxAgeMs: number = JIRA_WEBHOOK_MAX_AGE_MS): WebhookVerification => {
  const header = request.headers["x-hub-signature"]?.trim();
  if (header === undefined || header === "") {
    return { ok: false, reason: "missing-signature" };
  }
  const separator = header.indexOf("=");
  const method = separator === -1 ? "" : header.slice(0, separator).toLowerCase();
  const signature = separator === -1 ? "" : header.slice(separator + 1);
  if (method !== "sha256" || request.secret === "" || !verifyHmacSha256Hex(request.secret, request.rawBody, signature)) {
    return { ok: false, reason: "bad-signature" };
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.rawBody));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const signed = signedBodySchema.safeParse(body);
  const deliveryId = webhookDeliveryIdSchema.safeParse(request.headers["x-atlassian-webhook-identifier"]?.trim());
  if (!signed.success || !deliveryId.success) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.abs(request.now - signed.data.timestamp) > maxAgeMs) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, deliveryId: deliveryId.data, signatureHash: sha256Hex(signature.toLowerCase()), sentAt: signed.data.timestamp, body };
};

const subjectOf = (event: string): TrackerWebhookHint["subject"] => {
  if (event.startsWith("comment_")) return "comment";
  if (event.startsWith("jira:issue_")) return "ticket";
  if (event.startsWith("attachment_")) return "attachment";
  if (event.startsWith("issuelink_") || event.startsWith("issue_property_")) return "ticket";
  return "other";
};

const actionOf = (event: string): TrackerWebhookHint["action"] => {
  if (event.endsWith("_created")) return "create";
  if (event.endsWith("_updated") || event.endsWith("_set")) return "update";
  if (event.endsWith("_deleted")) return "remove";
  return "other";
};

/** Reads a verified body into a hint: the issue it's about, never the issue itself. */
export const jiraWebhookHint = (input: ParseWebhookInput): AdapterResult<TrackerWebhookHint> => {
  const parsed = payloadSchema.safeParse(input.body);
  if (!parsed.success) {
    return adapterError("invalid-response", "reading Jira's delivery failed: it isn't a Jira event");
  }
  const { webhookEvent, issue, user, comment } = parsed.data;
  const externalId = issue === null || issue === undefined ? null : externalTicketIdSchema.safeParse(issue.id);
  const key = issue?.key === undefined ? null : ticketKeySchema.safeParse(issue.key);
  // An issue event names who made it in `user`; a comment event may name only the comment's author.
  const actor = user?.accountId ?? comment?.updateAuthor?.accountId ?? comment?.author?.accountId ?? null;
  return ok({
    event: webhookEvent,
    subject: subjectOf(webhookEvent),
    action: actionOf(webhookEvent),
    ticketExternalId: externalId?.success === true ? externalId.data : null,
    ticketKey: key?.success === true ? key.data : null,
    boardExternalId: issue?.fields?.project?.id ?? null,
    byOwnUser: input.ownUserId !== null && actor === input.ownUserId,
  });
};

/** The JQL that narrows the admin webhook to the boards' projects (step 3's optional filter). */
export const webhookJql = (projectKeys: readonly string[]): string | null => {
  const keys = projectKeys.filter((key) => /^[A-Z][A-Z0-9_]{0,254}$/.test(key));
  return keys.length === 0 ? null : `project in (${keys.join(", ")})`;
};
