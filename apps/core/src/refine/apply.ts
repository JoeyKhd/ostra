import type { Logger, Ticket, TrackerAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import {
  appendServerEvent,
  draftOfRow,
  draftTicketText,
  seedBuiltInProfiles,
  taskPageUrl,
} from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock, JobQueue } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";
import {
  connectionIdSchema,
  externalTicketIdSchema,
  organizationIdSchema,
  projectIdSchema,
  sessionIdSchema,
  taskIdSchema,
  ticketKeySchema,
} from "@ostra/protocol";
import type { OrganizationId, TicketKey } from "@ostra/protocol";

import type { ConnectionTrackers } from "../tracker/connections.ts";

// "Update ticket" (F-099, ADR 0028 amended; milestone 6's ticket 15): `draft.apply`, one job per
// draft version (its key), writes the version to the ticket through the connection's adapter:
//   1. the description, rendered by the domain (a section for each field the tracker can't hold;
//      the criteria in their own field where it has one, `ticketFields.acceptanceCriteria`);
//   2. each image, attached where the tracker takes files (`attachments`), else named in the
//      description;
//   3. each sub-ticket, a sub-issue under the ticket where the tracker has them (`subIssues`), else
//      a ticket of its own linked from it.
// The job runs once per version: its `draft.applied` event is the mark a replay finds. A retry
// after a part of it went out looks each sub-ticket up by its marker before making it, so none is
// made twice; an image already attached has `attachedAt`. A draft's text never reaches a log line.

export type DraftApplyDeps = {
  readonly db: Db;
  readonly trackers: ConnectionTrackers;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  /** The panel's address, for the sub-tickets' marker. */
  readonly publicUrl: string;
  readonly logger: Logger;
  /** A stored blob's bytes (milestone 2's blobs), for an image to attach; `null` when it's gone. */
  readonly readBlob: (organizationId: OrganizationId, blobId: string) => Promise<Uint8Array | null>;
};

/** How far back a retry looks for the sub-tickets it made: an hour is far more than a job's retries. */
const LOOKBACK_MS = 60 * 60_000;

/** The line each sub-ticket carries, so a retry finds the one it made. */
const markerOf = (taskUrl: string, version: number, index: number): string =>
  `Made by ostra from the draft for ${taskUrl} (version ${String(version)}, part ${String(index + 1)})`;

const findMade = async (
  tracker: TrackerAdapter,
  board: { readonly externalId: string },
  marker: string,
  since: number,
): Promise<Ticket | null> => {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const listed = await tracker.listTickets({
      board,
      updatedSince: since,
      order: "updatedAt",
      pageSize: 50,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!listed.ok) throw new Error(`the tracker couldn't list tickets (${listed.error.code})`);
    const found = listed.value.tickets.find(
      (ticket) => ticket.description?.includes(marker) === true,
    );
    if (found !== undefined) return found;
    if (listed.value.nextCursor === null) return null;
    cursor = listed.value.nextCursor;
  }
  return null;
};

const fail = (what: string, code: string): never => {
  throw new Error(`${what} failed (${code})`);
};

