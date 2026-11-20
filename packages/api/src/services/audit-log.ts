import { auditActions, canReadAudit, requireProjectAccess } from "@ostra/domain";
import type { AuditAction, MemberScope } from "@ostra/domain";
import type { DbOrTx, Prisma } from "@ostra/db";
import { projectIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../trpc/context.ts";

// F-073 (ADR 0054, ticket 25): reading the audit log. An organization admin reads all of it; a project
// admin reads their project's entries only, and must name the project. The list and the CSV export run
// the same query (`auditPage`), so the export's rows are the list's for the same filters. The filters
// are indexed columns; pages are keyset by `(createdAt, id)`, newest first.

const actionNames = Object.keys(auditActions);
const isAuditAction = (value: string): value is AuditAction => actionNames.includes(value);

/** One action (`task.created`), or a prefix ending in a dot (`budget.`) for every action under it. */
export const auditActionFilterSchema = z
  .string()
  .min(2)
  .max(80)
  .refine((value) => (value.endsWith(".") ? actionNames.some((name) => name.startsWith(value)) : isAuditAction(value)), "an audit action, or a prefix such as budget.");

export const auditFilterSchema = z.strictObject({
  projectId: projectIdSchema.optional(),
  /** The member, runner or job that acted. */
  actorId: z.string().min(1).max(64).optional(),
  /** Every runner's entries, or the system's (audit-log.md: the Actor filter's `Runners` and `System`). */
  actorKind: z.enum(["member", "runner", "system"]).optional(),
  action: auditActionFilterSchema.optional(),
  entity: z.string().min(1).max(40).optional(),
  entityId: z.string().min(1).max(128).optional(),
  /** Epoch ms, inclusive. */
  from: z.number().int().nonnegative().optional(),
  /** Epoch ms, exclusive. */
  to: z.number().int().nonnegative().optional(),
});
export type AuditFilter = z.infer<typeof auditFilterSchema>;

/** Where a page starts: the last entry of the page before. */
export const auditCursorSchema = z.strictObject({ createdAt: z.number().int(), id: z.string().min(1).max(64) });
export type AuditCursor = z.infer<typeof auditCursorSchema>;

export const auditEntryViewSchema = z.object({
  id: z.string(),
  /** Epoch ms. */
  at: z.number().int(),
  actor: z.object({
    kind: z.enum(["member", "runner", "system"]),
    id: z.string().nullable(),
    /** The name as it was when it acted. */
    name: z.string().nullable(),
    /** A member removed since: the panel shows "(removed)" after the name. */
    removed: z.boolean(),
  }),
  action: z.string(),
  entity: z.string().nullable(),
  entityId: z.string().nullable(),
  /**
   * What the entity is called (audit-log.md, the Entity column): a task's ticket key or title, a
   * member's or a record's name, read from the live record; a label the entry recorded in its data
   * when the record is gone; else its ID. `null` for an entry about no entity.
   */
  entityLabel: z.string().nullable(),
  /** The task an entry is about, so the panel can open its event log. */
  taskId: z.string().nullable(),
  project: z.object({ id: projectIdSchema, name: z.string() }).nullable(),
  /** IDs and settings only, never content (ticket 10). */
  data: z.unknown(),
});
export type AuditEntryView = z.infer<typeof auditEntryViewSchema>;

/** What a reader may read: the whole log, or one project's entries. Refuses as tRPC does. */
export const auditReach = async (db: DbOrTx, scope: MemberScope, projectId: ProjectId | undefined): Promise<{ readonly projectId: ProjectId | null }> => {
  if (projectId === undefined) {
    if (!canReadAudit(scope, scope.organizationId, null)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Only an organization admin reads the whole audit log: choose a project you administer" });
    }
    return { projectId: null };
  }
  const project = await db.project.findFirst({ where: { id: projectId, organizationId: scope.organizationId }, select: { access: true } });
  const info = { id: projectId, organizationId: scope.organizationId, access: project?.access ?? "restricted" };
  if (project === null || !requireProjectAccess(scope, info, "read").ok) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such project" });
  }
  if (!canReadAudit(scope, scope.organizationId, info)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only a project admin reads its audit log" });
  }
  return { projectId };
};

