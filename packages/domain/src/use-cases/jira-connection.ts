import { randomBytes } from "node:crypto";

import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretRef } from "@ostra/adapter-sdk";
import { Prisma } from "@ostra/db";
import type { Db, Tx } from "@ostra/db";
import { connectionIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import { trackerConnectionLifecycleOf, transitionTrackerConnection } from "../lifecycles/m11-trackers.ts";
import type { AuditInput, Ports } from "../ports.ts";
import { pendingAppIdOf } from "../tickets/contracts.ts";
import type { UseCaseResult } from "./common.ts";
import type { LinearAddressProblem } from "./linear-connection.ts";
import {
  connectionNameSchema,
  defaultConnectionName,
  emitConnectionChangedInTx,
  failConnection,
  freeConnectionName,
  isPlaceholderConnectionName,
  jiraProjectPermissions,
  nameTakenBy,
  parseTrackerAccessCheck,
  resumeBoardsInTx,
  revokeConnectionInTx,
  siteTakenBy,
  trackerAccessCheckSchema,
  trackerAdminOnly,
} from "./tracker-connections.ts";
import type { ConnectionHolder, JiraProjectPermission, ResumeBoardsResult, TrackerAccessCheck } from "./tracker-connections.ts";

// Milestone 11, ticket 06 (F-008, F-152; ADR 0047, ADR 0071; spec sections 4 and 5.4;
// `brand/app-targets/m11-trackers/jira-connect.md`): an organization admin connects one client's
// Jira Cloud site in three checked steps, and changes it once connected.
// 1. `findJiraSite`: the site's cloud ID from its public tenant info; a Data Center address, a site
//    no Jira Cloud answers at, and a site another connection of the organization holds are refused.
// 2. `checkJiraToken` reads back what the service account's scoped token is and reaches, storing
//    nothing; `saveJiraToken` reads it back again and stores it only after a pass or warnings.
// 3. `jiraWebhookOf` makes the webhook's secret once, and shows it until the first signed delivery,
//    which activates the connection (`activateOnFirstDelivery`, called by core); or
//    `finishJiraPolling` activates it at once, polling, with no secret.
// Then: `rotateJiraSecret`, `replaceJiraToken`, `recheckJiraToken`, and `tokenExpiryState`; the
// changes every kind shares (rename, disconnect, fail) are in `tracker-connections.ts` and
// `tracker-connection-changes.ts`.
//
// The token is passed to the kit and to the secret store, and to nothing else: never a column, a
// returned value, an audit entry, an error, a log line, or a variable that outlives the call. Jira's
// answers carry IDs, names, keys and status codes only (the kit never reads an error body).

// ---------- the port: Jira's side, as the use cases call it ----------

/**
 * What step 1 finds at a site name (the kit's own answer, ticket 04): `found` with the cloud ID,
 * the host and a title from the site's name (`acme-corp` is `Acme Corp`); `not-found` (`host: null`
 * when the input names no host); `data-center` (Jira Server or Data Center, or a host that isn't an
 * `atlassian.net` one); `unreachable`.
 */
export type JiraSiteLookup =
  | { readonly kind: "found"; readonly cloudId: string; readonly host: string; readonly title: string }
  | { readonly kind: "not-found"; readonly host: string | null }
  | { readonly kind: "data-center"; readonly host: string }
  | { readonly kind: "unreachable"; readonly host: string };

/** The scopes the service account's scoped token needs (choice 5): the fourth reads workflows. */
export const jiraTokenScopes = ["read:jira-work", "write:jira-work", "read:jira-user", "read:workflow:jira"] as const;
export type JiraTokenScope = (typeof jiraTokenScopes)[number];

/** A project the token sees: Jira's ID, key and name. */
export type JiraProjectRef = { readonly id: string; readonly key: string; readonly name: string };

/** `/myself`: `ok` for a service account (`accountType` `app`), `fail` for a person's, `warn` when Jira doesn't say. */
export type JiraAccountCheck = { readonly outcome: "ok" | "warn" | "fail"; readonly accountId: string; readonly name: string; readonly accountType: string | null };

/** The projects it sees: `fail` when none. */
export type JiraProjectsCheck = { readonly outcome: "ok" | "fail"; readonly projects: readonly JiraProjectRef[] };

/** Every project it sees, with the ones of the five permissions it lacks there: `warn` when any is short. */
export type JiraPermissionsCheck = {
  readonly outcome: "ok" | "warn";
  readonly projects: readonly (JiraProjectRef & { readonly missing: readonly JiraProjectPermission[] })[];
};

/** Whether it reads the projects' workflows: `warn`, naming the projects it can't, when it doesn't. */
export type JiraWorkflowsCheck = { readonly outcome: "ok" | "warn"; readonly readable: boolean; readonly unreadable: readonly JiraProjectRef[] };

/** A scope as the read-back found it: confirmed by a read, refused where that read was, or unchecked (`write:jira-work`). */
export type JiraScopeCheck = { readonly scope: JiraTokenScope; readonly state: "confirmed" | "refused" | "unchecked" };

/** Step 2's four checks and the scopes, as the kit read them back. */
export type JiraTokenChecks = {
  readonly kind: "checked";
  readonly account: JiraAccountCheck;
  readonly projects: JiraProjectsCheck;
  readonly permissions: JiraPermissionsCheck;
  readonly workflows: JiraWorkflowsCheck;
  readonly scopes: readonly JiraScopeCheck[];
};

/**
 * What step 2 reads back: the checks; `refused` when Jira refuses the token itself (401 or 403 on
 * `/myself`); `unreachable` when Jira can't be reached or answers with a failure.
 */
export type JiraTokenReadBack = JiraTokenChecks | { readonly kind: "refused"; readonly status: 401 | 403 } | { readonly kind: "unreachable"; readonly status: number | null };

/**
 * The calls to Jira the connect steps make (spec section 5.3, ticket 04's `jiraConnect`), injected
 * as `LinearAppKit` is: the API's `services/jira-connect.ts` (ticket 09) binds them to
 * `OSTRA_JIRA_API_URL`, `fetch` and a timeout, and a test passes the fake kit
 * (`@ostra/domain/testing`'s `createFakeJiraConnectKit`).
 */
export type JiraConnectKit = {
  /** Step 1: a site name, host or pasted URL. Needs no credential. */
  readonly findSite: (site: string) => Promise<JiraSiteLookup>;
  /** Step 2: read-only; the token goes in one header of each call and nowhere else. */
  readonly checkToken: (input: { readonly cloudId: string; readonly email: string; readonly token: string }) => Promise<JiraTokenReadBack>;
  /** The scopes the token needs, for step 2's chips. */
  readonly scopes: readonly JiraTokenScope[];
  /** The six events the admin webhook subscribes to, for step 3. */
  readonly webhookEvents: readonly string[];
  /** `project in (PROJ, SHOP)` for the projects the token sees, or `null` for none. */
  readonly suggestedJql: (projectKeys: readonly string[]) => string | null;
  /** Jira's WebHooks page on a site (Settings › System › WebHooks), or `null` for a host that isn't one. */
  readonly webhooksPage: (host: string) => string | null;
};

/** A read-back as step 2 draws it: `pass` (four green lines), `warnings` (saves), `fail` (refused). */
export type JiraTokenVerdict = "pass" | "warnings" | "fail";

/** The verdict of the four checks: any `fail` refuses the token; a `warn` only warns (jira-connect.md). */
export const jiraTokenVerdict = (checks: JiraTokenChecks): JiraTokenVerdict => {
  if (checks.account.outcome === "fail" || checks.projects.outcome === "fail") {
    return "fail";
  }
  return checks.account.outcome === "warn" || checks.permissions.outcome === "warn" || checks.workflows.outcome === "warn" ? "warnings" : "pass";
};

/**
 * `Connection.accessCheck` from a read-back: each project with the permissions it holds (the kit
 * answers the ones it lacks), and whether workflows read. A project Jira named past the format's
 * limits is left out rather than stored wrong.
 */
export const accessCheckOf = (checks: JiraTokenChecks): TrackerAccessCheck => ({
  projects: checks.permissions.projects
    .flatMap((project) => {
      const read = trackerAccessCheckSchema.shape.projects.element.safeParse({
        id: project.id,
        key: project.key,
        name: project.name,
        permissions: jiraProjectPermissions.filter((permission) => !project.missing.includes(permission)),
      });
      return read.success ? [read.data] : [];
    })
    .slice(0, 2000),
  workflowsReadable: checks.workflows.readable,
});

// ---------- the addresses and words ----------

/** Where Jira's admin webhook delivers this connection's events (spec section 4, "An event"). */
export const jiraWebhookUrl = (corePublicUrl: string, connectionId: ConnectionId): string => `${corePublicUrl.replace(/\/+$/, "")}/webhooks/jira/${connectionId}`;

/**
 * The site's name from what an admin typed or pasted (step 1): `globex`, `globex.atlassian.net` and
 * `https://globex.atlassian.net/jira/software/projects` are all `globex`. Another host is kept
 * whole, so the kit can say it's a Data Center address; text that names no host is kept as typed.
 */
export const jiraSiteNameOf = (input: string): string => {
  const text = input.trim().toLowerCase();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
  const host = URL.canParse(withScheme) ? new URL(withScheme).hostname.replace(/\.$/, "") : text;
  const cloud = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.atlassian\.net$/.exec(host);
  return cloud?.[1] ?? (host === "" ? text : host);
};

/** The webhook secret ostra makes: 32 random bytes, base64url (choice 15). */
export const newJiraWebhookSecret = (): string => randomBytes(32).toString("base64url");

/** How many days ahead the token's date is warned of (a working value, spec section 5.4). */
export const TOKEN_EXPIRY_WARNING_DAYS = 14;

/** The token's date as the panel and the expiry job read it. */
export type TokenExpiryState = { readonly state: "healthy" } | { readonly state: "expires-soon"; readonly days: number } | { readonly state: "expired" };

const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` date, or a `@db.Date` column's value, as its day number since the epoch (UTC). */
const dayNumberOf = (date: Date | string): number | null => {
  const at = typeof date === "string" ? Date.parse(`${date}T00:00:00Z`) : date.getTime();
  return Number.isNaN(at) ? null : Math.floor(at / DAY_MS);
};

/**
 * The token's date against today (UTC): `expired` on the day and after, `expires-soon` with the
 * days left from 14 days before it, `healthy` otherwise or without a date (spec section 4, "The
 * token's date"; F-008/c8).
 */
export const tokenExpiryState = (connection: { readonly tokenExpiresOn: Date | string | null }, now: number): TokenExpiryState => {
  const expires = connection.tokenExpiresOn === null ? null : dayNumberOf(connection.tokenExpiresOn);
  if (expires === null) {
    return { state: "healthy" };
  }
  const days = expires - Math.floor(now / DAY_MS);
  if (days <= 0) {
    return { state: "expired" };
  }
  return days <= TOKEN_EXPIRY_WARNING_DAYS ? { state: "expires-soon", days } : { state: "healthy" };
};

// ---------- the deps, the rows ----------

export type JiraConnectionDeps = Pick<Ports, "audit" | "notices" | "clock"> & {
  readonly db: Db;
  readonly scope: MemberScope;
  readonly jira: JiraConnectKit;
  readonly adapters: Pick<Ports["adapters"], "secretStore">;
  /** Core's public address, or `null` when it fails the pre-check: the connection polls. */
  readonly corePublicUrl: string | null;
  /** Why `corePublicUrl` failed the pre-check (Linear's reasons, which are Jira's too); `null` when it passed. */
  readonly corePublicUrlProblem?: LinearAddressProblem | null;
};

/** The secret store purposes of a Jira connection's two secrets. */
export const jiraSecretPurposes = { token: "jira-token", webhookSecret: "jira-webhook-secret" } as const;

type JiraRow = NonNullable<Awaited<ReturnType<typeof jiraRowOf>>>;

/** One of the organization's Jira connections that isn't revoked, by its ID. */
const jiraRowOf = (db: Pick<Tx, "connection">, organizationId: OrganizationId, connectionId: ConnectionId) =>
  db.connection.findFirst({ where: { id: connectionId, organizationId, kind: "jira", state: { not: "revoked" } } });

const NO_CONNECTION = "No such Jira connection";

const memberActor = (scope: MemberScope): AuditInput["actor"] => ({ kind: "member", id: scope.memberId });

/** Reads a secret reference column; `null` when there is none. */
const refOf = (value: string | null): SecretRef | null => {
  const parsed = secretRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Deletes secrets the row no longer names. A value already gone is not an error. */
const dropSecrets = async (deps: Pick<JiraConnectionDeps, "adapters">, organizationId: OrganizationId, refs: readonly (string | null)[]): Promise<void> => {
  for (const value of refs) {
    const ref = refOf(value);
    if (ref !== null) {
      await deps.adapters.secretStore.delete(organizationId, ref);
    }
  }
};

/** Puts a value in the secret store under a Jira purpose. The error names the purpose and the store's code, never the value. */
const putSecret = async (deps: Pick<JiraConnectionDeps, "adapters">, organizationId: OrganizationId, purpose: (typeof jiraSecretPurposes)[keyof typeof jiraSecretPurposes], value: string): Promise<SecretRef> => {
  const stored = await deps.adapters.secretStore.put({ organizationId, purpose }, value);
  if (!stored.ok) {
    throw new Error(`the secret store refused the ${purpose}: ${stored.error.code}`);
  }
  return stored.value;
};

const isUniqueViolation = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

const modeOf = (deps: Pick<JiraConnectionDeps, "corePublicUrl" | "corePublicUrlProblem">): { readonly mode: "webhooks" | "polling"; readonly modeReason: LinearAddressProblem | null } =>
  deps.corePublicUrl === null ? { mode: "polling", modeReason: deps.corePublicUrlProblem ?? null } : { mode: "webhooks", modeReason: null };

/**
 * Makes a connection `active`, in the caller's transaction, by its lifecycle (`pending` or `failed`
 * to `active`): `activatedAt`, `failedReason` cleared and `extra`, then the paused boards of a
 * revoked connection of the same site move to it (`resumeBoardsInTx`), and `tracker.connected` is
 * audited. `null` when the row wasn't in a state that activates, or another writer moved it first.
 */
const activateJiraInTx = async (
  deps: { readonly tx: Tx } & Pick<Ports, "audit" | "notices" | "clock">,
  row: JiraRow,
  input: { readonly actor: AuditInput["actor"]; readonly extra?: Prisma.ConnectionUpdateManyMutationInput; readonly mode: "webhooks" | "polling" },
): Promise<ResumeBoardsResult | null> => {
  const { tx } = deps;
  const now = deps.clock.now();
  const moved = transitionTrackerConnection(trackerConnectionLifecycleOf(row), { type: "activate", at: now });
  if (!moved.ok) {
    return null;
  }
  const updated = await tx.connection.updateMany({
    where: { id: row.id, organizationId: row.organizationId, state: row.state },
    data: { ...input.extra, state: "active", failedReason: null, activatedAt: new Date(now) },
  });
  if (updated.count !== 1) {
    return null;
  }
  const organizationId = organizationIdSchema.parse(row.organizationId);
  const connectionId = connectionIdSchema.parse(row.id);
  const resumed = await resumeBoardsInTx({ tx, audit: deps.audit, notices: deps.notices }, { organizationId, connectionId, actor: input.actor });
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: null,
    actor: input.actor,
    action: "tracker.connected",
    entity: "connection",
    entityId: connectionId,
    data: { kind: "jira", mode: input.mode, resumedBoards: resumed.boards },
  });
  await emitConnectionChangedInTx({ tx, notices: deps.notices }, organizationId, connectionId);
  return resumed;
};

type Failure<E extends string> = { readonly ok: false; readonly error: E; readonly message: string };

const refuse = <E extends string>(error: E, message: string): Failure<E> => ({ ok: false, error, message });

// ---------- start ----------

export const startJiraConnectionInputSchema = z.strictObject({
  /** The connection's name; `Jira` (then `Jira 2`…) until step 1 names it after the site. */
  name: connectionNameSchema.optional(),
});
export type StartJiraConnectionInput = z.infer<typeof startJiraConnectionInputSchema>;

export type StartJiraConnectionResult = UseCaseResult<
  { readonly connectionId: ConnectionId; readonly name: string; readonly mode: "webhooks" | "polling"; readonly modeReason: LinearAddressProblem | null },
  "forbidden" | "invalid-name" | "name-taken"
>;

/**
 * "Connect a tracker" › Jira (`trackers.create({ kind: "jira", name })`): a new named `pending`
 * connection, `appId` `pending:<id>`, in webhooks or polling as the install's address allows.
 * Audited `tracker.connection-created`.
 */
export const startJiraConnection = async (
  deps: Pick<JiraConnectionDeps, "db" | "scope" | "audit" | "notices" | "corePublicUrl" | "corePublicUrlProblem">,
  input: StartJiraConnectionInput = {},
): Promise<StartJiraConnectionResult> => {
  const denied = trackerAdminOnly(deps.scope);
  if (denied !== null) return denied;
  const organizationId = deps.scope.organizationId;
  const named = input.name === undefined ? null : connectionNameSchema.safeParse(input.name);
  if (named?.success === false) {
    return refuse("invalid-name", "A connection's name is 1 to 60 characters");
  }
  const { mode, modeReason } = modeOf(deps);
  return deps.db.$transaction(async (tx): Promise<StartJiraConnectionResult> => {
    const name = named?.data ?? (await freeConnectionName(tx, organizationId, defaultConnectionName("jira", null)));
    const holder = await nameTakenBy(tx, organizationId, name);
    if (holder !== null) {
      return refuse("name-taken", `Another connection is already called ${holder.name}. Pick another name`);
    }
    const created = await tx.connection.create({
      data: {
        organizationId,
        kind: "jira",
        name,
        // Unique under (organization, kind, app) until the row's own ID replaces it, a moment later.
        appId: pendingAppIdOf(randomBytes(16).toString("hex")),
        state: "pending",
        webhookMode: mode,
        credentialKind: "service_account_token",
        createdByMemberId: deps.scope.memberId,
      },
      select: { id: true },
    });
    const connectionId = connectionIdSchema.parse(created.id);
    await tx.connection.update({ where: { id: created.id }, data: { appId: pendingAppIdOf(created.id) } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: memberActor(deps.scope),
      action: "tracker.connection-created",
      entity: "connection",
      entityId: connectionId,
      data: { kind: "jira", mode },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "connection", entityId: connectionId });
    return { ok: true, connectionId, name, mode, modeReason };
  });
};

// ---------- step 1: the site ----------

export const findJiraSiteInputSchema = z.strictObject({
  connectionId: connectionIdSchema,
  /** The site's name, its host, or a URL pasted from Jira: trimmed to the name. */
  site: z.string().trim().min(1).max(512),
  /** What boards and tickets call it; without it, a placeholder name becomes the site's (`Globex Jira`). */
  name: connectionNameSchema.optional(),
});
export type FindJiraSiteInput = z.infer<typeof findJiraSiteInputSchema>;

export type FindJiraSiteResult =
  | {
      readonly ok: true;
      readonly connectionId: ConnectionId;
      readonly cloudId: string;
      readonly host: string;
      readonly title: string;
      readonly name: string;
      /** Where the admin makes the webhook (step 3's link). */
      readonly webhooksPage: string | null;
      /** A changed site cleared steps 2 and 3: the token and the secret were for the other one. */
      readonly cleared: boolean;
    }
  | Failure<"forbidden" | "no-connection" | "not-pending" | "invalid-name" | "name-taken" | "not-found" | "data-center" | "unreachable">
  /** Another connection of the organization holds the site: the panel names it, with `Open it →`. */
  | (Failure<"site-taken"> & { readonly holder: ConnectionHolder });

const siteTaken = (host: string, holder: ConnectionHolder): Failure<"site-taken"> & { readonly holder: ConnectionHolder } => ({
  ok: false,
  error: "site-taken",
  message: `${host} is already connected, as ${holder.name}.`,
  holder,
});

/** What steps 2 and 3 kept, cleared when step 1 changes the site. */
const stepsTwoAndThree = {
  accessTokenSecretRef: null,
  webhookSecretSecretRef: null,
  accountEmail: null,
  tokenExpiresOn: null,
  accessCheck: Prisma.DbNull,
  accessCheckedAt: null,
  scopes: [],
  appUserId: null,
  appUserName: null,
  firstDeliveryAt: null,
  badSignatureAt: null,
} as const satisfies Prisma.ConnectionUpdateManyMutationInput;

/**
 * Step 1 (F-008/c1): finds the site's cloud ID through the kit, refuses a site no Jira Cloud answers
 * at, a Data Center address, and a site another connection of the organization holds (ADR 0071,
 * naming it), and keeps the cloud ID as the `appId` and the workspace columns. A different site than
 * the one found before clears steps 2 and 3. Audited `tracker.site-found`.
 */
export const findJiraSite = async (deps: JiraConnectionDeps, input: FindJiraSiteInput): Promise<FindJiraSiteResult> => {
  const denied = trackerAdminOnly(deps.scope);
  if (denied !== null) return denied;
  const organizationId = deps.scope.organizationId;
  const named = input.name === undefined ? null : connectionNameSchema.safeParse(input.name);
  if (named?.success === false) {
    return refuse("invalid-name", "A connection's name is 1 to 60 characters");
  }
  const before = await jiraRowOf(deps.db, organizationId, input.connectionId);
  if (before === null) {
    return refuse("no-connection", NO_CONNECTION);
  }
  if (before.state !== "pending") {
    return refuse("not-pending", "This connection's site is set: disconnect it to connect another site");
  }

  const found = await deps.jira.findSite(jiraSiteNameOf(input.site));
  switch (found.kind) {
    case "found":
      break;
    case "not-found":
      return refuse(
        "not-found",
        found.host === null ? "That isn't a Jira Cloud site's name." : `No Jira Cloud site answers at ${found.host}. Check the name in the browser's address bar when you're in Jira.`,
      );
    case "data-center":
      return refuse("data-center", "That's a Jira Data Center address. ostra connects to Jira Cloud only.");
    case "unreachable":
      return refuse("unreachable", `${found.host} didn't answer. Try again in a moment.`);
    default:
      return found satisfies never;
  }

  let cleared: readonly (string | null)[] = [];
  let result: FindJiraSiteResult;
  try {
    result = await deps.db.$transaction(async (tx): Promise<FindJiraSiteResult> => {
      const row = await jiraRowOf(tx, organizationId, input.connectionId);
      if (row?.state !== "pending") {
        return row === null ? refuse("no-connection", NO_CONNECTION) : refuse("not-pending", "This connection's site is set: disconnect it to connect another site");
      }
      const holder = await siteTakenBy(tx, organizationId, "jira", found.cloudId, input.connectionId);
      if (holder !== null) {
        return siteTaken(found.host, holder);
      }
      let name: string;
      if (named !== null) {
        const taken = await nameTakenBy(tx, organizationId, named.data, input.connectionId);
        if (taken !== null) {
          return refuse("name-taken", `Another connection is already called ${taken.name}. Pick another name`);
        }
        name = named.data;
      } else {
        name = isPlaceholderConnectionName("jira", row.name)
          ? await freeConnectionName(tx, organizationId, defaultConnectionName("jira", found.title), input.connectionId)
          : (row.name ?? defaultConnectionName("jira", found.title));
      }
      const changed = row.externalWorkspaceId !== null && row.externalWorkspaceId !== found.cloudId;
      if (changed) {
        cleared = [row.accessTokenSecretRef, row.webhookSecretSecretRef];
      }
      await tx.connection.update({
        where: { id: row.id },
        data: {
          ...(changed ? stepsTwoAndThree : {}),
          name,
          appId: found.cloudId,
          externalWorkspaceId: found.cloudId,
          externalWorkspaceKey: found.host,
          externalWorkspaceName: found.title,
        },
      });
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId: null,
        actor: memberActor(deps.scope),
        action: "tracker.site-found",
        entity: "connection",
        entityId: input.connectionId,
        data: { kind: "jira", changed },
      });
      await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "connection", entityId: input.connectionId });
      return { ok: true, connectionId: input.connectionId, cloudId: found.cloudId, host: found.host, title: found.title, name, webhooksPage: deps.jira.webhooksPage(found.host), cleared: changed };
    });
  } catch (error) {
    // Another connection took the site between the check and the write: the index refused it.
    if (!isUniqueViolation(error)) throw error;
    const holder = await siteTakenBy(deps.db, organizationId, "jira", found.cloudId, input.connectionId);
    if (holder === null) throw error;
    return siteTaken(found.host, holder);
  }
  await dropSecrets(deps, organizationId, cleared);
  return result;
};

