import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import type { Clock } from "@ostra/domain";
import { queueSettings } from "@ostra/jobs";
import type { JobHandler } from "@ostra/jobs";
import { connectionIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, WebhookDeliveryId } from "@ostra/protocol";

import { killPoint } from "../kill-points.ts";

// `webhook.process` (ticket 13): acts on a delivery the inbox saved, from the queue, never before
// the 200. It dispatches by the connection's kind (ticket 14's tracker ingest, ticket 16's PR
// states), then marks the delivery `processed`, `ignored` or `failed` with a reason in words. A
// delivery marked once is never acted on again: a replayed job, or a second worker, finds it
// marked and does nothing. The handlers themselves are idempotent too (an upsert by the stable
// ID; a state the code host reports), so a crash between the act and the mark repeats nothing.
//
// The payload never reaches a log line: logs carry the connection, the delivery and the outcome.

/** What a handler was given: the delivery, verified and stored, and its connection. */
export type WebhookDeliveryContext = {
  readonly organizationId: OrganizationId;
  readonly connectionId: ConnectionId;
  readonly deliveryId: WebhookDeliveryId;
  /** The vendor's event, such as `Issue.update` or `pull_request`. */
  readonly event: string;
  /** The verified body. Untrusted: read loosely by the adapter, never logged. */
  readonly payload: unknown;
  readonly receivedAt: number;
  readonly logger: Logger;
};

export type WebhookOutcome =
  | { readonly outcome: "processed"; /** The ticket it was about, once read: the connection's "last event" line. */ readonly ticketKey?: string | null }
  /** Recorded and not acted on: the connection's own echo, an event ostra doesn't read. */
  | { readonly outcome: "ignored"; readonly reason: string; readonly ticketKey?: string | null }
  /** It can't be acted on, and trying again won't help: words and IDs, never content. */
  | { readonly outcome: "failed"; readonly reason: string };

export type WebhookHandler = (context: WebhookDeliveryContext) => Promise<WebhookOutcome>;

/** A handler per connection kind. A thrown error is retried; the last retry marks it failed. */
export type WebhookHandlers = { readonly linear: WebhookHandler; readonly github: WebhookHandler };

export type WebhookProcessDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly handlers: WebhookHandlers;
};

const REASON_MAX = 500;

export const webhookProcessHandler =
  (deps: WebhookProcessDeps): JobHandler<"webhook.process"> =>
  async (context) => {
    const { organizationId, connectionId, deliveryId } = context.payload;
    const logger = context.logger.child({ organizationId, connectionId, deliveryId });
    const delivery = await deps.db.webhookDelivery.findFirst({
      where: { organizationId, connectionId, deliveryId },
      select: { id: true, event: true, status: true, payload: true, receivedAt: true, connection: { select: { kind: true, id: true, organizationId: true } } },
    });
    if (delivery === null) {
      logger.warn("webhook.process.missing", {});
      return;
    }
    if (delivery.status !== "received") {
      // Acted on already: never twice.
      logger.info("webhook.process.already", { status: delivery.status });
      return;
    }
    const receivedAt = delivery.receivedAt.getTime();
    // The panel's "last event received", never moved backwards.
    await deps.db.connection.updateMany({
      where: { id: connectionId, organizationId, OR: [{ lastEventAt: null }, { lastEventAt: { lt: delivery.receivedAt } }] },
      data: { lastEventAt: delivery.receivedAt },
    });
    // A webhook arrived: the connection's webhooks aren't silent (ticket 14's flag clears).
    await deps.db.connection.updateMany({ where: { id: connectionId, organizationId, webhooksSilentSince: { not: null } }, data: { webhooksSilentSince: null } });
    const handler = delivery.connection.kind === "linear" ? deps.handlers.linear : deps.handlers.github;
    let outcome: WebhookOutcome;
    try {
      outcome = await handler({
        organizationId: organizationIdSchema.parse(delivery.connection.organizationId),
        connectionId: connectionIdSchema.parse(delivery.connection.id),
        deliveryId,
        event: delivery.event,
        payload: delivery.payload,
        receivedAt,
        logger,
      });
    } catch (error) {
      const last = context.retryCount >= queueSettings["webhook.process"].retryLimit;
      logger.warn("webhook.process.error", { error: error instanceof Error ? error.name : "unknown", retryCount: context.retryCount, last });
      if (!last) {
        throw error;
      }
      outcome = { outcome: "failed", reason: `gave up after ${String(context.retryCount + 1)} attempts (${error instanceof Error ? error.name : "unknown"})` };
    }
    killPoint("webhook.process");
    const status = outcome.outcome;
    const marked = await deps.db.webhookDelivery.updateMany({
      // Only from `received`: a delivery marked meanwhile keeps its first mark.
      where: { id: delivery.id, status: "received" },
      data: {
        status,
        processedAt: new Date(deps.clock.now()),
        error: outcome.outcome === "processed" ? null : outcome.reason.slice(0, REASON_MAX),
        ...(outcome.outcome !== "failed" && outcome.ticketKey !== undefined && outcome.ticketKey !== null ? { ticketKey: outcome.ticketKey.slice(0, 64) } : {}),
      },
    });
    logger.info("webhook.processed", { status, marked: marked.count === 1, event: delivery.event });
  };

/** Handlers that record a delivery and act on nothing: a kind whose handler isn't built. */
export const recordOnlyHandler =
  (reason: string): WebhookHandler =>
  () =>
    Promise.resolve({ outcome: "ignored", reason });
