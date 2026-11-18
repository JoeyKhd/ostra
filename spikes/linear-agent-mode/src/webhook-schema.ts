import { z } from "zod";
import { AgentSessionId, AppUserId, IssueId, OrganizationId, TicketKey } from "./ids.ts";

// AgentSessionEvent webhooks. Linear owns this format, so the schemas tolerate unknown fields
// (AGENTS.md). The field list follows @linear/sdk's AgentSessionEventWebhookPayload and Linear's
// agent docs (https://linear.app/developers/agent-interaction), and asks only for what the fast lane uses.

const nonEmpty = z.string().min(1);

const issueSchema = z.object({
  id: nonEmpty,
  identifier: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  description: z.string().nullish(),
});

const agentSessionSchema = z.object({
  id: nonEmpty,
  appUserId: z.string().optional(),
  organizationId: z.string().optional(),
  issueId: z.string().nullish(),
  issue: issueSchema.nullish(),
  commentId: z.string().nullish(),
  creatorId: z.string().nullish(),
  status: z.string().optional(),
  url: z.string().nullish(),
});

const envelope = {
  type: z.literal("AgentSessionEvent"),
  organizationId: nonEmpty,
  appUserId: nonEmpty,
  oauthClientId: z.string().optional(),
  webhookId: z.string().optional(),
  webhookTimestamp: z.number(),
  agentSession: agentSessionSchema,
};

export const createdEventSchema = z.object({
  ...envelope,
  action: z.literal("created"),
  promptContext: z.string().nullish(),
  previousComments: z.array(z.unknown()).nullish(),
  guidance: z.array(z.unknown()).nullish(),
});

export const promptedEventSchema = z.object({
  ...envelope,
  action: z.literal("prompted"),
  agentActivity: z.object({
    id: nonEmpty,
    agentSessionId: z.string().optional(),
    // The SDK types `content` as an open JSON object; Linear's docs name the text `body`.
    content: z.object({ type: z.string().optional(), body: z.string().optional() }).nullish(),
    body: z.string().optional(),
    signal: z.string().nullish(),
    signalMetadata: z.unknown().optional(),
    sourceCommentId: z.string().nullish(),
  }),
});

export const agentSessionEventSchema = z.discriminatedUnion("action", [createdEventSchema, promptedEventSchema]);
export type RawAgentSessionEvent = z.infer<typeof agentSessionEventSchema>;

/** Only the envelope: enough to route an event, whatever its type or action. */
export const envelopeSchema = z.object({
  type: z.string(),
  action: z.string().optional(),
  webhookTimestamp: z.number().optional(),
});

/** ostra's own view of an event, with branded IDs. Ticket text never travels past this type's `body`. */
export type SessionEvent =
  | {
      readonly kind: "created";
      readonly organizationId: OrganizationId;
      readonly appUserId: AppUserId;
      readonly sessionId: AgentSessionId;
      readonly issueId: IssueId | null;
      /** The ticket's key, such as OST-12: an ID, safe to print. */
      readonly issueIdentifier: TicketKey | null;
      /** Linear's clock when it sent the webhook (epoch ms). Compared with ours, it includes any clock skew. */
      readonly sentAtMs: number;
    }
  | {
      readonly kind: "prompted";
      readonly organizationId: OrganizationId;
      readonly appUserId: AppUserId;
      readonly sessionId: AgentSessionId;
      readonly issueId: IssueId | null;
      readonly sentAtMs: number;
      readonly stop: boolean;
      /** The follow-up text. Handed to the turn and never logged. */
      readonly body: string;
    };

export const toSessionEvent = (raw: RawAgentSessionEvent): SessionEvent => {
  const rawIssueId = raw.agentSession.issue?.id ?? raw.agentSession.issueId ?? null;
  const common = {
    organizationId: OrganizationId.parse(raw.organizationId),
    appUserId: AppUserId.parse(raw.appUserId),
    sessionId: AgentSessionId.parse(raw.agentSession.id),
    issueId: rawIssueId === null ? null : IssueId.parse(rawIssueId),
  };
  switch (raw.action) {
    case "created": {
      // A key that does not parse is cosmetic: it is dropped, and the webhook is still accepted.
      const key = TicketKey.safeParse(raw.agentSession.issue?.identifier);
      return {
        kind: "created",
        ...common,
        issueIdentifier: key.success ? key.data : null,
        sentAtMs: raw.webhookTimestamp,
      };
    }
    case "prompted":
      return {
        kind: "prompted",
        ...common,
        sentAtMs: raw.webhookTimestamp,
        stop: raw.agentActivity.signal === "stop",
        body: raw.agentActivity.content?.body ?? raw.agentActivity.body ?? "",
      };
    default:
      return raw satisfies never;
  }
};
