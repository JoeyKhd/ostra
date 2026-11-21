import type { IntakeFilter } from "@ostra/domain";
import type { PayloadCondition } from "@ostra/domain/webhook-template";

import { plural, t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { cronSentenceText } from "./cron-words";

// Automations in words (automations.md, "The filter in words"; automation-history.md): one place for
// the list, the editor and the history, so each says a filter, a date and an outcome the same way.

export type Automation = RouterOutputs["automations"]["list"]["automations"][number];
export type HistoryRun = RouterOutputs["automations"]["history"]["runs"][number];
export type SkipReason = NonNullable<HistoryRun["skipReason"]>;
type Category = "open" | "started" | "done" | "cancelled";

/** The names a filter's IDs stand for: the board's statuses, the tracker's users, the project's boards. */
export type FilterNames = {
  readonly statuses: ReadonlyMap<string, string>;
  readonly assignees: ReadonlyMap<string, string>;
  readonly boards: ReadonlyMap<string, string>;
  /** The board clause shows only when the project has more than one board. */
  readonly boardCount: number;
};

export const noNames: FilterNames = { statuses: new Map(), assignees: new Map(), boards: new Map(), boardCount: 0 };

/** "a", "a or b", "a, b or c" (or "and"). */
export const listWords = (items: readonly string[], joiner: "or" | "and"): string => {
  const last = items.at(-1);
  if (last === undefined) return "";
  if (items.length === 1) return last;
  return t(joiner === "or" ? "automations.words.or" : "automations.words.and", { list: items.slice(0, -1).join(", "), last });
};

export const categoryWord = (category: Category): string => {
  switch (category) {
    case "open":
      return t("automations.words.category.open");
    case "started":
      return t("automations.words.category.started");
    case "done":
      return t("automations.words.category.done");
    case "cancelled":
      return t("automations.words.category.cancelled");
    default:
      return category satisfies never;
  }
};

/** One assignee condition in words, as a value (`Unassigned`, `ostra`, the user's name). */
export const assigneeValue = (condition: IntakeFilter["assignees"][number], names: FilterNames): string => {
  switch (condition.kind) {
    case "unassigned":
      return t("automations.words.unassignedValue");
    case "app":
      return t("automations.words.app");
    case "user":
      return names.assignees.get(condition.userId) ?? condition.userId;
    default:
      return condition satisfies never;
  }
};

const assigneeClause = (condition: IntakeFilter["assignees"][number], names: FilterNames): string => {
  switch (condition.kind) {
    case "unassigned":
      return t("automations.words.unassigned");
    case "app":
      return t("automations.words.assignedApp");
    case "user":
      return t("automations.words.assignedTo", { name: names.assignees.get(condition.userId) ?? condition.userId });
    default:
      return condition satisfies never;
  }
};

/** A status filter's values in words. */
export const statusValues = (status: NonNullable<IntakeFilter["status"]>, names: FilterNames): readonly string[] =>
  status.by === "id" ? status.ids.map((id) => names.statuses.get(id) ?? t("automations.words.unknownStatus")) : status.categories.map(categoryWord);

/**
 * A filter's clauses in a fixed order, joined by ", ": labels, the labels it excludes, status,
 * assignee, board (when the project has more than one) and the tracker's project. "any status" when
 * there's no status clause; "every open ticket" when there's nothing.
 */
export const filterWords = (filter: IntakeFilter, names: FilterNames): string => {
  const clauses: string[] = [];
  if (filter.labels !== null) {
    clauses.push(
      filter.labels.mode === "all" && filter.labels.names.length > 1
        ? t("automations.words.labelsAll", { names: listWords(filter.labels.names, "and") })
        : t("automations.words.label", { names: listWords(filter.labels.names, "or") }),
    );
  }
  if (filter.excludeLabels.length > 0) clauses.push(t("automations.words.notLabel", { names: listWords(filter.excludeLabels, "or") }));
  if (filter.status !== null) {
    const values = listWords(statusValues(filter.status, names), "or");
    clauses.push(filter.status.by === "id" ? t("automations.words.status", { names: values }) : t("automations.words.statusCategory", { names: values }));
  }
  if (filter.assignees.length > 0) clauses.push(listWords(filter.assignees.map((condition) => assigneeClause(condition, names)), "or"));
  if (filter.boardIds.length > 0 && names.boardCount > 1) {
    clauses.push(t("automations.words.board", { names: listWords(filter.boardIds.map((id) => names.boards.get(id) ?? id), "or") }));
  }
  if (filter.trackerProjectIds.length > 0) clauses.push(t("automations.words.trackerProject", { names: listWords(filter.trackerProjectIds, "or") }));
  if (clauses.length === 0) return t("automations.words.everyTicket");
  if (filter.status === null) clauses.push(t("automations.words.anyStatus"));
  return clauses.join(", ");
};

/** "Mon 16 Nov, 09:00" in a zone (the viewer's when none is given). Dates are sans; this is text. */
export const occurrenceText = (at: number, timeZone?: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(at);

/** "09:00" in a zone. */
export const clockText = (at: number, timeZone?: string): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone === undefined ? {} : { timeZone }) }).format(at);

