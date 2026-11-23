import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// What connecting Jira reads and says (F-008, F-152; app-targets/m11-trackers/jira-connect.md): the
// steps a pending connection is at, step 1's site name, step 2's read-back as lines of words, the
// token's date, and step 3's events and reasons. Pure, so the tests read every state without a
// browser. The words are `trackers.jira.connect.*`; Jira's own words (a status code, a key, a
// scope) are values set in mono, and its error bodies never reach the panel (ticket 09).

export type TrackerDetail = RouterOutputs["trackers"]["get"];
export type JiraDetail = Extract<TrackerDetail, { readonly kind: "jira" }>;
export type JiraSiteResult = RouterOutputs["trackers"]["jira"]["findSite"];
export type JiraCheckResult = RouterOutputs["trackers"]["jira"]["checkToken"];
export type JiraReadBack = JiraCheckResult["readBack"];
export type JiraChecks = Extract<JiraReadBack, { readonly kind: "checked" }>;
export type JiraVerdict = NonNullable<JiraCheckResult["verdict"]>;
export type JiraSaveResult = RouterOutputs["trackers"]["jira"]["saveToken"];
export type JiraWebhook = RouterOutputs["trackers"]["jira"]["webhook"]["webhook"];
export type JiraAddressProblem = NonNullable<JiraDetail["jira"]["modeReason"]>;
type JiraPermission = JiraChecks["permissions"]["projects"][number]["missing"][number];

// ---------- step 1: the site ----------

const CLOUD_HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.atlassian\.net$/;

/**
 * The site's name as step 1's field holds it (jira-connect.md: "a pasted full URL is trimmed to the
 * name"): `globex`, `globex.atlassian.net` and `https://globex.atlassian.net/jira/software/projects`
 * are all `globex`. Another host stays whole (`jira.initech.example`), so Find the site can say it's
 * a Data Center address; text that names no host stays as typed.
 */
export const jiraSiteName = (input: string): string => {
  const text = input.trim().toLowerCase();
  if (text === "" || !/[./:]/.test(text)) return text;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
  const host = URL.canParse(withScheme) ? new URL(withScheme).hostname.replace(/\.$/, "") : text;
  return CLOUD_HOST.exec(host)?.[1] ?? (host === "" ? text : host);
};

/** The host a site name stands for: `globex` is `globex.atlassian.net`; a host stays a host. `null` when empty. */
export const jiraSiteHost = (name: string): string | null => {
  const site = jiraSiteName(name);
  if (site === "") return null;
  return site.includes(".") ? site : `${site}.atlassian.net`;
};

/** Whether the field holds a whole host rather than a site's name: the `.atlassian.net` suffix then hides. */
export const isWholeHost = (name: string): boolean => jiraSiteName(name).includes(".");

/** A title from the site's name, as the connect kit makes one: `acme-corp` is `Acme Corp`. `null` for a host. */
export const jiraSiteTitle = (name: string): string | null => {
  const site = jiraSiteName(name);
  if (site === "" || site.includes(".")) return null;
  return site
    .split("-")
    .filter((word) => word !== "")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
};

/** The name a connection is prefilled with from its site (choice 2): `Globex Jira`, or `Jira` before a site. */
export const jiraDefaultName = (site: string): string => {
  const title = jiraSiteTitle(site);
  return title === null || title === "" ? "Jira" : `${title} Jira`;
};

/** A name the server gave a connection before its site was known: `Jira`, `Jira 2`. Step 1 prefills over it. */
export const isPlaceholderJiraName = (name: string): boolean => /^Jira(?: [0-9]+)?$/.test(name);

/** Step 1's refusal, drawn under the field: its words, and the connection that holds the site for `Open it →`. */
export type SiteRefusal = { readonly text: string; readonly holder: Extract<JiraSiteResult, { readonly error: "site-taken" }>["holder"] | null };

/** Step 1's answer when Jira or the organization refused it, in the target's words. */
export const siteRefusal = (result: Extract<JiraSiteResult, { readonly ok: false }>, site: string, name: string): SiteRefusal => {
  const host = jiraSiteHost(site);
  switch (result.error) {
    case "not-found":
      return { text: host === null ? t("trackers.jira.connect.step1.notASite") : t("trackers.jira.connect.step1.notFound", { host }), holder: null };
    case "data-center":
      return { text: t("trackers.jira.connect.step1.dataCenter"), holder: null };
    case "unreachable":
      return { text: t("trackers.jira.connect.step1.unreachable", { host: host ?? site }), holder: null };
    case "name-taken":
      return { text: t("trackers.jira.connect.step1.nameTaken", { name }), holder: null };
    case "site-taken":
      return { text: t("trackers.jira.connect.step1.siteTaken", { host: host ?? site, name: result.holder.name }), holder: result.holder };
    default:
      return result satisfies never;
  }
};

