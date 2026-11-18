import { createHmac, randomUUID } from "node:crypto";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { IssueId, LinearUserId, TicketKey } from "../ids.ts";

// Webhook payloads as Linear sends them, typed with the SDK's own AgentSessionEventWebhookPayload so the fake
// cannot drift from what the SDK declares. Signing follows Linear's docs: a hex HMAC-SHA256 of the raw body.

/**
 * The SDK declares the top-level `createdAt` as a Date (its parsed model); on the wire it is an ISO string.
 * Everything else is the SDK's own type.
 */
export type WirePayload = Omit<AgentSessionEventWebhookPayload, "createdAt"> & { readonly createdAt: string };

export type FakeIssue = {
  readonly id: IssueId;
  readonly identifier: TicketKey;
  readonly title: string;
  readonly description: string;
  readonly url: string;
};

export type FakePerson = { readonly id: LinearUserId; readonly name: string; readonly email: string };

const TEAM = { id: "team-fake-0001", key: "OST", name: "ostra test" } as const;

const personPayload = (person: FakePerson) => ({
  id: person.id,
  name: person.name,
  email: person.email,
  url: `https://linear.app/fake/profiles/${person.id}`,
});

type Common = {
  readonly organizationId: string;
  readonly appUserId: string;
  readonly oauthClientId: string;
  readonly sessionId: string;
  readonly issue: FakeIssue;
  readonly creator: FakePerson;
  /** Epoch milliseconds, `Date.now()` style: the SDK's verifier compares it with the wall clock. */
  readonly now: number;
};

const sessionPayload = (input: Common) => ({
  id: input.sessionId,
  appUserId: input.appUserId,
  organizationId: input.organizationId,
  issueId: input.issue.id,
  issue: {
    id: input.issue.id,
    identifier: input.issue.identifier,
    title: input.issue.title,
    description: input.issue.description,
    url: input.issue.url,
    teamId: TEAM.id,
    team: TEAM,
  },
  creatorId: input.creator.id,
  creator: personPayload(input.creator),
  status: "pending",
  type: "commentThread",
  url: `${input.issue.url}#agent-session-${input.sessionId}`,
  createdAt: new Date(input.now).toISOString(),
  updatedAt: new Date(input.now).toISOString(),
});

export const buildCreatedPayload = (input: Common): WirePayload => ({
  type: "AgentSessionEvent",
  action: "created",
  organizationId: input.organizationId,
  appUserId: input.appUserId,
  oauthClientId: input.oauthClientId,
  webhookId: randomUUID(),
  webhookTimestamp: input.now,
  createdAt: new Date(input.now).toISOString(),
  agentSession: sessionPayload(input),
  promptContext: `<issue identifier="${input.issue.identifier}"><title>${input.issue.title}</title><description>${input.issue.description}</description></issue>`,
  guidance: [],
});

export const buildPromptedPayload = (
  input: Common & { readonly activityId: string; readonly body: string; readonly stop: boolean },
): WirePayload => ({
  type: "AgentSessionEvent",
  action: "prompted",
  organizationId: input.organizationId,
  appUserId: input.appUserId,
  oauthClientId: input.oauthClientId,
  webhookId: randomUUID(),
  webhookTimestamp: input.now,
  createdAt: new Date(input.now).toISOString(),
  agentSession: sessionPayload(input),
  agentActivity: {
    id: input.activityId,
    agentSessionId: input.sessionId,
    content: { type: "prompt", body: input.body },
    ...(input.stop ? { signal: "stop" } : {}),
    createdAt: new Date(input.now).toISOString(),
    updatedAt: new Date(input.now).toISOString(),
    user: personPayload(input.creator),
    userId: input.creator.id,
  },
});

export const signWebhook = (secret: string, rawBody: string): string =>
  createHmac("sha256", secret).update(rawBody).digest("hex");

export type WebhookRequest = { readonly rawBody: string; readonly headers: Readonly<Record<string, string>> };

export const makeWebhookRequest = (options: {
  readonly secret: string;
  readonly payload: WirePayload | Readonly<Record<string, unknown>>;
  readonly deliveryId?: string;
  readonly event?: string;
}): WebhookRequest => {
  const rawBody = JSON.stringify(options.payload);
  return {
    rawBody,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "user-agent": "Linear-Webhook",
      "linear-delivery": options.deliveryId ?? randomUUID(),
      "linear-event": options.event ?? "AgentSessionEvent",
      "linear-signature": signWebhook(options.secret, rawBody),
    },
  };
};