const whereOf = (organizationId: string, filter: AuditFilter, cursor: AuditCursor | null): Prisma.AuditEntryWhereInput => {
  const and: Prisma.AuditEntryWhereInput[] = [{ organizationId }];
  if (filter.projectId !== undefined) and.push({ projectId: filter.projectId });
  if (filter.actorId !== undefined) and.push({ actorId: filter.actorId });
  if (filter.actorKind !== undefined) and.push({ actorKind: filter.actorKind });
  if (filter.action !== undefined) and.push(filter.action.endsWith(".") ? { action: { startsWith: filter.action } } : { action: filter.action });
  if (filter.entity !== undefined) and.push({ entity: filter.entity });
  if (filter.entityId !== undefined) and.push({ entityId: filter.entityId });
  if (filter.from !== undefined) and.push({ createdAt: { gte: new Date(filter.from) } });
  if (filter.to !== undefined) and.push({ createdAt: { lt: new Date(filter.to) } });
  if (cursor !== null) {
    const at = new Date(cursor.createdAt);
    and.push({ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] });
  }
  return { AND: and };
};

const taskIdOf = (entity: string | null, entityId: string | null, data: unknown): string | null => {
  if (entity === "task" && entityId !== null) {
    return entityId;
  }
  const fromData: unknown = typeof data === "object" && data !== null ? Reflect.get(data, "taskId") : undefined;
  return typeof fromData === "string" ? fromData : null;
};

/** A label the writer recorded in an entry's data, for a record since gone. */
const recordedLabelOf = (data: unknown): string | null => {
  if (typeof data !== "object" || data === null) return null;
  for (const key of ["label", "name", "title", "ticketKey"]) {
    const value: unknown = Reflect.get(data, key);
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
};

type LabelRow = { readonly id: string; readonly label: string | null };

/** The live records' labels for one page, keyed `entity:id`; every read stays inside the organization. */
const liveLabels = async (
  db: DbOrTx,
  organizationId: string,
  rows: readonly { readonly entity: string | null; readonly entityId: string | null }[],
): Promise<ReadonlyMap<string, string>> => {
  const named = (list: readonly { readonly id: string; readonly name: string }[]): LabelRow[] => list.map((row) => ({ id: row.id, label: row.name }));
  const inOrg = { organizationId };
  const readers: Readonly<Record<string, (ids: string[]) => Promise<LabelRow[]>>> = {
    task: async (ids) =>
      (await db.task.findMany({ where: { ...inOrg, id: { in: ids } }, select: { id: true, ticketKey: true, title: true } })).map((row) => ({ id: row.id, label: row.ticketKey ?? row.title })),
    member: async (ids) =>
      (await db.member.findMany({ where: { ...inOrg, id: { in: ids } }, select: { id: true, user: { select: { name: true } } } })).map((row) => ({ id: row.id, label: row.user.name })),
    user: async (ids) => named(await db.user.findMany({ where: { id: { in: ids }, members: { some: inOrg } }, select: { id: true, name: true } })),
    organization: async (ids) => named(await db.organization.findMany({ where: { id: { in: ids.filter((id) => id === organizationId) } }, select: { id: true, name: true } })),
    project: async (ids) => named(await db.project.findMany({ where: { ...inOrg, id: { in: ids } }, select: { id: true, name: true } })),
    "runner-pool": async (ids) => named(await db.runnerPool.findMany({ where: { ...inOrg, id: { in: ids } }, select: { id: true, name: true } })),
    runner: async (ids) => named(await db.runner.findMany({ where: { ...inOrg, id: { in: ids } }, select: { id: true, name: true } })),
    "model-provider": async (ids) => named(await db.modelProvider.findMany({ where: { ...inOrg, id: { in: ids } }, select: { id: true, name: true } })),
    "agent-profile": async (ids) => named(await db.agentProfile.findMany({ where: { ...inOrg, id: { in: ids } }, select: { id: true, name: true } })),
    automation: async (ids) => named(await db.automation.findMany({ where: { ...inOrg, id: { in: ids } }, select: { id: true, name: true } })),
    "memory-note": async (ids) =>
      (await db.memoryNote.findMany({ where: { ...inOrg, id: { in: ids } }, select: { id: true, title: true } })).map((row) => ({ id: row.id, label: row.title })),
    "join-token": async (ids) =>
      (await db.joinToken.findMany({ where: { ...inOrg, id: { in: ids } }, select: { id: true, label: true } })).map((row) => ({ id: row.id, label: row.label })),
  };
  const idsByEntity = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.entity === null || row.entityId === null || !Object.hasOwn(readers, row.entity)) continue;
    const ids = idsByEntity.get(row.entity) ?? new Set<string>();
    ids.add(row.entityId);
    idsByEntity.set(row.entity, ids);
  }
  const reads = await Promise.all(
    [...idsByEntity].map(async ([entity, ids]) => {
      const read = readers[entity];
      return { entity, found: read === undefined ? [] : await read([...ids]) };
    }),
  );
  const labels = new Map<string, string>();
  for (const { entity, found } of reads) {
    for (const row of found) {
      if (row.label !== null && row.label.trim() !== "") labels.set(`${entity}:${row.id}`, row.label);
    }
  }
  return labels;
};