// ---------- the steps ----------

export type StepNumber = 1 | 2 | 3;

/** Where a pending connection stands: the site found, the token saved, and the step that's open. */
export type JiraSteps = { readonly site: boolean; readonly token: boolean; readonly current: StepNumber; readonly done: 0 | 1 | 2 };

/**
 * The steps from the connection as `trackers.get` reads it: the site is found once it has a cloud
 * ID; the token is saved once it has the service account's email and the token's date. `reopened`
 * is a done step the admin opened again (`Change`, `Replace`): it and the steps after it are open
 * again, and the done count is what's before it.
 */
export const jiraSteps = (detail: Pick<JiraDetail, "tokenExpiresAt"> & { readonly jira: Pick<JiraDetail["jira"], "cloudId" | "email"> }, reopened: 1 | 2 | null = null): JiraSteps => {
  const site = detail.jira.cloudId !== null && reopened !== 1;
  const token = site && detail.jira.email !== null && detail.tokenExpiresAt !== null && reopened !== 2;
  return { site, token, current: !site ? 1 : !token ? 2 : 3, done: !site ? 0 : !token ? 1 : 2 };
};

/** A step's circle (jira-connect.md, "A step"): done, the one that's open, or one after it. */
export type StepState = "done" | "current" | "later";

export const stepState = (n: StepNumber, current: StepNumber): StepState => (n < current ? "done" : n === current ? "current" : "later");

// ---------- words with values in them ----------

/** A value set into a sentence: mono (a key, a name Jira gave, a status code), bold, or plain. */
export type Value =
  | { readonly kind: "text"; readonly text: string; readonly look: "plain" | "mono" | "strong" }
  /** Several values in one list (`PROJ, SHOP and OPS`, `transition or comment`), each set alike. */
  | { readonly kind: "list"; readonly items: readonly string[]; readonly join: "and" | "or" | "comma"; readonly look: "plain" | "mono" | "strong" };

/** One sentence: a message with `{name}` holes and the values that fill them. */
export type Words = { readonly template: string; readonly values: Readonly<Record<string, Value>> };

export const mono = (text: string): Value => ({ kind: "text", text, look: "mono" });
export const strong = (text: string): Value => ({ kind: "text", text, look: "strong" });
export const plain = (text: string): Value => ({ kind: "text", text, look: "plain" });

/** A piece of a sentence as it's drawn. */
export type Piece = { readonly text: string; readonly look: "plain" | "mono" | "strong" };

const listFormat = (join: "and" | "or" | "comma"): Intl.ListFormat =>
  new Intl.ListFormat("en", join === "comma" ? { style: "narrow", type: "unit" } : { style: "long", type: join === "and" ? "conjunction" : "disjunction" });

/** A sentence as pieces: its text between the values, and each value with its look. */
export const piecesOf = (words: Words): readonly Piece[] => {
  const pieces: Piece[] = [];
  for (const part of words.template.split(/(\{\w+\})/)) {
    if (part === "") continue;
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    const value = name === undefined ? undefined : words.values[name];
    if (value === undefined) {
      pieces.push({ text: part, look: "plain" });
    } else if (value.kind === "text") {
      pieces.push({ text: value.text, look: value.look });
    } else {
      // `narrow` `unit` lists join with spaces only: commas, as the target writes `PROJ, SHOP, OPS`.
      if (value.join === "comma") {
        value.items.forEach((item, i) => {
          if (i > 0) pieces.push({ text: ", ", look: "plain" });
          pieces.push({ text: item, look: value.look });
        });
      } else {
        for (const piece of listFormat(value.join).formatToParts([...value.items])) {
          pieces.push({ text: piece.value, look: piece.type === "element" ? value.look : "plain" });
        }
      }
    }
  }
  return pieces;
};

/** A sentence's plain text, for tests and labels. */
export const plainText = (words: Words): string => piecesOf(words).map((piece) => piece.text).join("");

