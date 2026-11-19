import type { Db } from "@ostra/db";
import type { Logger } from "@ostra/adapter-sdk";
import type { MemberScope, Ports, ServerSettings } from "@ostra/domain";

import type { OstraAuth } from "../auth/create-auth.ts";
import { loadMemberContext, resolveSession } from "../auth/scope.ts";
import type { MemberContext, SessionUser } from "../auth/scope.ts";
import type { CatalogSource } from "../catalog/catalog-source.ts";
import type { StreamHub } from "../stream/hub.ts";

/** The settings the routers read: a subset of the server's, so a test names only what it needs. */
export type ApiSettings = Pick<
  ServerSettings,
  "mode" | "publicUrl" | "corePublicUrl" | "catalogFetch" | "openSignupAccounts" | "openSignupOrganizations" | "allowDefaultPassword"
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