// ---------- step 2: the token ----------

export const jiraTokenInputSchema = z.strictObject({
  connectionId: connectionIdSchema,
  /** The service account's email, the user half of the token's Basic auth. Not a secret. */
  email: z.email().max(320),
  /** The scoped API token. To the kit and the secret store only; never logged, never returned. */
  token: z.string().trim().min(8).max(4096),
  /** The day the token expires, as the admin gave it when making it (Jira's API doesn't say). */
  expiresOn: z.iso.date(),
});
export type JiraTokenInput = z.infer<typeof jiraTokenInputSchema>;

/** A date on or before today can't be a token's expiry: the token would be expired already. */
const expiresTooSoon = (expiresOn: string, now: number): boolean => {
  const day = dayNumberOf(expiresOn);
  return day === null || day <= Math.floor(now / DAY_MS);
};

const PAST_DATE = "That date has passed. Give the date the token expires on, from when you made it.";

export type CheckJiraTokenResult = UseCaseResult<
  { readonly connectionId: ConnectionId; readonly readBack: JiraTokenReadBack; readonly verdict: JiraTokenVerdict | null },
  "forbidden" | "no-connection" | "no-site" | "expired-date"
>;

/**
 * Step 2's `Check the token` (F-008/c1): the read-back with the pasted token, held in memory for
 * the call. Nothing is stored, and nothing is audited, since nothing changes.
 */
