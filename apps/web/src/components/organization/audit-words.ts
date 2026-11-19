import { t } from "@/lib/messages";

// The audit log's words and the pure rules behind its filters (audit-log.md), apart from the view so
// each one is tested without a browser.

const DAY = 24 * 60 * 60 * 1000;

export const auditPeriods = ["today", "7d", "30d", "90d", "all", "custom"] as const;
export type AuditPeriod = (typeof auditPeriods)[number];

export const isAuditPeriod = (value: string | null): value is AuditPeriod => auditPeriods.some((period) => period === value);

/** The start of `at`'s day in the viewer's time zone. */
const startOfDay = (at: number): number => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** A `YYYY-MM-DD` from a date input, as the start of that day in the viewer's zone; `null` if it isn't one. */
export const dayStart = (value: string | null): number | null => {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const at = new Date(year, month - 1, day).getTime();
  return Number.isNaN(at) ? null : at;
};

/** The period as the list's `from` (inclusive) and `to` (exclusive), epoch ms. Custom days are whole days. */
export const periodRange = (period: AuditPeriod, now: number, custom: { readonly from: string | null; readonly to: string | null }): { readonly from?: number; readonly to?: number } => {
  switch (period) {
    case "today":
      return { from: startOfDay(now) };
    case "7d":
      return { from: startOfDay(now) - 6 * DAY };
    case "30d":
      return { from: startOfDay(now) - 29 * DAY };
    case "90d":
      return { from: startOfDay(now) - 89 * DAY };
    case "all":
      return {};
    case "custom": {
      const from = dayStart(custom.from);
      const to = dayStart(custom.to);
      return { ...(from === null ? {} : { from }), ...(to === null ? {} : { to: to + DAY }) };
    }
    default:
      return period satisfies never;
  }
};

export const periodLabel = (period: AuditPeriod): string => t(`audit.period.${period}`);

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The day band's label: `Today`, `Yesterday`, `Mon 17 Nov`, and `17 Nov 2025` past this year. */
export const dayLabel = (at: number, now: number): string => {
  const day = startOfDay(at);
  const today = startOfDay(now);
  if (day === today) return t("audit.today");
  if (day === startOfDay(today - DAY / 2)) return t("audit.yesterday");
  const date = new Date(at);
  const dm = `${String(date.getDate())} ${months[date.getMonth()] ?? ""}`;
  return date.getFullYear() === new Date(now).getFullYear() ? `${weekdays[date.getDay()] ?? ""} ${dm}` : `${dm} ${String(date.getFullYear())}`;
};

/** The key of `at`'s day in the viewer's zone, for grouping rows under their band. */
export const dayKey = (at: number): string => {
  const date = new Date(at);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1)}-${String(date.getDate())}`;
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** `14:07`, in the viewer's zone. */
export const timeOfDay = (at: number): string => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** `19 Nov 2026, 14:07:33`, in the viewer's zone. */
export const fullTime = (at: number): string => {
  const date = new Date(at);
  return `${String(date.getDate())} ${months[date.getMonth()] ?? ""} ${String(date.getFullYear())}, ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/** One line per leaf of an entry's `data`, nested keys dotted (`grants.0.role`). */
export const flattenData = (data: unknown, prefix = ""): readonly (readonly [string, string])[] => {
  if (data === null || data === undefined) return prefix === "" ? [] : [[prefix, String(data)]];
  if (Array.isArray(data)) {
    if (data.length === 0) return prefix === "" ? [] : [[prefix, "[]"]];
    return data.flatMap((value: unknown, i) => flattenData(value, prefix === "" ? String(i) : `${prefix}.${String(i)}`));
  }
  if (typeof data === "object") {
    const entries = Object.entries(data);
    if (entries.length === 0) return prefix === "" ? [] : [[prefix, "{}"]];
    return entries.flatMap(([key, value]) => flattenData(value, prefix === "" ? key : `${prefix}.${key}`));
  }
  return [[prefix === "" ? "value" : prefix, typeof data === "string" ? data : JSON.stringify(data)]];
};

/** An action's group, its prefix with the dot (`task.`), which the list takes as a filter of its own. */
export const actionPrefix = (action: string): string => `${action.split(".")[0] ?? action}.`;

/** Where an entry's entity opens, or `null` when the panel has no page for it. */
export const entityHref = (entry: { readonly entity: string | null; readonly entityId: string | null; readonly taskId: string | null }): string | null => {
  if (entry.taskId !== null && (entry.entity === "task" || entry.entity === null)) return `/tasks/${entry.taskId}`;
  if (entry.entityId === null) return null;
  switch (entry.entity) {
    case "task":
      return `/tasks/${entry.entityId}`;
    case "project":
      return `/projects/${entry.entityId}`;
    case "member":
    case "invitation":
      return "/organization/members";
    case "provider":
    case "model":
      return "/organization/models";
    case "pool":
    case "runner":
      return "/organization/runners";
    case "agent_profile":
      return `/organization/agent-profiles/${entry.entityId}`;
    case null:
    default:
      return null;
  }
};

/** A short form of a long ID: its first 8 characters. */
export const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id);
