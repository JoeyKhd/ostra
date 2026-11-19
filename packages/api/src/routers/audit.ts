import { auditActions } from "@ostra/domain";
import { z } from "zod";

import { auditCursorSchema, auditEntryViewSchema, auditFilterSchema, auditPage, auditReach } from "../services/audit-log.ts";
import { memberProcedure, router } from "../trpc/init.ts";

// F-073 (ADR 0054, ticket 25): the audit log's viewer. An organization admin reads the whole log; a
// project admin names their project and reads its entries only; anyone else is refused. Another
// organization's entries are never in the query. The CSV export (`/api/audit/export`) runs the same
// query (`services/audit-log.ts`).

/** How many entries a page holds by default, and at most. */
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

export const auditRouter = router({
  list: memberProcedure
    .input(auditFilterSchema.extend({ cursor: auditCursorSchema.optional(), limit: z.number().int().min(1).max(MAX_PAGE).optional() }))
    .output(z.object({ entries: z.array(auditEntryViewSchema), next: auditCursorSchema.nullable() }))
    .query(async ({ ctx, input }) => {
      const { cursor, limit, ...filter } = input;
      const reach = await auditReach(ctx.deps.db, ctx.scope, filter.projectId);
      const page = await auditPage(
        ctx.deps.db,
        ctx.scope,
        reach.projectId === null ? filter : { ...filter, projectId: reach.projectId },
        cursor ?? null,
        limit ?? DEFAULT_PAGE,
      );
      return { entries: [...page.entries], next: page.next };
    }),

  /** The actions the filter offers, each with the kind of entity it names. */
  actions: memberProcedure.output(z.array(z.object({ action: z.string(), entity: z.string() }))).query(() =>
    Object.entries(auditActions).map(([action, entity]) => ({ action, entity })),
  ),
});