export const checkJiraToken = async (deps: JiraConnectionDeps, input: JiraTokenInput): Promise<CheckJiraTokenResult> => {
  const denied = trackerAdminOnly(deps.scope);
  if (denied !== null) return denied;
  const row = await jiraRowOf(deps.db, deps.scope.organizationId, input.connectionId);
  if (row === null) {
    return refuse("no-connection", NO_CONNECTION);
  }
  if (row.externalWorkspaceId === null) {
    return refuse("no-site", "Find the site first");
  }
  if (expiresTooSoon(input.expiresOn, deps.clock.now())) {
    return refuse("expired-date", PAST_DATE);
  }
  const readBack = await deps.jira.checkToken({ cloudId: row.externalWorkspaceId, email: input.email, token: input.token });
  return { ok: true, connectionId: input.connectionId, readBack, verdict: readBack.kind === "checked" ? jiraTokenVerdict(readBack) : null };
};

export type SaveJiraTokenResult =
  | {
      readonly ok: true;
      readonly connectionId: ConnectionId;
      readonly readBack: JiraTokenChecks;
      readonly verdict: Exclude<JiraTokenVerdict, "fail">;
      readonly tokenExpiresOn: string;
      readonly state: "pending" | "active";
    }
  | Failure<"forbidden" | "no-connection" | "no-site" | "not-pending" | "not-connected" | "expired-date" | "unreachable" | "changed">
  /** Jira refused the token itself (401 or 403): the panel says the status code. */
  | (Failure<"token-refused"> & { readonly status: 401 | 403 })
  /** A check failed (a person's account, no project): the panel draws the read-back's red lines. */
  | (Failure<"token-failed"> & { readonly readBack: JiraTokenChecks });