const words = (key: MessageKey, values: Readonly<Record<string, Value>> = {}, params: Readonly<Record<string, string | number>> = {}): Words => {
  // `t` fills the plain numbers; the values' holes stay for `piecesOf`.
  const holes = Object.fromEntries(Object.keys(values).map((name) => [name, `{${name}}`]));
  return { template: t(key, { ...params, ...holes }), values };
};

// ---------- step 2: the read-back ----------

/** One line of the read-back: its outcome's icon and its words, with a faint note after them. */
export type ReadbackLine = { readonly id: string; readonly outcome: "ok" | "warn" | "fail"; readonly words: Words; readonly note: string | null };

const verbKey = {
  BROWSE_PROJECTS: "trackers.jira.connect.readback.verb.browse",
  CREATE_ISSUES: "trackers.jira.connect.readback.verb.create",
  EDIT_ISSUES: "trackers.jira.connect.readback.verb.edit",
  TRANSITION_ISSUES: "trackers.jira.connect.readback.verb.transition",
  ADD_COMMENTS: "trackers.jira.connect.readback.verb.comment",
} as const satisfies Record<JiraPermission, MessageKey>;

const permissionKey = {
  BROWSE_PROJECTS: "trackers.jira.connect.readback.permission.browse",
  CREATE_ISSUES: "trackers.jira.connect.readback.permission.create",
  EDIT_ISSUES: "trackers.jira.connect.readback.permission.edit",
  TRANSITION_ISSUES: "trackers.jira.connect.readback.permission.transition",
  ADD_COMMENTS: "trackers.jira.connect.readback.permission.comment",
} as const satisfies Record<JiraPermission, MessageKey>;

/** The scope that reads workflows, as Jira names it (choice 5). */
export const WORKFLOW_SCOPE = "read:workflow:jira";

/**
 * Step 2's four checks as lines (jira-connect.md, "What ostra read back"): who it signs in as (a
 * service account, or a person's account in red), the projects it sees (none in red), its
 * permissions in each (one red-icon line per project that's short), and whether it reads their
 * workflows. With no project seen, there's nothing to check permissions or workflows in.
 */
export const readbackLines = (checks: JiraChecks): readonly ReadbackLine[] => {
  const lines: ReadbackLine[] = [];
  const { account, projects, permissions, workflows } = checks;
  switch (account.outcome) {
    case "ok":
      lines.push({ id: "account", outcome: "ok", words: words("trackers.jira.connect.readback.signsInAs", { name: mono(account.name) }), note: t("trackers.jira.connect.readback.serviceAccount") });
      break;
    case "warn":
      lines.push({ id: "account", outcome: "warn", words: words("trackers.jira.connect.readback.signsInAs", { name: mono(account.name) }), note: t("trackers.jira.connect.readback.unknownAccount") });
      break;
    case "fail":
      lines.push({ id: "account", outcome: "fail", words: words("trackers.jira.connect.readback.person"), note: null });
      break;
    default:
      return account.outcome satisfies never;
  }
  const keys = projects.projects.map((project) => project.key);
  if (projects.outcome === "fail" || keys.length === 0) {
    lines.push({ id: "projects", outcome: "fail", words: words("trackers.jira.connect.readback.seesNone"), note: null });
    return lines;
  }
  lines.push({
    id: "projects",
    outcome: "ok",
    words: words(keys.length === 1 ? "trackers.jira.connect.readback.sees.one" : "trackers.jira.connect.readback.sees.other", { keys: { kind: "list", items: keys, join: "comma", look: "mono" } }, { n: keys.length }),
    note: null,
  });
  const short = permissions.projects.filter((project) => project.missing.length > 0);
  if (short.length === 0) {
    const only = keys[0];
    lines.push({
      id: "permissions",
      outcome: "ok",
      words: keys.length === 1 && only !== undefined ? words("trackers.jira.connect.readback.canOne", { key: mono(only) }) : words("trackers.jira.connect.readback.can", {}, { n: keys.length }),
      note: null,
    });
  } else {
    for (const project of short) {
      lines.push({
        id: `permissions-${project.key}`,
        outcome: "warn",
        words: words("trackers.jira.connect.readback.cannot", {
          verbs: { kind: "list", items: project.missing.map((permission) => t(verbKey[permission])), join: "or", look: "plain" },
          key: mono(project.key),
          permissions: { kind: "list", items: project.missing.map((permission) => t(permissionKey[permission])), join: "and", look: "strong" },
        }),
        note: null,
      });
    }
  }
  if (workflows.outcome === "ok") {
    lines.push({ id: "workflows", outcome: "ok", words: words("trackers.jira.connect.readback.workflows"), note: null });
  } else if (!workflows.readable) {
    lines.push({ id: "workflows", outcome: "warn", words: words("trackers.jira.connect.readback.noWorkflowScope", { scope: mono(WORKFLOW_SCOPE) }), note: null });
  } else {
    lines.push({
      id: "workflows",
      outcome: "warn",
      words: words("trackers.jira.connect.readback.noWorkflows", { keys: { kind: "list", items: workflows.unreadable.map((project) => project.key), join: "and", look: "mono" } }),
      note: null,
    });
  }
  return lines;
};

