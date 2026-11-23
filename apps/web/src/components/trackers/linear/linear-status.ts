import type { LinearAddressProblem } from "@ostra/domain";

import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import type { LinearConnection, LinearStatus } from "./linear-types";

export type { LinearConnection, LinearStatus } from "./linear-types";

/** Where each of the three connect steps stands, from the status. */
export type ConnectSteps = { readonly created: boolean; readonly saved: boolean };

export const connectSteps = (status: LinearStatus): ConnectSteps =>
  status.state === "none" ? { created: false, saved: false } : { created: true, saved: status.appSaved };

/** The first step that isn't done: 1, 2 or 3. */
export const currentStep = (steps: ConnectSteps): 1 | 2 | 3 => (!steps.created ? 1 : !steps.saved ? 2 : 3);

const thisYear = (at: number, now: number): boolean => new Date(at).getFullYear() === new Date(now).getFullYear();

/** `12 Nov`, with the year when it isn't this year (`12 Nov 2025`). */
export const formatDay = (at: number, now: number): string =>
  new Intl.DateTimeFormat("en-GB", thisYear(at, now) ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(at);

/** `19 Nov, 14:02`: a day and a clock time. */
export const formatDayTime = (at: number, now: number): string => `${formatDay(at, now)}, ${formatClock(at)}`;

/** A time today as a clock (`14:02`), an older one as a day (`12 Nov`). */
export const formatWhen = (at: number, now: number): string =>
  new Date(at).toDateString() === new Date(now).toDateString() ? formatClock(at) : formatDay(at, now);

/** `2 min ago`, `3 h ago`, `just now`. */
export const formatAgo = (at: number, now: number): string => {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} h ago`;
  return `${String(Math.floor(hours / 24))} d ago`;
};

/** How long until a time: `21 h`, `40 min`. */
export const formatLeft = (at: number, now: number): string => {
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  if (minutes < 60) return t("units.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? t("units.hours", { n: hours }) : t("units.days", { n: Math.round(hours / 24) });
};

/** Why Linear can't reach an address: the pre-check's code (or `polling`, for a connection that polls), in words. */
export const addressProblemText = (problem: LinearAddressProblem | "polling"): string => t(`trackers.linear.addressProblem.${problem}`);

/** The polling sentence, with the reason when the pre-check gave one; `{setting}` stays for the caller to set in mono. */
export const pollingLine = (reason: LinearAddressProblem | null, seconds: number): string =>
  reason === null
    ? t("trackers.linear.mode.pollingLineNoReason", { seconds, setting: "{setting}" })
    : t("trackers.linear.mode.pollingLine", { reason: addressProblemText(reason), seconds, setting: "{setting}" });

/** The connection row's status: its words and tone. */
export const connectionTone = (state: LinearConnection["state"]): { readonly tone: "green" | "red" | "grey"; readonly label: string } => {
  switch (state) {
    case "active":
      return { tone: "green", label: t("trackers.linear.connection.connected") };
    case "failed":
      return { tone: "red", label: t("trackers.linear.connection.failed") };
    case "pending":
      return { tone: "grey", label: t("trackers.linear.connection.pending") };
    default:
      return state satisfies never;
  }
};

/** Linear's page for a workspace. */
export const linearWorkspaceUrl = (workspaceKey: string | null): string =>
  workspaceKey === null ? "https://linear.app" : `https://linear.app/${encodeURIComponent(workspaceKey)}`;

/** A long URL cut in its middle, so its host and its end both show. */
export const middleTruncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
};
