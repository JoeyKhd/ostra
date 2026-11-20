import type { TicketStatusCategory } from "@ostra/adapter-sdk";
import { boardIdSchema } from "@ostra/protocol";
import type { BoardId } from "@ostra/protocol";
import { z } from "zod";

// An intake rule's filter (F-011, ADR 0056, Q210): a ticket's labels (any of, all of, none of), its
// status (by ID or by category), its assignee (a tracker user, nobody, or ostra's app), its board and
// the tracker's own project. Stored on `Automation.filter` and parsed here: a format ostra owns, so
// an unknown field is refused. `matchesFilter` is pure, over milestone 2's cached ticket.

const nameSchema = z.string().trim().min(1).max(200);
const idSchema = z.string().trim().min(1).max(200);
const LIST_MAX = 50;

export const ticketStatusCategorySchema = z.enum(["open", "started", "done", "cancelled"]) satisfies z.ZodType<TicketStatusCategory>;

export const assigneeConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), userId: idSchema }),
  z.strictObject({ kind: z.literal("unassigned") }),
  /** ostra's own app user in the tracker (a ticket delegated to ostra). */
  z.strictObject({ kind: z.literal("app") }),
]);
export type AssigneeCondition = z.infer<typeof assigneeConditionSchema>;

export const intakeFilterSchema = z
  .strictObject({
    /** Labels a ticket carries: `any` of them or `all` of them. Compared case-folded. */
    labels: z.strictObject({ mode: z.enum(["any", "all"]), names: z.array(nameSchema).min(1).max(LIST_MAX) }).nullable().default(null),
    /** Labels that keep a ticket out, whatever else matches. */
    excludeLabels: z.array(nameSchema).max(LIST_MAX).default([]),
    /** The ticket's status, by the tracker's status IDs or by category. */
    status: z
      .discriminatedUnion("by", [
        z.strictObject({ by: z.literal("id"), ids: z.array(idSchema).min(1).max(LIST_MAX) }),
        z.strictObject({ by: z.literal("category"), categories: z.array(ticketStatusCategorySchema).min(1).max(4) }),
      ])
      .nullable()
      .default(null),
    /** Any of these assignees. Empty: any assignee. */
    assignees: z.array(assigneeConditionSchema).max(LIST_MAX).default([]),
    /** Any of the project's boards. Empty: every board of the project. */
    boardIds: z.array(boardIdSchema).max(LIST_MAX).default([]),
    /** Any of the tracker's own projects (Linear's projects). Empty: any. */
    trackerProjectIds: z.array(idSchema).max(LIST_MAX).default([]),
  })
  .refine(
    (filter) =>
      filter.labels !== null ||
      filter.excludeLabels.length > 0 ||
      filter.status !== null ||
      filter.assignees.length > 0 ||
      filter.boardIds.length > 0 ||
      filter.trackerProjectIds.length > 0,
    { message: "a filter names at least one condition: a rule never matches every ticket" },
  );
export type IntakeFilter = z.infer<typeof intakeFilterSchema>;

/** A stored filter, parsed (external data: storage). */
export const parseIntakeFilter = (value: unknown): { readonly ok: true; readonly filter: IntakeFilter } | { readonly ok: false } => {
  const parsed = intakeFilterSchema.safeParse(value);
  return parsed.success ? { ok: true, filter: parsed.data } : { ok: false };
};

/** What a filter reads of a cached ticket. */
export type FilterTicket = {
  readonly boardId: BoardId;
  readonly labels: readonly string[];
  readonly statusId: string | null;
  readonly statusCategory: TicketStatusCategory | null;
  readonly assigneeId: string | null;
  /** The tracker's own project, when the cache knows it. */
  readonly trackerProjectId: string | null;
  /** Neither done nor cancelled, and still on its board. */
  readonly open: boolean;
};

/** What the filter needs besides the ticket: ostra's app user in the tracker, when it has one. */
export type FilterContext = { readonly appUserId: string | null };

const fold = (label: string): string => label.trim().toLowerCase();

/**
 * Whether the ticket matches every condition the filter names. A closed or removed ticket never
 * matches: a rule starts work, and a closed ticket has none left.
 */
export const matchesFilter = (ticket: FilterTicket, filter: IntakeFilter, context: FilterContext = { appUserId: null }): boolean => {
  if (!ticket.open) {
    return false;
  }
  const labels = new Set(ticket.labels.map(fold));
  if (filter.excludeLabels.some((label) => labels.has(fold(label)))) {
    return false;
  }
  if (filter.labels !== null) {
    const wanted = filter.labels.names.map(fold);
    const ok = filter.labels.mode === "all" ? wanted.every((label) => labels.has(label)) : wanted.some((label) => labels.has(label));
    if (!ok) {
      return false;
    }
  }
  if (filter.status !== null) {
    switch (filter.status.by) {
      case "id":
        if (ticket.statusId === null || !filter.status.ids.includes(ticket.statusId)) {
          return false;
        }
        break;
      case "category":
        if (ticket.statusCategory === null || !filter.status.categories.includes(ticket.statusCategory)) {
          return false;
        }
        break;
      default:
        return filter.status satisfies never;
    }
  }
  if (filter.assignees.length > 0 && !filter.assignees.some((condition) => assigneeMatches(condition, ticket.assigneeId, context))) {
    return false;
  }
  if (filter.boardIds.length > 0 && !filter.boardIds.includes(ticket.boardId)) {
    return false;
  }
  if (filter.trackerProjectIds.length > 0 && (ticket.trackerProjectId === null || !filter.trackerProjectIds.includes(ticket.trackerProjectId))) {
    return false;
  }
  return true;
};

const assigneeMatches = (condition: AssigneeCondition, assigneeId: string | null, context: FilterContext): boolean => {
  switch (condition.kind) {
    case "user":
      return assigneeId === condition.userId;
    case "unassigned":
      return assigneeId === null;
    case "app":
      return context.appUserId !== null && assigneeId === context.appUserId;
    default:
      return condition satisfies never;
  }
};