/** Jira refusing the token itself (401 or 403), or not answering: the one red line instead of the four. */
export const readbackFailure = (readBack: Exclude<JiraReadBack, JiraChecks>): ReadbackLine => {
  switch (readBack.kind) {
    case "refused":
      return {
        id: "refused",
        outcome: "fail",
        words: words("trackers.jira.connect.readback.refused", { status: mono(readBack.status === 401 ? t("trackers.jira.connect.readback.status401") : t("trackers.jira.connect.readback.status403")) }),
        note: null,
      };
    case "unreachable":
      return {
        id: "unreachable",
        outcome: "fail",
        words: readBack.status === null ? words("trackers.jira.connect.readback.unreachable") : words("trackers.jira.connect.readback.unreachableStatus", { status: mono(String(readBack.status)) }),
        note: null,
      };
    default:
      return readBack satisfies never;
  }
};

/** What step 2's buttons offer after a check: save it, save it with warnings, or check it again. */
export type TokenAction = "check" | "save" | "save-anyway";

/** `pass` saves, `warnings` saves anyway, a `fail` or a refusal only checks again (nothing is saved until it passes). */
export const tokenAction = (verdict: JiraVerdict | null): TokenAction => (verdict === "pass" ? "save" : verdict === "warnings" ? "save-anyway" : "check");

/**
 * The help beside step 2's buttons: before a check, what Check does; after a pass, where it goes;
 * with warnings, the projects that wait on a permission; after a failure, that nothing's saved.
 */
export const tokenHelp = (readBack: JiraReadBack | null, verdict: JiraVerdict | null): string => {
  if (readBack === null) return t("trackers.jira.connect.step2.checkHelp");
  if (verdict === "pass") return t("trackers.jira.connect.step2.savedHelp");
  if (verdict === "warnings" && readBack.kind === "checked") {
    const waiting = readBack.permissions.projects.filter((project) => project.missing.includes("TRANSITION_ISSUES")).map((project) => project.key);
    return waiting.length === 0 ? t("trackers.jira.connect.step2.savedHelp") : t("trackers.jira.connect.step2.attachLater", { keys: listFormat("and").format(waiting) });
  }
  return t("trackers.jira.connect.step2.failedHelp");
};

// ---------- the token's date ----------

const DAY_MS = 86_400_000;

/** A day as the targets write it, in UTC (the token's date is a calendar day): `14 Sep 2027`. */
export const formatExpiry = (at: number): string =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(at).replace("Sept", "Sep");

/** `2026-11-24`: tomorrow in UTC, the first day a token's date may be (a date on or before today is refused). */
export const firstExpiryDay = (now: number): string => new Date((Math.floor(now / DAY_MS) + 1) * DAY_MS).toISOString().slice(0, 10);

/**
 * Step 2's done line (jira-connect.md): who the service account is, what it sees, and the token's
 * date; and, from 14 days before that date (F-008/c8), the warning under it, red on its icon only.
 */
export const tokenDoneWords = (detail: Pick<JiraDetail, "signsInAs" | "tokenExpiresAt"> & { readonly jira: Pick<JiraDetail["jira"], "reach"> }): Words => {
  const n = detail.jira.reach?.projects.length ?? 0;
  return words(
    "trackers.jira.connect.step2.done",
    { name: mono(detail.signsInAs ?? t("trackers.jira.connect.step2.theAccount")) },
    { projects: t(n === 1 ? "trackers.jira.connect.step2.projects.one" : "trackers.jira.connect.step2.projects.other", { n }), date: detail.tokenExpiresAt === null ? "–" : formatExpiry(detail.tokenExpiresAt) },
  );
};