type StoreMode = "save" | "replace";

const verdictWords = { pass: "pass", warnings: "warnings" } as const satisfies Record<Exclude<JiraTokenVerdict, "fail">, string>;

/** Both ways a token is stored: step 2's save (pending) and Replace (active or failed). The read-back always runs first. */
const storeJiraToken = async (deps: JiraConnectionDeps, input: JiraTokenInput, mode: StoreMode): Promise<SaveJiraTokenResult> => {
  const denied = trackerAdminOnly(deps.scope);
  if (denied !== null) return denied;
  const organizationId = deps.scope.organizationId;
  const row = await jiraRowOf(deps.db, organizationId, input.connectionId);
  if (row === null) {
    return refuse("no-connection", NO_CONNECTION);
  }
  if (mode === "save" && row.state !== "pending") {
    return refuse("not-pending", "This connection is connected: replace its token instead");
  }
  if (mode === "replace" && row.state === "pending") {
    return refuse("not-connected", "This connection isn't connected yet: save its token in step 2");
  }
  const cloudId = row.externalWorkspaceId;
  if (cloudId === null) {
    return refuse("no-site", "Find the site first");
  }
  if (expiresTooSoon(input.expiresOn, deps.clock.now())) {
    return refuse("expired-date", PAST_DATE);
  }

  // The read-back first: nothing is stored before it passes, or only warns.
  const readBack = await deps.jira.checkToken({ cloudId, email: input.email, token: input.token });
  switch (readBack.kind) {
    case "checked":
      break;
    case "refused":
      return {
        ok: false,
        error: "token-refused",
        status: readBack.status,
        message: `Jira refused the token: ${String(readBack.status)}. Check the email is the service account's, and that the token isn't expired or revoked.`,
      };
    case "unreachable":
      return refuse("unreachable", readBack.status === null ? "Jira didn't answer. Try again in a moment." : `Jira answered ${String(readBack.status)}. Try again in a moment.`);
    default:
      return readBack satisfies never;
  }
  const verdict = jiraTokenVerdict(readBack);
  if (verdict === "fail") {
    return { ok: false, error: "token-failed", readBack, message: "The token can't be saved: fix what the read-back marks red, then check it again." };
  }

  const tokenRef = await putSecret(deps, organizationId, jiraSecretPurposes.token, input.token);
  const now = deps.clock.now();
  const tokenFields = {
    credentialKind: "service_account_token",
    accessTokenSecretRef: tokenRef,
    accountEmail: input.email,
    tokenExpiresOn: new Date(`${input.expiresOn}T00:00:00Z`),
    accessCheck: accessCheckOf(readBack),
    accessCheckedAt: new Date(now),
    scopes: readBack.scopes.filter((scope) => scope.state === "confirmed").map((scope) => scope.scope),
    appUserId: readBack.account.accountId,
    appUserName: readBack.account.name,
  } as const satisfies Prisma.ConnectionUpdateManyMutationInput;
  const actor = memberActor(deps.scope);
  let outcome: SaveJiraTokenResult;
  try {
    outcome = await deps.db.$transaction(async (tx): Promise<SaveJiraTokenResult> => {
      const current = await jiraRowOf(tx, organizationId, input.connectionId);
      // The row read before the call must still be the one this token is for.
      if (current?.state !== row.state || current.externalWorkspaceId !== cloudId || current.accessTokenSecretRef !== row.accessTokenSecretRef) {
        return refuse("changed", "The connection changed meanwhile. Check the token again.");
      }
      let state: "pending" | "active" = current.state === "pending" ? "pending" : "active";
      if (current.state === "failed") {
        // A new token that reads back fixes a failed connection: active again, its boards attached.
        const activated = await activateJiraInTx({ tx, audit: deps.audit, notices: deps.notices, clock: deps.clock }, current, { actor, extra: tokenFields, mode: current.webhookMode });
        if (activated === null) {
          return refuse("changed", "The connection changed meanwhile. Check the token again.");
        }
        state = "active";
      } else {
        await tx.connection.update({ where: { id: current.id }, data: tokenFields });
      }
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId: null,
        actor,
        action: mode === "save" ? "tracker.token-saved" : "tracker.token-replaced",
        entity: "connection",
        entityId: input.connectionId,
        data: { kind: "jira", verdict: verdictWords[verdict], projects: readBack.projects.projects.length },
      });
      await emitConnectionChangedInTx({ tx, notices: deps.notices }, organizationId, input.connectionId);
      return { ok: true, connectionId: input.connectionId, readBack, verdict, tokenExpiresOn: input.expiresOn, state };
    });
  } catch (error) {
    await deps.adapters.secretStore.delete(organizationId, tokenRef);
    throw error;
  }
  if (!outcome.ok) {
    await deps.adapters.secretStore.delete(organizationId, tokenRef);
    return outcome;
  }
  // The token it replaced goes once the new one stands.
  await dropSecrets(deps, organizationId, [row.accessTokenSecretRef]);
  return outcome;
};

