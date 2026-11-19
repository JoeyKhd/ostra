import { plural, t } from "@/lib/messages";
import type { RouterInputs, RouterOutputs } from "@/lib/trpc";

// The Inbox's pure parts (inbox.md, F-010): the filters as they live in the URL, the lede, and the
// short ages of the rows.

export type InboxPage = RouterOutputs["inbox"]["list"];
export type InboxTicket = InboxPage["tickets"][number];
export type InboxSource = InboxPage["source"];
export type InboxDetail = RouterOutputs["inbox"]["get"];
type ListInput = RouterInputs["inbox"]["list"];

/** The filters, as the URL holds them: `?status=open,started&label=bug&priority=1&assignee=…&q=…`. */
export type InboxFilters = {
  readonly status: readonly string[];
  readonly labels: readonly string[];
  readonly priorities: readonly number[];
  readonly assignees: readonly string[];
  readonly text: string;
};

export const DEFAULT_STATUS = ["open"] as const;

const list = (value: string | null): readonly string[] => (value === null || value === "" ? [] : value.split(",").filter((item) => item !== ""));

export const filtersFrom = (params: { readonly get: (name: string) => string | null }): InboxFilters => {
  const status = list(params.get("status"));
  return {
    status: status.length === 0 ? DEFAULT_STATUS : status,
    labels: list(params.get("label")),
    priorities: list(params.get("priority"))
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 4),
    assignees: list(params.get("assignee")),
    text: params.get("q") ?? "",
  };
};

/** The filters as a query string (the default status left out), keeping other parameters. */
export const filtersToSearch = (filters: InboxFilters, keep: URLSearchParams): string => {
  const next = new URLSearchParams(keep);
  const set = (name: string, values: readonly (string | number)[]) => {
    if (values.length === 0) next.delete(name);
    else next.set(name, values.join(","));
  };
  set("status", filters.status.length === 1 && filters.status[0] === "open" ? [] : filters.status);
  set("label", filters.labels);
  set("priority", filters.priorities);
  set("assignee", filters.assignees);
  if (filters.text.trim() === "") next.delete("q");
  else next.set("q", filters.text);
  const text = next.toString();
  return text === "" ? "" : `?${text}`;
};

export const filtered = (filters: InboxFilters): boolean =>
  !(filters.status.length === 1 && filters.status[0] === "open") || filters.labels.length > 0 || filters.priorities.length > 0 || filters.assignees.length > 0 || filters.text.trim() !== "";

/** `inbox.list`'s input for these filters, without the cursor. */
export const listInputOf = (projectId: ListInput["projectId"], filters: InboxFilters): ListInput => ({
  projectId,
  status: [...filters.status],
  limit: 50,
  ...(filters.labels.length > 0 ? { labels: [...filters.labels] } : {}),
  ...(filters.priorities.length > 0 ? { priorities: [...filters.priorities] } : {}),
  ...(filters.assignees.length > 0 ? { assignees: [...filters.assignees] } : {}),
  ...(filters.text.trim() !== "" ? { text: filters.text.trim() } : {}),
});

/** `3m`, `2h`, `1d`: the age of a row's last change. */
export const rowAge = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)}h` : `${String(Math.floor(hours / 24))}d`;
};

/** `8s ago`, `4 min ago`, `2 h ago`: the cache's age in the lede. */
export const cacheAge = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)} h ago` : `${String(Math.floor(hours / 24))} d ago`;
};

/** The lede's first half: one board by name, or several by count. */
export const ledeSource = (source: InboxSource): { readonly board: string | null; readonly text: string } => {
  const [only] = source.boards;
  if (source.boards.length === 1 && only !== undefined) return { board: only.name, text: t("inbox.ledeOne") };
  return { board: null, text: t("inbox.ledeMany", { n: source.boards.length }) };
};

const priorityKeys = ["inbox.priority.0", "inbox.priority.1", "inbox.priority.2", "inbox.priority.3", "inbox.priority.4"] as const;

/** Linear's scale in words: 1 urgent to 4 low; anything else is no priority. */
export const priorityText = (priority: number | null): string => t(priorityKeys[priority ?? 0] ?? "inbox.priority.0");

/** What the agent gets, from what the cached ticket holds. */
export const contextLine = (detail: Pick<InboxDetail, "imageCount" | "parentKey">): string => {
  const images = detail.imageCount > 0 ? plural(detail.imageCount, "inbox.panel.contextImages.one", "inbox.panel.contextImages.other") : "";
  const parent = detail.parentKey === null ? "" : t("inbox.panel.contextParent");
  return t("inbox.panel.context", { extra: `${images}${parent}` });
};