/** "18 Nov" in a zone. */
export const dayText = (at: number, timeZone?: string): string =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(timeZone === undefined ? {} : { timeZone }) }).format(at);

/** "Mon 16 Nov" in a zone. */
export const weekdayText = (at: number, timeZone?: string): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", ...(timeZone === undefined ? {} : { timeZone }) }).format(at);

/** "16 Nov 2026, 09:00:04" in a zone. */
export const secondsText = (at: number, timeZone?: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(at);

export const taskKindWord = (kind: Automation["taskKind"]): string => {
  switch (kind) {
    case "code":
      return t("automations.kindLabel.code");
    case "refine":
      return t("automations.kindLabel.refine");
    case "review":
      return t("automations.kindLabel.review");
    default:
      return kind satisfies never;
  }
};

export const taskKindLong = (kind: Automation["taskKind"]): string => {
  switch (kind) {
    case "code":
      return t("automations.taskKindLong.code");
    case "refine":
      return t("automations.taskKindLong.refine");
    case "review":
      return t("automations.taskKindLong.review");
    default:
      return kind satisfies never;
  }
};

/** One condition of a webhook's filter in words: `body.status is firing`. */
export const payloadConditionWords = (condition: PayloadCondition): string => {
  switch (condition.op) {
    case "equals":
      return t("automations.words.conditionEquals", { path: condition.path, value: condition.value });
    case "not-equals":
      return t("automations.words.conditionNotEquals", { path: condition.path, value: condition.value });
    case "contains":
      return t("automations.words.conditionContains", { path: condition.path, value: condition.value });
    case "exists":
      return t("automations.words.conditionExists", { path: condition.path });
    default:
      return condition satisfies never;
  }
};

/** A webhook's trigger in words: "on a request", and its filter's conditions when it has some. */
export const webhookWords = (filter: readonly PayloadCondition[]): string =>
  filter.length === 0 ? t("automations.onARequest") : t("automations.words.requestWhere", { conditions: listWords(filter.map(payloadConditionWords), "and") });

/** What a row's Next cell says: the reason it's paused, a schedule's next time, or "on a match". */
export const nextText = (automation: Automation, startsPerHour: number): { readonly text: string; readonly tone: "text" | "faint" | "muted"; readonly limit: boolean } => {
  if (automation.paused !== null) {
    if (automation.paused.reason === "hourly_limit") return { text: t("automations.pausedLimit", { n: startsPerHour }), tone: "muted", limit: true };
    return { text: automation.paused.byName === null ? t("automations.pausedByNobody") : t("automations.pausedBy", { name: automation.paused.byName }), tone: "muted", limit: false };
  }
  if (automation.kind === "webhook") return { text: t("automations.onARequest"), tone: "faint", limit: false };
  if (automation.schedule === null) return { text: t("automations.onAMatch"), tone: "faint", limit: false };
  if (automation.nextOccurrenceAt === null) return { text: "—", tone: "faint", limit: false };
  return { text: occurrenceText(automation.nextOccurrenceAt, automation.schedule.timeZone), tone: "text", limit: false };
};

/** A row's "Starts when": a rule's filter, or a schedule's sentence (and "checks its filter"). */
export const startsWhenText = (automation: Automation, names: FilterNames): string => {
  if (automation.webhook !== null) return webhookWords(automation.webhook.filter);
  if (automation.schedule === null) return automation.filter === null ? t("automations.words.everyTicket") : filterWords(automation.filter, names);
  const sentence = cronSentenceText(automation.schedule.sentence);
  return automation.schedule.does === "filter" ? `${sentence} · ${t("automations.checksFilter")}` : sentence;
};

/** Why a run was skipped, as the history's Task column says it. A webhook's hourly limit is its own setting. */
export const skipReasonText = (
  reason: SkipReason,
  limits: { readonly startsPerHour: number; readonly bulkStartMax: number; readonly webhookStartsPerHour?: number },
  kind: Automation["kind"] = "intake_rule",
): string => {
  switch (reason) {
    case "has_task":
      return t("automations.history.reason.has_task");
    case "last_open":
      return t("automations.history.reason.last_open");
    case "paused":
      return t("automations.history.reason.paused");
    case "hourly_limit":
      return kind === "webhook"
        ? t("automations.history.reason.hourlyLimitWebhook", { n: limits.webhookStartsPerHour ?? limits.startsPerHour })
        : t("automations.history.reason.hourly_limit", { n: limits.startsPerHour });
    case "over_limit":
      return t("automations.history.reason.over_limit", { n: limits.bulkStartMax });
    case "budget":
      return t("automations.history.reason.budget");
    case "filtered":
      return t("automations.history.reason.filtered");
    case "duplicate":
      return t("automations.history.reason.duplicate");
    case "setup":
      return t("automations.history.reason.setup");
    default:
      return reason satisfies never;
  }
};

/** A dry run's outcome for one ticket. */
export type DryOutcome = RouterOutputs["automations"]["dryRun"]["rows"][number]["outcome"];

export const dryOutcomeText = (outcome: DryOutcome, kind: "code" | "refine"): string => {
  if (outcome.kind === "would-start") return kind === "code" ? t("automations.dry.starts.code") : t("automations.dry.starts.refine");
  switch (outcome.reason) {
    case "has-task":
      return outcome.shortId === null ? t("automations.dry.hasTaskNone") : t("automations.dry.hasTask");
    case "has-sub-issues":
      return t("automations.dry.subIssues", { n: outcome.subIssues });
    case "matched-before":
      return t("automations.dry.matchedBefore");
    case "last_open":
      return t("automations.dry.skip.last_open");
    case "has_task":
      return t("automations.dry.skip.has_task");
    case "paused":
      return t("automations.dry.skip.paused");
    case "hourly_limit":
      return t("automations.dry.skip.hourly_limit");
    case "over_limit":
      return t("automations.dry.skip.over_limit");
    case "budget":
      return t("automations.dry.skip.budget");
    case "filtered":
      return t("automations.dry.skip.filtered");
    case "duplicate":
      return t("automations.dry.skip.duplicate");
    case "setup":
      return t("automations.dry.skip.setup");
    default:
      return outcome satisfies never;
  }
};

/** The count line of a dry run: "4 tickets match now". */
export const dryCountText = (n: number): string => (n === 0 ? t("automations.dry.none") : plural(n, "automations.dry.count.one", "automations.dry.count.other"));

/** Why a bulk start's ticket didn't start (the domain's reason codes), in words for every list that shows one. */
export const bulkReasonText = (reason: string | null): string => {
  switch (reason ?? "") {
    case "has-task":
      return t("bulk.reason.hasTask");
    case "has-sub-issues":
      return t("bulk.reason.hasSubIssues");
    case "not-on-a-board":
      return t("bulk.reason.notOnABoard");
    case "no-access":
      return t("bulk.reason.noAccess");
    case "matched-before":
      return t("bulk.reason.matchedBefore");
    case "automation-deleted":
      return t("bulk.reason.automationDeleted");
    case "not-found":
      return t("bulk.reason.notFound");
    case "no-default-profile":
    case "no-agent-profile":
      return t("bulk.reason.noProfile");
    case "no-repo":
      return t("bulk.reason.noRepo");
    case "no-provider-for-model":
      return t("bulk.reason.noProvider");
    default:
      return t("bulk.reason.other", { code: reason ?? "" });
  }
};

/**
 * The draft's pool labels no runner of the project's pools carries (automation-edit.md): its tasks
 * would wait for one. Checked as the member types, against what the list says the runners carry;
 * nothing while that isn't known yet.
 */
export const labelsNoRunnerCarries = (draft: readonly string[], runnerLabels: readonly string[] | undefined): readonly string[] =>
  runnerLabels === undefined ? [] : draft.filter((label) => !runnerLabels.includes(label));