/**
 * Step 2's `Save and continue` (F-008/c1, c2): runs the read-back again with the pasted token,
 * refuses on any `fail` (warnings save), and stores the token in the secret store
 * (`jira-token`), with the email, the date, the read-back (`accessCheck`), the confirmed scopes and
 * the service account (the echo filter). Audited `tracker.token-saved`, with no value.
 */
export const saveJiraToken = (deps: JiraConnectionDeps, input: JiraTokenInput): Promise<SaveJiraTokenResult> => storeJiraToken(deps, input, "save");

/**
 * `Replace` on a connected (or failed) connection (F-008/c8): the read-back runs first, then the
 * new token takes the old one's place, and the old one is deleted. A failed connection is active
 * again. Audited `tracker.token-replaced`.
 */
export const replaceJiraToken = (deps: JiraConnectionDeps, input: JiraTokenInput): Promise<SaveJiraTokenResult> => storeJiraToken(deps, input, "replace");

export const jiraConnectionInputSchema = z.strictObject({ connectionId: connectionIdSchema });
export type JiraConnectionInput = z.infer<typeof jiraConnectionInputSchema>;

export type RecheckJiraTokenResult = UseCaseResult<
  { readonly connectionId: ConnectionId; readonly readBack: JiraTokenReadBack; readonly verdict: JiraTokenVerdict | null; readonly state: "pending" | "active" | "failed" },
  "forbidden" | "no-connection" | "not-ready" | "changed"
