import type { Db } from "@ostra/db";
import type { Logger } from "@ostra/adapter-sdk";
import type { LinearAppKit, MemberScope, Ports, ServerSettings } from "@ostra/domain";

import type { OstraAuth } from "../auth/create-auth.ts";
import { loadMemberContext, resolveSession } from "../auth/scope.ts";
import type { MemberContext, SessionUser } from "../auth/scope.ts";
import type { CatalogSource } from "../catalog/catalog-source.ts";
import type { AgentEffort } from "../services/agent-effort.ts";
import type { BlobStoreView } from "../services/blob-store-view.ts";
import type { EmailDirectory } from "../services/email.ts";
import type { TrackerDirectory } from "../services/trackers.ts";
import type { StreamHub } from "../stream/hub.ts";

/** The settings the routers read: a subset of the server's, so a test names only what it needs. */
export type ApiSettings = Pick<
  ServerSettings,
  | "mode"
  | "publicUrl"
  | "corePublicUrl"
  | "catalogFetch"
  | "allowDefaultPassword"
  // Milestone 2: the storage page and the Linear page read these (tickets 27 and 31).
  | "retentionDays"
  | "blobStore"
  | "trackerPollSeconds"
  | "reconcileMinutes"
  // The task page: when a box's idle stop is due, and the spend cap (ticket 30).
  | "boxIdleMinutes"
  | "taskSpendCapMicroUsd"
  | "taskTokenCap"
  // Milestone 3: the email page and the notification choices read the email settings and their delay
  // (ticket 37); the Account page reads how long a CLI session lasts (ticket 39).
  | "email"
  | "emailDelaySeconds"
  | "cliSessionDays"
  // Milestone 4: the budget page's warn share (ticket 27), a project's repo limit (ticket 30).
  | "budgetWarnPercent"
  | "projectMaxRepos"
  // Milestone 4: Insights say when they're stale (F-108, ticket 37).
  | "insightsIntervalMinutes"
>;

/** Everything the routers need, built once per server process (ADR 0016: the panel owns these). */
export type ApiDeps = {
  readonly db: Db;
  readonly auth: OstraAuth;
  readonly settings: ApiSettings;
  /** The jobs, outbox, notices, audit, clock and adapters. Tests give in-memory ones. */
  readonly ports: Ports;
  readonly logger: Logger;
  /** better-auth's `hashPassword`, handed to the domain so it doesn't import the auth library. */
  readonly hashPassword: (password: string) => Promise<string>;
  readonly catalog: CatalogSource;
  /** F-137: the levels each agent can send for a model, and whether it takes one at all (ADR 0066). */
  readonly agentEffort: AgentEffort;
  /** The blob store's name and health, for the storage page (F-114, ticket 31). */
  readonly blobStore: BlobStoreView;
  /** The organization's tracker connection as an adapter (tickets 27 to 29). */
  readonly trackers: TrackerDirectory;
  /** The calls the Linear connection flow makes to Linear (ticket 27). */
  readonly linear: LinearAppKit;
  /** The adapters that send mail for the install's email, by provider (ticket 37); the test mail goes through one. */
  readonly email: EmailDirectory;
  /** The live stream's tailer: one per web process (ADR 0035). */
  readonly stream: StreamHub;
  /** How often an open stream looks at its member's session and access again. Default 30 s. */
  readonly streamRecheckMs?: number;
};

/** What each request resolves once: the session, and the member it is acting as. */
export type Context = {
  readonly deps: ApiDeps;
  /** The request's headers, for better-auth. */
  readonly headers: Headers;
  /** Headers the response will carry (the session cookie of a sign-in). */
  readonly resHeaders: Headers;
  readonly user: SessionUser | null;
  readonly member: MemberContext | null;
  /**
   * Looks at who this request is now: its session and membership again, from the database. An open
   * stream calls it on a timer, so a revoked session or membership ends it (ADR 0035).
   */
  readonly revalidate: () => Promise<MemberContext | null>;
};

export type CreateContextInput = {
  readonly headers: Headers;
  readonly resHeaders: Headers;
};

export const createContext = async (deps: ApiDeps, input: CreateContextInput): Promise<Context> => {
  const user = await resolveSession(deps.auth, input.headers);
  const member = user === null ? null : await loadMemberContext(deps.db, user);
  const revalidate = async (): Promise<MemberContext | null> => {
    const now = await resolveSession(deps.auth, input.headers);
    return now === null ? null : loadMemberContext(deps.db, now);
  };
  return { deps, headers: input.headers, resHeaders: input.resHeaders, user, member, revalidate };
};

export type { MemberScope };
