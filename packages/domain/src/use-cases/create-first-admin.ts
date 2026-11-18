import type { Db } from "@ostra/db";
import type { MemberId, OrganizationId, UserId } from "@ostra/protocol";
import { z } from "zod";

import type { AuditLog, ChangeNotices, Clock } from "../ports.ts";
import { notImplemented } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// F-001, F-002, Q117: the first account becomes the instance admin and the admin of the first
// organization, created with it, under a Postgres advisory lock so only one account ever gets it.
// It needs the setup token from the server's log; once an account exists, the token stops working
// and sign-up closes. Written by ticket 30.

export const createFirstAdminInputSchema = z.strictObject({
  /** The setup token. Never logged. */
  setupToken: z.string().min(16).max(512),
  username: z
    .string()
    .min(2)
    .max(39)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits and inner hyphens"),
  email: z.email().max(320),
  /** Hashed by better-auth; never stored or logged as given. */
  password: z.string().min(12).max(256),
  organizationName: z.string().trim().min(1).max(128),
});
export type CreateFirstAdminInput = z.infer<typeof createFirstAdminInputSchema>;

export type CreateFirstAdminResult = UseCaseResult<
  { readonly userId: UserId; readonly memberId: MemberId; readonly organizationId: OrganizationId },
  "wrong-setup-token" | "already-set-up" | "username-taken" | "email-taken"
>;

export type CreateFirstAdminDeps = {
  /** The use case takes the advisory lock in its own transaction. */
  readonly db: Db;
  /** The token the server generated or read from OSTRA_SETUP_TOKEN. */
  readonly expectedSetupToken: string;
  readonly audit: AuditLog;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
};

export type CreateFirstAdmin = (deps: CreateFirstAdminDeps, input: CreateFirstAdminInput) => Promise<CreateFirstAdminResult>;

export const createFirstAdmin: CreateFirstAdmin = () => notImplemented("30");