>;

/**
 * `Check again` (F-008/c8): the read-back with the saved token, kept as the connection's last
 * (`accessCheck`, the scopes, the service account) and audited `tracker.token-checked`. Jira
 * refusing the saved token fails an active connection (`token-refused`); a token Jira takes again
 * makes a connection that failed for that reason active again. A token past its date stays failed
 * until it's replaced.
 */
export const recheckJiraToken = async (deps: JiraConnectionDeps, input: JiraConnectionInput): Promise<RecheckJiraTokenResult> => {
  const denied = trackerAdminOnly(deps.scope);
  if (denied !== null) return denied;
  const organizationId = deps.scope.organizationId;
  const row = await jiraRowOf(deps.db, organizationId, input.connectionId);
  if (row === null) {
    return refuse("no-connection", NO_CONNECTION);
  }
  const tokenRef = refOf(row.accessTokenSecretRef);
  const cloudId = row.externalWorkspaceId;
  const email = row.accountEmail;
  if (tokenRef === null || cloudId === null || email === null) {
    return refuse("not-ready", "Save a token first");
  }
  const saved = await deps.adapters.secretStore.get(organizationId, tokenRef);
  if (!saved.ok) {
    return refuse("not-ready", "The saved token can't be read: replace it");
  }
  const readBack = await deps.jira.checkToken({ cloudId, email, token: saved.value });
  const verdict = readBack.kind === "checked" ? jiraTokenVerdict(readBack) : null;
  const actor = memberActor(deps.scope);
  return deps.db.$transaction(async (tx): Promise<RecheckJiraTokenResult> => {
    const current = await jiraRowOf(tx, organizationId, input.connectionId);
    if (current?.accessTokenSecretRef !== row.accessTokenSecretRef || current.externalWorkspaceId !== cloudId || current.state === "revoked") {
      return refuse("changed", "The connection changed meanwhile. Check again.");
    }
    let state = current.state;
    if (readBack.kind === "checked") {
      const read = {
        accessCheck: accessCheckOf(readBack),
        accessCheckedAt: new Date(deps.clock.now()),
        scopes: readBack.scopes.filter((scope) => scope.state === "confirmed").map((scope) => scope.scope),
        appUserId: readBack.account.accountId,
        appUserName: readBack.account.name,
      } as const satisfies Prisma.ConnectionUpdateManyMutationInput;
      if (current.state === "failed" && current.failedReason === "token-refused" && verdict !== "fail") {
        if ((await activateJiraInTx({ tx, audit: deps.audit, notices: deps.notices, clock: deps.clock }, current, { actor, extra: read, mode: current.webhookMode })) !== null) {
          state = "active";
        }
      } else {
        await tx.connection.update({ where: { id: current.id }, data: read });
      }
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId: null,
        actor,
        action: "tracker.token-checked",
        entity: "connection",
        entityId: input.connectionId,
        data: { kind: "jira", verdict: verdict ?? "fail" },
      });
      await emitConnectionChangedInTx({ tx, notices: deps.notices }, organizationId, input.connectionId);
    } else if (readBack.kind === "refused" && current.state === "active") {
      if (await failConnection({ tx, audit: deps.audit, notices: deps.notices }, { organizationId, connectionId: input.connectionId, reason: "token-refused", actor })) {
        state = "failed";
      }
    }
    return { ok: true, connectionId: input.connectionId, readBack, verdict, state };
  });
};

