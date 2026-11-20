import { createHash } from "node:crypto";

import { adapterError, ok } from "@ostra/adapter-sdk";
import type { AdapterResult, AgentActivity, AgentSessionEvent, TrackerStatus } from "@ostra/adapter-sdk";
import { externalTicketIdSchema } from "@ostra/protocol";
import { z } from "zod";

// Milestone 6 (F-012, ADR 0013): Linear's agent sessions, ported from
// spikes/linear-agent-mode/src/webhook-schema.ts. Linear owns the event's format, so every schema
// here tolerates unknown fields, and every field but the ones ostra acts on is optional. The field
// list follows @linear/sdk's `AgentSessionEventWebhookPayload` and Linear's agent docs
// (linear.app/developers/agent-interaction, agent-signals), as spike 5 read them.
//
// A prompt, a comment's body and an activity's body are untrusted text: returned as data, and
// never in a log line or an error message.

const nonEmpty = z.string().min(1);

const personSchema = z.looseObject({ id: nonEmpty, name: z.string().optional(), email: z.string().nullish() });

const sessionSchema = z.looseObject({
  id: nonEmpty,
  issueId: z.string().nullish(),
  issue: z
    .looseObject({
      id: z.string().optional(),
      teamId: z.string().nullish(),
      team: z.looseObject({ id: z.string().optional() }).nullish(),
    })
    .nullish(),
  commentId: z.string().nullish(),
  comment: z.looseObject({ id: z.string().optional(), body: z.string().nullish() }).nullish(),
  creatorId: z.string().nullish(),
  creator: personSchema.nullish(),
});

const envelope = {
  type: z.literal("AgentSessionEvent"),
  agentSession: sessionSchema,
};

const createdSchema = z.looseObject({ ...envelope, action: z.literal("created") });

const promptedSchema = z.looseObject({
  ...envelope,
  action: z.literal("prompted"),
  agentActivity: z.looseObject({
    // The SDK types `content` as an open JSON object; Linear's docs name the text `body`.
    content: z.looseObject({ type: z.string().optional(), body: z.string().nullish() }).nullish(),
    body: z.string().nullish(),
    signal: z.string().nullish(),
    sourceCommentId: z.string().nullish(),
    userId: z.string().nullish(),
    user: personSchema.nullish(),
  }),
});

const eventSchema = z.discriminatedUnion("action", [createdSchema, promptedSchema]);

const unreadable = (why: string): AdapterResult<never> => adapterError("invalid-response", `Linear's agent-session event could not be read: ${why}`);

/** Reads a verified delivery's body as a session event. Pure: no call is made. */
export const parseLinearAgentSessionEvent = (body: unknown): AdapterResult<AgentSessionEvent> => {
  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) {
    return unreadable("not a created or prompted AgentSessionEvent");
  }
  const event = parsed.data;
  const session = event.agentSession;
  const ticketId = externalTicketIdSchema.safeParse(session.issue?.id ?? session.issueId);
  if (!ticketId.success) {
    return unreadable("the session names no issue");
  }
  const teamId = session.issue?.teamId ?? session.issue?.team?.id;
  if (teamId === undefined || teamId === "") {
    return unreadable("the session names no team");
  }
  const sessionCreator = session.creator ?? (session.creatorId === null || session.creatorId === undefined ? null : { id: session.creatorId });
  const common = {
    sessionId: session.id,
    ticketExternalId: ticketId.data,
    teamExternalId: teamId,
    commentId: session.commentId ?? session.comment?.id ?? null,
  };
  const personOf = (person: z.infer<typeof personSchema> | { readonly id: string } | null): AgentSessionEvent["creator"] | null =>
    person === null
      ? null
      : {
          userId: person.id,
          name: "name" in person && person.name !== undefined ? person.name : "",
          email: "email" in person && person.email !== undefined && person.email !== null && person.email !== "" ? person.email : null,
        };
  switch (event.action) {
    case "created": {
      const creator = personOf(sessionCreator);
      if (creator === null) {
        return unreadable("the session names no creator");
      }
      // A mention's text is its comment's; a plain delegation has none.
      const mention = session.comment?.body;
      return ok({ ...common, action: "created", creator, prompt: mention === undefined || mention === null || mention === "" ? null : mention, signal: null });
    }
    case "prompted": {
      const activity = event.agentActivity;
      // The follow-up's writer; an older payload without one is the session's creator.
      const writer =
        activity.user ?? (activity.userId === null || activity.userId === undefined ? null : { id: activity.userId }) ?? sessionCreator;
      const creator = personOf(writer);
      if (creator === null) {
        return unreadable("the follow-up names no person");
      }
      const text = activity.content?.body ?? activity.body ?? null;
      return ok({
        ...common,
        action: "prompted",
        creator,
        prompt: text === null || text === "" ? null : text,
        // A stop is `prompted` with `signal: "stop"`: an event ostra reads, never a call it makes.
        signal: activity.signal === "stop" ? "stop" : null,
      });
    }
    default:
      return event satisfies never;
  }
};

/**
 * The client-made activity ID for an idempotency key: a UUID v4 shape from a digest of the session
 * and the key, so a retry, a replay or another worker posts with the same ID and Linear keeps one
 * (milestone 2's marker rule, F-046).
 */
export const activityIdFor = (sessionId: string, idempotencyKey: string): string => {
  const hex = createHash("sha256").update(`ostra:agent-activity:${sessionId}:${idempotencyKey}`).digest("hex");
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Linear's activity content per kind: an action's text is its `action`, with no parameter. */
export const activityContent = (activity: AgentActivity): Readonly<Record<string, string>> => {
  switch (activity.kind) {
    case "thought":
    case "elicitation":
    case "response":
    case "error":
      return { type: activity.kind, body: activity.body };
    case "action":
      return { type: "action", action: activity.body, parameter: "" };
    default:
      return activity.kind satisfies never;
  }
};

/** Only a thought or an action can be ephemeral (Linear's rule, and the base type's). */
export const canBeEphemeral = (activity: AgentActivity): boolean => activity.kind === "thought" || activity.kind === "action";

/**
 * The board's "ready" status for its mapping draft (F-099, "Mark ready"): the first `unstarted`
 * status by the board's position, as Linear's "Todo". `null` on a board without one.
 */
export const defaultReadyStatus = (statuses: readonly TrackerStatus[]): TrackerStatus | null =>
  [...statuses].filter((status) => status.vendorType === "unstarted").sort((a, b) => a.position - b.position)[0] ?? null;