export const draftApplyHandler =
  (deps: DraftApplyDeps): JobHandler<"draft.apply"> =>
  async (context) => {
    const organizationId = organizationIdSchema.parse(context.payload.organizationId);
    const logger = context.logger.child({
      organizationId,
      draftId: context.payload.draftId,
      version: context.payload.version,
    });
    const draftRow = await deps.db.refineDraft.findFirst({
      where: { id: context.payload.draftId, organizationId, version: context.payload.version },
      include: {
        images: { orderBy: { createdAt: "asc" } },
        task: { select: { id: true, projectId: true, ticketId: true, boardId: true } },
      },
    });
    if (draftRow?.appliedAt === null || draftRow === null) {
      // Nothing goes to the tracker that a member didn't send.
      logger.info("draft.apply-skipped", {
        reason: draftRow === null ? "no-draft" : "not-applied",
      });
      return;
    }
    const taskId = taskIdSchema.parse(draftRow.task.id);
    const applied = await deps.db.event.findFirst({
      where: { taskId, kind: "draft.applied", payload: { path: ["draftId"], equals: draftRow.id } },
      select: { seq: true },
    });
    if (applied !== null) {
      logger.info("draft.apply-skipped", { reason: "already-applied" });
      return;
    }
    const draft = draftOfRow(draftRow);
    const ticketRow =
      draftRow.task.ticketId === null
        ? null
        : await deps.db.ticket.findFirst({ where: { id: draftRow.task.ticketId, organizationId } });
    const board =
      draftRow.task.boardId === null
        ? null
        : await deps.db.board.findFirst({ where: { id: draftRow.task.boardId, organizationId } });
    if (draft === null || ticketRow === null || board === null) {
      logger.warn("draft.apply-skipped", { reason: draft === null ? "unreadable" : "no-ticket" });
      return;
    }
    const lookup = await deps.trackers.forConnection(
      organizationId,
      connectionIdSchema.parse(board.connectionId),
    );
    if (!lookup.ok) {
      throw new Error(`the tracker isn't usable: ${lookup.reason}`);
    }
    const tracker = lookup.value.tracker;
    const caps = tracker.capabilities;
    const boardRef = { externalId: board.externalId };
    const ref = { externalId: externalTicketIdSchema.parse(ticketRow.externalId) };
    const taskUrl = taskPageUrl(deps.publicUrl, taskId);

    // 2 first: what can't be attached is named in the description.
    const unattached: string[] = [];
    for (const image of draftRow.images) {
      if (image.attachedAt !== null) continue;
      if (!caps.attachments) {
        unattached.push(image.name);
        continue;
      }
      const bytes = await deps.readBlob(organizationId, image.blobId);
      if (bytes === null) {
        unattached.push(image.name);
        continue;
      }
      const attached = await tracker.attachFile(boardRef, ref, {
        name: image.name,
        contentType: image.contentType,
        bytes,
      });
      if (!attached.ok) fail("attaching an image", attached.error.code);
      await deps.db.refineDraftImage.update({
        where: { id: image.id },
        data: { attachedAt: new Date(deps.clock.now()) },
      });
    }

    // 1. The description, with the criteria in their own field where the tracker has one: the
    // domain's `draftTicketText`, the same text the panel's preview shows (ticket 27).
    const text = draftTicketText(draft, {
      acceptanceCriteriaField: caps.ticketFields.acceptanceCriteria,
      unattachedImages: unattached,
      taskUrl,
    });
    const updated = await tracker.updateTicket(boardRef, ref, {
      description: text.description,
      ...(text.acceptanceCriteria === null ? {} : { acceptanceCriteria: text.acceptanceCriteria }),
    });
    if (!updated.ok) fail("writing the description", updated.error.code);

    // 3. The sub-tickets, once each.
    const subTicketKeys: TicketKey[] = [];
    const since = (draftRow.appliedAt.getTime() || deps.clock.now()) - LOOKBACK_MS;
    for (const [index, sub] of draft.subTickets.entries()) {
      const marker = markerOf(taskUrl, draftRow.version, index);
      const found =
        context.retryCount > 0 ? await findMade(tracker, boardRef, marker, since) : null;
      const made =
        found ??
        (await (async () => {
          const created = await tracker.createTicket(boardRef, {
            title: sub.title,
            description: `${sub.description}\n\n${marker}`,
            ...(caps.subIssues ? { parent: ref } : {}),
          });
          if (!created.ok) return fail("creating a sub-ticket", created.error.code);
          if (!caps.subIssues) {
            // No sub-issues: the parent links to it instead.
            const linked = await tracker.linkTask(boardRef, ref, {
              url: created.value.url,
              title: created.value.title.slice(0, 256),
              subtitle: created.value.key,
            });
            if (!linked.ok) fail("linking a sub-ticket", linked.error.code);
          }
          return created.value;
        })());
      subTicketKeys.push(ticketKeySchema.parse(made.key));
    }

    await deps.db.$transaction(async (tx) => {
      const session = await tx.session.findFirst({
        where: { taskId },
        orderBy: { startedAt: "desc" },
        select: { id: true },
      });
      const projectId = projectIdSchema.parse(draftRow.task.projectId);
      if (session !== null) {
        await appendServerEvent(tx, {
          organizationId,
          projectId,
          taskId,
          sessionId: sessionIdSchema.parse(session.id),
          at: deps.clock.now(),
          event: {
            kind: "draft.applied",
            draftId: context.payload.draftId,
            ticketKey: ticketKeySchema.parse(ticketRow.key),
            subTickets: subTicketKeys,
          },
        });
      }
      await deps.notices.emitInTx(tx, {
        organizationId,
        projectId,
        entity: "task",
        entityId: taskId,
      });
    });
    logger.info("draft.applied", {
      subTickets: subTicketKeys.length,
      attached: draftRow.images.length - unattached.length,
    });
  };

// ---------- the built-in profiles ----------

export type SeedProfilesDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly audit: AuditLog;
  readonly clock: Clock;
};

/** `profiles.seed-built-in`: the organization's Refine and Review profiles. */
export const seedProfilesHandler =
  (deps: SeedProfilesDeps): JobHandler<"profiles.seed-built-in"> =>
  async (context) => {
    const organizationId = organizationIdSchema.parse(context.payload.organizationId);
    const seeded = await deps.db.$transaction((tx) =>
      seedBuiltInProfiles(
        { tx, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock },
        { organizationId },
      ),
    );
    if (seeded.created > 0) {
      context.logger.info("profiles.seeded", { organizationId, created: seeded.created });
    }
  };

/** Once at start: every organization without its Refine profile gets the job (one per organization, by its key). */
export const enqueueBuiltInProfileSeeds = async (deps: {
  readonly db: Db;
  readonly jobs: JobQueue;
}): Promise<number> => {
  const missing = await deps.db.organization.findMany({
    where: { agentProfiles: { none: { builtInKind: "refine" } } },
    select: { id: true },
    take: 1000,
  });
  for (const { id } of missing) {
    await deps.db.$transaction((tx) =>
      deps.jobs.enqueueInTx(tx, "profiles.seed-built-in", {
        organizationId: organizationIdSchema.parse(id),
      }),
    );
  }
  return missing.length;
};