// ---------- step 3: the webhook, or polling ----------

/** What step 3 shows: the webhook's values while webhooks reach the install, or polling and why. */
export type JiraWebhookView =
  | {
      readonly mode: "webhooks";
      /** `null` when the install's address stopped passing the pre-check after the connection was made. */
      readonly url: string | null;
      /** The secret ostra made, only until the first signed delivery (choice 15); then `null`, and only Rotate makes a new one. */
      readonly secret: string | null;
      readonly events: readonly string[];
      /** `project in (PROJ, SHOP, OPS)` for the projects the token saw, or `null`. */
      readonly jql: string | null;
      readonly webhooksPage: string | null;
      readonly firstDeliveryAt: number | null;
      readonly badSignatureAt: number | null;
      readonly lastEventAt: number | null;
    }
  | { readonly mode: "polling"; readonly reason: LinearAddressProblem | null };

export type JiraWebhookOfResult = UseCaseResult<{ readonly connectionId: ConnectionId; readonly webhook: JiraWebhookView }, "forbidden" | "no-connection" | "not-ready">;

const timeOf = (value: Date | null): number | null => value?.getTime() ?? null;

/**
 * Step 3 (`trackers.jira.webhook`): the webhook's URL, the six events and the suggested JQL, and the
 * secret: made once while the connection is pending (32 random bytes, base64url, to the secret
 * store as `jira-webhook-secret`), and answered only while no delivery has arrived. An admin's
 * only: a member is refused, so no secret ever reaches one. Making the secret is audited
 * `tracker.secret-made`; showing it is not a change.
 */
export const jiraWebhookOf = async (deps: JiraConnectionDeps, input: JiraConnectionInput): Promise<JiraWebhookOfResult> => {
  const denied = trackerAdminOnly(deps.scope);
  if (denied !== null) return denied;
  const organizationId = deps.scope.organizationId;
  let row = await jiraRowOf(deps.db, organizationId, input.connectionId);
  if (row === null) {
    return refuse("no-connection", NO_CONNECTION);
  }
  if (row.state === "pending" && (row.externalWorkspaceId === null || row.accessTokenSecretRef === null)) {
    return refuse("not-ready", "Find the site and save the token first");
  }
  let mode = row.webhookMode;
  let reason: LinearAddressProblem | null = deps.corePublicUrl === null ? (deps.corePublicUrlProblem ?? null) : null;
  if (row.state === "pending") {
    // While pending, the mode follows the install's address as it is now.
    ({ mode, modeReason: reason } = modeOf(deps));
    if (mode !== row.webhookMode) {
      await deps.db.connection.updateMany({ where: { id: row.id, organizationId, state: "pending" }, data: { webhookMode: mode } });
    }
  }
  const connectionId = input.connectionId;
  if (mode === "polling") {
    return { ok: true, connectionId, webhook: { mode: "polling", reason } };
  }

  if (row.state === "pending" && row.webhookSecretSecretRef === null) {
    const made = await putSecret(deps, organizationId, jiraSecretPurposes.webhookSecret, newJiraWebhookSecret());
    const set = await deps.db.$transaction(async (tx) => {
      const kept = await tx.connection.updateMany({ where: { id: connectionId, organizationId, state: "pending", webhookSecretSecretRef: null }, data: { webhookSecretSecretRef: made } });
      if (kept.count === 1) {
        await deps.audit.recordInTx(tx, {
          organizationId,
          projectId: null,
          actor: memberActor(deps.scope),
          action: "tracker.secret-made",
          entity: "connection",
          entityId: connectionId,
          data: { kind: "jira" },
        });
      }
      return kept.count === 1;
    });
    if (!set) {
      // Another call made it first: that one stands.
      await deps.adapters.secretStore.delete(organizationId, made);
    }
    row = await jiraRowOf(deps.db, organizationId, connectionId);
    if (row === null) {
      return refuse("no-connection", NO_CONNECTION);
    }
  }

  let secret: string | null = null;
  const secretRef = refOf(row.webhookSecretSecretRef);
  if (row.firstDeliveryAt === null && secretRef !== null) {
    const read = await deps.adapters.secretStore.get(organizationId, secretRef);
    secret = read.ok ? read.value : null;
  }
  const keys = (parseTrackerAccessCheck(row.accessCheck)?.projects ?? []).map((project) => project.key);
  return {
    ok: true,
    connectionId,
    webhook: {
      mode: "webhooks",
      url: deps.corePublicUrl === null ? null : jiraWebhookUrl(deps.corePublicUrl, connectionId),
      secret,
      events: deps.jira.webhookEvents,
      jql: deps.jira.suggestedJql(keys),
      webhooksPage: row.externalWorkspaceKey === null ? null : deps.jira.webhooksPage(row.externalWorkspaceKey),
      firstDeliveryAt: timeOf(row.firstDeliveryAt),
      badSignatureAt: timeOf(row.badSignatureAt),
      lastEventAt: timeOf(row.lastEventAt),
    },
  };
};

export type FinishJiraPollingResult = UseCaseResult<
  { readonly connectionId: ConnectionId; readonly mode: "polling"; readonly resumedBoards: number },
  "forbidden" | "no-connection" | "not-pending" | "not-ready" | "changed"
>;

/**
 * Step 3's `Finish` without a public address, or `Use polling instead` (F-008/c1, F-042): the
 * connection is `active` at once, polling, with no secret (one made before is deleted). A revoked
 * connection of the same site gives it its paused boards in the same transaction. Audited
 * `tracker.connected`.
 */
