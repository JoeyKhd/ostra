import { adapterError, ok, sha256Hex, verifyHmacSha256Hex } from "@ostra/adapter-sdk";
import type { AdapterResult, ParseWebhookInput, TrackerWebhookHint, TrackerWebhookRequest, WebhookVerification } from "@ostra/adapter-sdk";
import { externalTicketIdSchema, ticketKeySchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { ExternalTicketId, TicketKey } from "@ostra/protocol";
import { z } from "zod";

// Ported from spikes/linear-agent-mode/src/webhook-verify.ts and webhook-schema.ts.
//
// Linear's webhooks (linear.app/developers/webhooks): `Linear-Signature` is the hex HMAC-SHA256 of
// the raw body with the webhook's signing secret, and the signed body's `webhookTimestamp` (ms) must
// be within a minute of the receiver's clock. Spike 5 read the SDK's verifier and found exactly
// that; this is the same check with `node:crypto`, in constant time, without the SDK.
//
// Verification is pure, so core answers within Linear's deadline (ADR 0013). The parse is loose: a
// delivery is a hint to fetch the ticket by, never the ticket itself, and an unknown event type is
// `ignored`, never an error.

/** How far a delivery's signed timestamp may be from the receiver's clock (Linear's SDK: one minute). */
export const WEBHOOK_FRESHNESS_MS = 60_000;

const header = (headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined => {
  const value = headers[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
};

const timestampSchema = z.looseObject({ webhookTimestamp: z.number() });

/** Checks the signature over the raw bytes first, then the body's freshness, then reads the delivery ID. */
export const verifyLinearWebhook = (request: TrackerWebhookRequest): WebhookVerification => {
  const signature = header(request.headers, "linear-signature");
  if (signature === undefined) {
    return { ok: false, reason: "missing-signature" };
  }
  if (!verifyHmacSha256Hex(request.secret, request.rawBody, signature)) {
    return { ok: false, reason: "bad-signature" };
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.rawBody));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // The signed timestamp, not the header's: a replayed capture carries its old one.
  const stamped = timestampSchema.safeParse(body);
  if (!stamped.success || Math.abs(request.now - stamped.data.webhookTimestamp) > WEBHOOK_FRESHNESS_MS) {
    return { ok: false, reason: "stale" };
  }
  const deliveryId = webhookDeliveryIdSchema.safeParse(header(request.headers, "linear-delivery"));
  if (!deliveryId.success) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, deliveryId: deliveryId.data, signatureHash: sha256Hex(signature.toLowerCase()), sentAt: stamped.data.webhookTimestamp, body };
};

// ---------- the parse ----------

// Linear owns this format: every schema tolerates unknown fields, and every field is optional but
// the envelope's type.
const refSchema = z.looseObject({ id: z.string().optional(), key: z.string().optional(), identifier: z.string().optional() });
const issueRefSchema = z.looseObject({
  id: z.string().optional(),
  identifier: z.string().optional(),
  teamId: z.string().optional(),
  team: refSchema.nullish(),
});
const dataSchema = z.looseObject({
  id: z.string().optional(),
  identifier: z.string().optional(),
  teamId: z.string().optional(),
  team: refSchema.nullish(),
  issueId: z.string().nullish(),
  issue: issueRefSchema.nullish(),
  userId: z.string().nullish(),
  creatorId: z.string().nullish(),
});
const envelopeSchema = z.looseObject({
  type: z.string().min(1),
  action: z.string().optional(),
  actor: z.looseObject({ id: z.string().optional(), type: z.string().optional() }).nullish(),
  createdAt: z.union([z.string(), z.number()]).nullish(),
  organizationId: z.string().nullish(),
  webhookTimestamp: z.number().optional(),
  data: z.unknown().optional(),
});

export type LinearWebhookSubject = "ticket" | "comment" | "label" | "attachment";

/** What a Linear delivery says, loosely, in ostra's words. */
export type LinearWebhookEvent =
  /** A type ostra doesn't act on (agent mode's, before milestone 6; a project's; any type Linear adds). */
  | { readonly kind: "ignored"; readonly type: string; readonly action: string | null }
  /** The app was revoked in the workspace: the connection needs a new consent. */
  | { readonly kind: "app-revoked"; readonly type: string; readonly workspaceId: string | null; readonly createdAt: number | null }
  | {
      readonly kind: "change";
      readonly type: string;
      readonly subject: LinearWebhookSubject;
      readonly action: "create" | "update" | "remove" | "other";
      readonly ticketExternalId: ExternalTicketId | null;
      readonly ticketKey: TicketKey | null;
      readonly boardExternalId: string | null;
      /** Who made the change, when Linear says: the echo check compares it with the app's own user. */
      readonly actorId: string | null;
      readonly workspaceId: string | null;
      /** In ms since the epoch: Linear's `createdAt`, as an ISO string or a number. */
      readonly createdAt: number | null;
    };

const subjectOf = (type: string): LinearWebhookSubject | null => {
  switch (type) {
    case "Issue":
      return "ticket";
    case "Comment":
      return "comment";
    case "IssueLabel":
      return "label";
    case "Attachment":
      return "attachment";
    default:
      return null;
  }
};

const actionOf = (action: string | undefined): "create" | "update" | "remove" | "other" =>
  action === "create" || action === "update" || action === "remove" ? action : "other";

const timeOf = (value: string | number | null | undefined): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

const idOrNull = (value: string | null | undefined): ExternalTicketId | null => {
  const parsed = externalTicketIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const keyOrNull = (value: string | null | undefined): TicketKey | null => {
  const parsed = ticketKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Reads a verified body. Only a body with no event type at all is an error. */
export const parseLinearWebhook = (body: unknown): AdapterResult<LinearWebhookEvent> => {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    return adapterError("invalid-response", "a Linear delivery had no event type");
  }
  const { type, action } = envelope.data;
  const createdAt = timeOf(envelope.data.createdAt);
  const workspaceId = envelope.data.organizationId ?? null;
  if ((type === "OAuthApp" || type === "OAuthAuthorization") && action === "revoked") {
    return ok({ kind: "app-revoked", type, workspaceId, createdAt });
  }
  const subject = subjectOf(type);
  if (subject === null) {
    return ok({ kind: "ignored", type, action: action ?? null });
  }
  // A data object that doesn't read is still a hint: the ticket is fetched by what can be read.
  const read = dataSchema.safeParse(envelope.data.data);
  const data = read.success ? read.data : {};
  const issue = subject === "ticket" ? { id: data.id, identifier: data.identifier, teamId: data.teamId, team: data.team } : (data.issue ?? undefined);
  const ticketExternalId = subject === "ticket" ? idOrNull(data.id) : idOrNull(data.issueId ?? issue?.id);
  return ok({
    kind: "change",
    type,
    subject,
    action: actionOf(action),
    ticketExternalId,
    ticketKey: keyOrNull(issue?.identifier),
    boardExternalId: issue?.teamId ?? issue?.team?.id ?? null,
    // A comment's author is its `userId` when the envelope names no actor.
    actorId: envelope.data.actor?.id ?? (subject === "comment" ? (data.userId ?? null) : null),
    workspaceId,
    createdAt,
  });
};

const hintSubject = (subject: LinearWebhookSubject): TrackerWebhookHint["subject"] => subject;

/** The tracker interface's hint: an ignored or revoked event is subject `other`, with no ticket. */
export const linearWebhookHint = (input: ParseWebhookInput): AdapterResult<TrackerWebhookHint> => {
  const parsed = parseLinearWebhook(input.body);
  if (!parsed.ok) {
    return parsed;
  }
  const event = parsed.value;
  switch (event.kind) {
    case "ignored":
      return ok({ event: event.type, subject: "other", action: actionOf(event.action ?? undefined), ticketExternalId: null, ticketKey: null, boardExternalId: null, byOwnUser: false });
    case "app-revoked":
      return ok({ event: event.type, subject: "other", action: "remove", ticketExternalId: null, ticketKey: null, boardExternalId: null, byOwnUser: false });
    case "change":
      return ok({
        event: event.type,
        subject: hintSubject(event.subject),
        action: event.action,
        ticketExternalId: event.ticketExternalId,
        ticketKey: event.ticketKey,
        boardExternalId: event.boardExternalId,
        byOwnUser: input.ownUserId !== null && event.actorId === input.ownUserId,
      });
    default:
      return event satisfies never;
  }
};