/** The phone's one line under a done step 2: `ostra-bot sees 3 projects`. */
export const tokenDoneShort = (detail: Pick<JiraDetail, "signsInAs"> & { readonly jira: Pick<JiraDetail["jira"], "reach"> }): Words => {
  const n = detail.jira.reach?.projects.length ?? 0;
  return words(
    "trackers.jira.connect.step2.doneShort",
    { name: mono(detail.signsInAs ?? t("trackers.jira.connect.step2.theAccount")) },
    { projects: t(n === 1 ? "trackers.jira.connect.step2.projects.one" : "trackers.jira.connect.step2.projects.other", { n }) },
  );
};

/** The warning on step 2's done line while the token's date is 14 days away or less (F-008/c8); `null` otherwise. */
export const expiryWarning = (detail: Pick<JiraDetail, "tokenExpiry" | "tokenExpiresAt">): string | null => {
  const expiry = detail.tokenExpiry;
  if (expiry?.state !== "expires-soon" || detail.tokenExpiresAt === null) return null;
  const { days } = expiry;
  const date = formatExpiry(detail.tokenExpiresAt);
  return days === 1 ? t("trackers.jira.connect.step2.expiresTomorrow", { date }) : t("trackers.jira.connect.step2.expiresSoon", { days, date });
};

// ---------- step 3, and the panel ----------

const eventKey = {
  "jira:issue_created": "trackers.jira.connect.event.issueCreated",
  "jira:issue_updated": "trackers.jira.connect.event.issueUpdated",
  "jira:issue_deleted": "trackers.jira.connect.event.issueDeleted",
  comment_created: "trackers.jira.connect.event.commentCreated",
  comment_updated: "trackers.jira.connect.event.commentUpdated",
  comment_deleted: "trackers.jira.connect.event.commentDeleted",
} as const satisfies Record<string, MessageKey>;

const isEvent = (event: string): event is keyof typeof eventKey => Object.hasOwn(eventKey, event);

/** An admin webhook's event as Jira's WebHooks page names it: `jira:issue_created` is `Issue created`. */
export const eventWord = (event: string): string => (isEvent(event) ? t(eventKey[event]) : event);

const scopeKey = {
  "read:jira-work": "trackers.jira.connect.panel.scope.readWork",
  "write:jira-work": "trackers.jira.connect.panel.scope.writeWork",
  "read:jira-user": "trackers.jira.connect.panel.scope.readUser",
  "read:workflow:jira": "trackers.jira.connect.panel.scope.readWorkflow",
} as const satisfies Record<JiraDetail["jira"]["neededScopes"][number], MessageKey>;

/** What each scope is for, in the panel's "The token needs". */
export const scopeWord = (scope: JiraDetail["jira"]["neededScopes"][number]): string => t(scopeKey[scope]);

const problemKey = {
  "invalid-url": "trackers.jira.connect.addressProblem.invalidUrl",
  "not-https": "trackers.jira.connect.addressProblem.notHttps",
  loopback: "trackers.jira.connect.addressProblem.loopback",
  "private-network": "trackers.jira.connect.addressProblem.privateNetwork",
  "single-label-host": "trackers.jira.connect.addressProblem.singleLabelHost",
  "local-suffix": "trackers.jira.connect.addressProblem.localSuffix",
  "linear-host": "trackers.jira.connect.addressProblem.linearHost",
} as const satisfies Record<JiraAddressProblem, MessageKey>;

/** Why this server's address isn't public, in Linear's words with Jira for Linear (`linear.addressProblem.*`). */
export const addressProblemWord = (problem: JiraAddressProblem): string => t(problemKey[problem]);

/** The polling step's first sentence, before its `--text` clause: why there's no webhook, and how often ostra asks. */
export const pollingWhy = (reason: JiraAddressProblem | null, seconds: number): string =>
  reason === null ? t("trackers.jira.connect.polling.whyNoReason", { seconds }) : t("trackers.jira.connect.polling.why", { reason: addressProblemWord(reason), seconds });

/** The wait row's hint: change any ticket in the first project it sees, so Jira sends a delivery. */
export const waitingHint = (keys: readonly string[]): string => {
  const first = keys[0];
  return first === undefined ? t("trackers.jira.connect.step3.waitingHintAny") : t("trackers.jira.connect.step3.waitingHint", { key: first });
};

/** `14:06`: when a delivery with a wrong signature came. */
export const clockOf = (at: number): string => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