export const finishJiraPolling = async (deps: JiraConnectionDeps, input: JiraConnectionInput): Promise<FinishJiraPollingResult> => {
  const denied = trackerAdminOnly(deps.scope);
  if (denied !== null) return denied;
  const organizationId = deps.scope.organizationId;
  const row = await jiraRowOf(deps.db, organizationId, input.connectionId);
  if (row === null) {
    return refuse("no-connection", NO_CONNECTION);
  }
  if (row.state !== "pending") {
    return refuse("not-pending", "This connection is already connected");
  }
  if (row.externalWorkspaceId === null || row.accessTokenSecretRef === null) {
    return refuse("not-ready", "Find the site and save the token first");
  }
  const resumed = await deps.db.$transaction(async (tx) => {
    const current = await jiraRowOf(tx, organizationId, input.connectionId);
    return current === null
      ? null
      : activateJiraInTx({ tx, audit: deps.audit, notices: deps.notices, clock: deps.clock }, current, {
          actor: memberActor(deps.scope),
          extra: { webhookMode: "polling", webhookSecretSecretRef: null, badSignatureAt: null },
          mode: "polling",
        });
  });
  if (resumed === null) {
    return refuse("changed", "The connection changed meanwhile. Open it again.");
  }
  await dropSecrets(deps, organizationId, [row.webhookSecretSecretRef]);
  return { ok: true, connectionId: input.connectionId, mode: "polling", resumedBoards: resumed.boards };
};

/**
 * The first delivery with a valid signature (F-008/c1), called by core's webhook inbox (ticket 07)
 * in the transaction that claims it, for a pending Jira connection: `active`, `firstDeliveryAt` (so
 * the secret is no longer shown), `activatedAt`, and the paused boards of a revoked connection of
 * the same site resumed (`resumeBoardsInTx`). Audited `tracker.connected` by the system. Anything
 * but a pending Jira connection in webhooks mode, with its token and secret, activates nothing.
 */
export const activateOnFirstDelivery = async (
  deps: { readonly tx: Tx } & Pick<Ports, "audit" | "notices" | "clock">,
  input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId },
): Promise<{ readonly activated: boolean; readonly resumedBoards: number }> => {
  const row = await jiraRowOf(deps.tx, input.organizationId, input.connectionId);
  if (row?.state !== "pending" || row.webhookMode !== "webhooks" || row.accessTokenSecretRef === null || row.webhookSecretSecretRef === null || row.firstDeliveryAt !== null) {
    return { activated: false, resumedBoards: 0 };
  }
  const resumed = await activateJiraInTx(deps, row, {
    actor: { kind: "system", id: null },
    extra: { firstDeliveryAt: new Date(deps.clock.now()), badSignatureAt: null },
    mode: "webhooks",
  });
  return resumed === null ? { activated: false, resumedBoards: 0 } : { activated: true, resumedBoards: resumed.boards };
};

// ---------- a connected connection's changes ----------

export type RotateJiraSecretResult = UseCaseResult<{ readonly connectionId: ConnectionId; readonly secret: string }, "forbidden" | "no-connection" | "polling" | "not-ready" | "changed">;

/**
 * `Rotate the secret`, or step 3's `Make a new secret` (F-008/c8): a new secret takes the old one's
 * place, and the old one is deleted, so a delivery signed with it no longer verifies. The new
 * secret is answered this once. Audited `tracker.secret-rotated`, with no value.
 */
export const rotateJiraSecret = async (deps: JiraConnectionDeps, input: JiraConnectionInput): Promise<RotateJiraSecretResult> => {
  const denied = trackerAdminOnly(deps.scope);
  if (denied !== null) return denied;
  const organizationId = deps.scope.organizationId;
  const row = await jiraRowOf(deps.db, organizationId, input.connectionId);
  if (row === null) {
    return refuse("no-connection", NO_CONNECTION);
  }
  if (row.webhookMode !== "webhooks") {
    return refuse("polling", "This connection polls: it has no webhook secret");
  }
  if (row.externalWorkspaceId === null || row.accessTokenSecretRef === null) {
    return refuse("not-ready", "Find the site and save the token first");
  }
  const secret = newJiraWebhookSecret();
  const made = await putSecret(deps, organizationId, jiraSecretPurposes.webhookSecret, secret);
  const kept = await deps.db.$transaction(async (tx) => {
    const set = await tx.connection.updateMany({
      where: { id: row.id, organizationId, state: { not: "revoked" }, webhookSecretSecretRef: row.webhookSecretSecretRef },
      data: { webhookSecretSecretRef: made, badSignatureAt: null },
    });
    if (set.count !== 1) {
      return false;
    }
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: memberActor(deps.scope),
      action: "tracker.secret-rotated",
      entity: "connection",
      entityId: input.connectionId,
      data: { kind: "jira", firstDelivery: row.firstDeliveryAt !== null },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "connection", entityId: input.connectionId });
    return true;
  });
  if (!kept) {
    await deps.adapters.secretStore.delete(organizationId, made);
    return refuse("changed", "The secret changed meanwhile. Rotate it again.");
  }
  await dropSecrets(deps, organizationId, [row.webhookSecretSecretRef]);
  return { ok: true, connectionId: input.connectionId, secret };
};

export type DisconnectJiraResult = UseCaseResult<{ readonly connectionId: ConnectionId; readonly pausedBoards: number }, "forbidden" | "no-connection">;

/**
 * Disconnects a Jira connection (`disconnectTracker` for Jira; ADR 0071): `revoked`, its `appId`
 * given back, then its token and its webhook secret deleted from the secret store. A scoped token
 * can't be revoked through Jira's API, so deleting it is the revocation (the dialog says to revoke
 * it at admin.atlassian.com too), and ostra can't delete Jira's admin webhook: deliveries to its
 * URL are answered `410`. Its boards pause; the same site connected again resumes them.
 */
export const disconnectJira = async (deps: Omit<JiraConnectionDeps, "jira" | "corePublicUrl" | "corePublicUrlProblem">, input: JiraConnectionInput): Promise<DisconnectJiraResult> => {
  const denied = trackerAdminOnly(deps.scope);
  if (denied !== null) return denied;
  const organizationId = deps.scope.organizationId;
  const row = await jiraRowOf(deps.db, organizationId, input.connectionId);
  if (row === null) {
    return refuse("no-connection", NO_CONNECTION);
  }
  const revoked = await deps.db.$transaction((tx) =>
    revokeConnectionInTx({ tx, audit: deps.audit, notices: deps.notices, clock: deps.clock }, {
      organizationId,
      connectionId: input.connectionId,
      kind: "jira",
      actor: memberActor(deps.scope),
      data: { revokedAtTracker: false },
    }),
  );
  await dropSecrets(deps, organizationId, [row.accessTokenSecretRef, row.webhookSecretSecretRef, row.clientSecretSecretRef, row.refreshTokenSecretRef]);
  return { ok: true, connectionId: input.connectionId, pausedBoards: revoked.pausedBoards };
};