/**
 * One page of the log, newest first, inside `scope`'s organization. `filter.projectId` must already be
 * what `auditReach` allows: a project admin's reads always carry their project.
 */
export const auditPage = async (
  db: DbOrTx,
  scope: MemberScope,
  filter: AuditFilter,
  cursor: AuditCursor | null,
  limit: number,
): Promise<{ readonly entries: readonly AuditEntryView[]; readonly next: AuditCursor | null }> => {
  const rows = await db.auditEntry.findMany({
    where: whereOf(scope.organizationId, filter, cursor),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: { id: true, createdAt: true, actorKind: true, actorId: true, actorName: true, action: true, entity: true, entityId: true, projectId: true, data: true },
  });
  const page = rows.slice(0, limit);
  const memberIds = [...new Set(page.flatMap((row) => (row.actorKind === "member" && row.actorId !== null ? [row.actorId] : [])))];
  const projectIds = [...new Set(page.flatMap((row) => (row.projectId === null ? [] : [row.projectId])))];
  const [members, projects, labels] = await Promise.all([
    db.member.findMany({ where: { organizationId: scope.organizationId, id: { in: memberIds } }, select: { id: true, state: true, user: { select: { name: true } } } }),
    db.project.findMany({ where: { organizationId: scope.organizationId, id: { in: projectIds } }, select: { id: true, name: true } }),
    liveLabels(db, scope.organizationId, page),
  ]);
  const memberById = new Map(members.map((row) => [row.id, row] as const));
  const projectById = new Map(projects.map((row) => [row.id, row.name] as const));
  const entries = page.map((row): AuditEntryView => {
    const member = row.actorKind === "member" && row.actorId !== null ? memberById.get(row.actorId) : undefined;
    const projectName = row.projectId === null ? undefined : projectById.get(row.projectId);
    return {
      id: row.id,
      at: row.createdAt.getTime(),
      actor: { kind: row.actorKind, id: row.actorId, name: row.actorName ?? member?.user.name ?? null, removed: member?.state === "removed" },
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      entityLabel: row.entity === null ? null : (labels.get(`${row.entity}:${row.entityId ?? ""}`) ?? recordedLabelOf(row.data) ?? row.entityId),
      taskId: taskIdOf(row.entity, row.entityId, row.data),
      project: row.projectId === null || projectName === undefined ? null : { id: projectIdSchema.parse(row.projectId), name: projectName },
      data: row.data,
    };
  });
  const last = page.at(-1);
  return { entries, next: rows.length > limit && last !== undefined ? { createdAt: last.createdAt.getTime(), id: last.id } : null };
};

