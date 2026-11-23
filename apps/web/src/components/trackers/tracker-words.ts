import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { trackerName } from "./tracker-mark";

// What Organization › Trackers reads and says (F-152, F-008; app-targets/m11-trackers/trackers.md):
// `trackers.list` and `trackers.get` (m11 ticket 09), and the words of each row's status, its
// panel's rows and the picker's chips. Pure, so the tests read every state without a browser.

export type TrackerList = RouterOutputs["trackers"]["list"];
export type TrackerItem = TrackerList["connections"][number];
export type TrackerDetail = RouterOutputs["trackers"]["get"];
export type TrackerKind = TrackerItem["kind"];
export type TrackerCapabilities = TrackerItem["capabilities"];

/** What the picker's tiles show of each kind's adapter: the declared capabilities, read on the server. */
export type KindCapabilities = Pick<TrackerCapabilities, "agentSessions" | "subIssues" | "magicWords" | "transitions" | "jqlFilter">;
export type PickerKinds = Readonly<Record<TrackerKind, KindCapabilities>>;

/** The kinds the picker offers, in its order: Linear, then Jira. */
export const pickerKinds = ["linear", "jira"] as const satisfies readonly TrackerKind[];

/** The two the picker shows as Coming soon (choice 1, F-152/c8): no link, no form. */
export const comingSoonKinds = ["trello", "notion"] as const;

/** A row's status (trackers.md, "States"): its word and, for Pending and Failed, the reason under it. */
export type RowStatus =
  | { readonly kind: "connected" }
  | { readonly kind: "pending"; readonly why: string }
  | { readonly kind: "failed"; readonly why: string | null }
  | { readonly kind: "silent" }
  | { readonly kind: "expiring" };

/** A failed connection's reason, in the row's words: the codes Jira's steps set, and Linear's refusal. */
export const failedWords = (reason: string | null): string | null => {
  if (reason === null || reason.trim() === "") return null;
  switch (reason) {
    case "token-refused":
      return t("trackers.why.tokenRefused");
    case "token-expired":
      return t("trackers.why.tokenExpired");
    case "site-not-found":
      return t("trackers.why.siteNotFound");
    default:
      // Linear's token refresh fails with a sentence ("Linear refused the refresh token: …").
      return /\brefused\b/i.test(reason) ? t("trackers.why.tokenRefused") : reason;
  }
};

/**
 * The row's status: Failed with its reason; Pending with what it waits for (Jira's first delivery,
 * Linear's consent); and once active, Token expires from 14 days before the date, Silent while the
 * webhooks bring nothing that polling finds, or Connected.
 */
export const rowStatus = (connection: Pick<TrackerItem, "kind" | "state" | "failedReason" | "silentSince" | "tokenExpiry">): RowStatus => {
  switch (connection.state) {
    case "failed":
      return { kind: "failed", why: failedWords(connection.failedReason) };
    case "pending":
      return { kind: "pending", why: connection.kind === "jira" ? t("trackers.why.noDelivery") : t("trackers.why.notAuthorized") };
    case "active":
      if (connection.tokenExpiry?.state === "expired") return { kind: "failed", why: t("trackers.why.tokenExpired") };
      if (connection.tokenExpiry?.state === "expires-soon") return { kind: "expiring" };
      if (connection.silentSince !== null) return { kind: "silent" };
      return { kind: "connected" };
    default:
      return connection.state satisfies never;
  }
};

/** The status's word. */
export const statusWord = (status: RowStatus): string => {
  switch (status.kind) {
    case "connected":
      return t("trackers.status.connected");
    case "pending":
      return t("trackers.status.pending");
    case "failed":
      return t("trackers.status.failed");
    case "silent":
      return t("trackers.status.silent");
    case "expiring":
      return t("trackers.status.expiring");
    default:
      return status satisfies never;
  }
};

/** The line under a connection's name: `Linear`, `Jira Cloud`. */
export const kindWord = (kind: TrackerKind): string => t(`trackers.kind.${kind}`);

/** `Webhooks` or `Polling`. */
export const modeWord = (mode: TrackerItem["webhookMode"]): string => t(`trackers.mode.${mode}`);

/** How long ago, in the list's mono: `40s ago`, `6m ago`, `3h ago`. */
export const agoText = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return t("trackers.ago", { age: seconds < 60 ? t("units.seconds", { n: seconds }) : formatAge(at, now) });
};

/** A connection's first word, the client it's for: `Globex Jira` → `Globex`. */
const clientOf = (name: string): string => name.trim().split(/\s+/)[0] ?? "";

/**
 * The line under the table (trackers.md): with connections of two clients, the second's never pass
 * through the first's; otherwise the sentence's first half alone.
 */
export const keptApartText = (names: readonly string[]): string => {
  const clients = [...new Set(names.map(clientOf).filter((client) => client !== ""))];
  const [first, second] = clients;
  return first === undefined || second === undefined ? t("trackers.keptApartPlain") : t("trackers.keptApart", { first: second, second: first });
};

/** The sub-issues' word on each kind: Jira says sub-tasks. */
const subIssuesKey = (kind: TrackerKind): MessageKey => (kind === "jira" ? "trackers.cap.subTasks" : "trackers.cap.subIssues");

/**
 * A tile's chips: only what the kind's adapter declares (README, "Adapter parity is visible"), in the
 * targets' order: Linear's agent mode, sub-issues and magic words; Jira's workflow transitions,
 * sub-tasks and JQL filter.
 */
export const capabilityChips = (kind: TrackerKind, capabilities: KindCapabilities): readonly string[] => [
  ...(capabilities.agentSessions ? [t("trackers.cap.agentMode")] : []),
  ...(capabilities.transitions ? [t("trackers.cap.transitions")] : []),
  ...(capabilities.subIssues ? [t(subIssuesKey(kind))] : []),
  ...(capabilities.magicWords ? [t("trackers.cap.magicWords")] : []),
  ...(capabilities.jqlFilter ? [t("trackers.cap.jql")] : []),
];

/** One row of the panel's "What <kind> does here". */
export type CapabilityRow = { readonly label: string; readonly value: string; readonly faint: boolean };

/**
 * "What <kind> does here" (trackers.md, "The properties panel"): how it moves a status, its
 * sub-issues when it declares them, its rich text, and agent mode: On or Off where the adapter has
 * agent sessions, and `– not in Jira` where it doesn't, with nothing else of agent mode (choice 11).
 */
export const capabilityRows = (kind: TrackerKind, capabilities: Pick<TrackerCapabilities, "transitions" | "subIssues" | "richText" | "agentSessions">, agentModeAt: number | null): readonly CapabilityRow[] => [
  { label: t("trackers.panel.moves"), value: capabilities.transitions ? t("trackers.panel.byTransitions") : t("trackers.panel.directly"), faint: false },
  ...(capabilities.subIssues ? [{ label: t(kind === "jira" ? "trackers.panel.subTasks" : "trackers.panel.subIssues"), value: t("trackers.panel.yes"), faint: false }] : []),
  { label: t("trackers.panel.richText"), value: capabilities.richText === "adf" ? t("trackers.panel.adf") : t("trackers.panel.markdown"), faint: false },
  capabilities.agentSessions
    ? { label: t("trackers.panel.agentMode"), value: agentModeAt === null ? t("trackers.panel.off") : t("trackers.panel.on"), faint: false }
    : { label: t("trackers.panel.agentMode"), value: t("trackers.panel.notIn", { kind: trackerName[kind] }), faint: true },
];