// ---------- the CSV export ----------

/** The export's columns (audit-log.md, "Export CSV"). */
export const AUDIT_CSV_COLUMNS = ["time", "actor_kind", "actor_id", "actor_name", "action", "entity", "entity_id", "entity_label", "project_id", "project_name", "data"] as const;

/** One CSV field: always quoted; a leading `=`, `+`, `-`, `@`, tab or return is defused for spreadsheets. */
export const csvField = (value: string): string => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
};

/** An entry as its CSV row: the same fields the list returns. */
export const auditCsvRow = (entry: AuditEntryView): string =>
  [
    new Date(entry.at).toISOString(),
    entry.actor.kind,
    entry.actor.id ?? "",
    entry.actor.name === null ? "" : entry.actor.removed ? `${entry.actor.name} (removed)` : entry.actor.name,
    entry.action,
    entry.entity ?? "",
    entry.entityId ?? "",
    entry.entityLabel ?? "",
    entry.project?.id ?? "",
    entry.project?.name ?? "",
    entry.data === null || entry.data === undefined ? "" : JSON.stringify(entry.data),
  ]
    .map(csvField)
    .join(",");

/** How many entries each page of the export reads. */
const EXPORT_PAGE = 500;

const textResponse = (status: number, text: string): Response =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" } });

/** The filters from the export's query parameters: the list's, by the same names. */
export const auditFilterFromQuery = (params: URLSearchParams): z.ZodSafeParseResult<AuditFilter> => {
  const raw: Record<string, string | number> = {};
  for (const key of ["projectId", "actorId", "actorKind", "action", "entity", "entityId"] as const) {
    const value = params.get(key);
    if (value !== null && value !== "") raw[key] = value;
  }
  for (const key of ["from", "to"] as const) {
    const value = params.get(key);
    if (value !== null && value !== "") raw[key] = Number(value);
  }
  return auditFilterSchema.safeParse(raw);
};

/**
 * The export (`GET /api/audit/export`): the list's query as CSV, streamed page by page with no row
 * limit, behind the list's access check. A header row first, one quoted field per column.
 */
export const serveAuditExport = async (ctx: Context, url: URL, options: { readonly pageSize?: number } = {}): Promise<Response> => {
  if (ctx.user === null || ctx.member === null) {
    return textResponse(401, "Sign in first");
  }
  const filter = auditFilterFromQuery(url.searchParams);
  if (!filter.success) {
    return textResponse(400, "Those filters aren't valid");
  }
  const scope = ctx.member.scope;
  const { db } = ctx.deps;
  try {
    await auditReach(db, scope, filter.data.projectId);
  } catch (error) {
    if (error instanceof TRPCError) {
      return error.code === "NOT_FOUND" ? textResponse(404, "No such project") : textResponse(403, error.message);
    }
    throw error;
  }
  const encoder = new TextEncoder();
  let cursor: AuditCursor | null = null;
  let started = false;
  let done = false;
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(`${AUDIT_CSV_COLUMNS.map(csvField).join(",")}\r\n`));
        return;
      }
      if (done) {
        controller.close();
        return;
      }
      const page = await auditPage(db, scope, filter.data, cursor, options.pageSize ?? EXPORT_PAGE);
      if (page.entries.length > 0) {
        controller.enqueue(encoder.encode(page.entries.map((entry) => `${auditCsvRow(entry)}\r\n`).join("")));
      }
      cursor = page.next;
      if (cursor === null) {
        done = true;
      }
    },
  });
  const day = new Date(ctx.deps.ports.clock.now()).toISOString().slice(0, 10);
  const organization = await db.organization.findUnique({ where: { id: scope.organizationId }, select: { slug: true } });
  const slug = (organization?.slug ?? "organization").replace(/[^a-zA-Z0-9-]/g, "-");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="audit-${slug}-${day}.csv"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
};
