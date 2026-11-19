import { randomUUID } from "node:crypto";

import type { Db } from "@ostra/db";
import { memberIdSchema, organizationIdSchema, userIdSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, UserId } from "@ostra/protocol";
import { z } from "zod";

import { MAX_PASSWORD_LENGTH, usernameSchema } from "../accounts.ts";
import type { UseCaseResult } from "./common.ts";
import { createCredentialAccountInTx } from "./seed-first-admin.ts";

// A second member for development and tests (spec section 11, item 1; Q165). Invites are milestone
// 4, so the demo and the tests seed one, through the same account code the first admin's seed uses
// (`createCredentialAccountInTx`). It refuses to run unless NODE_ENV is development or test, and
// `pnpm dev:seed-member` (packages/api/scripts) is its only caller outside tests: the production
// build doesn't include it.

export const seedMemberInputSchema = z.strictObject({
  username: usernameSchema,
  email: z.email().max(320),
  /** Hashed here; never stored or logged as given. */
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  role: z.enum(["admin", "member"]),
  /** The organization to join. Absent: the install's first one. */
  organizationId: organizationIdSchema.optional(),
});
export type SeedMemberInput = z.input<typeof seedMemberInputSchema>;

export type SeededMember = { readonly userId: UserId; readonly memberId: MemberId; readonly organizationId: OrganizationId };

export type SeedMemberDeps = {
  readonly db: Db;
  /** Hashes a password as the sign-in side checks it (better-auth's `hashPassword`). */
  readonly hashPassword: (password: string) => Promise<string>;
  /** The environment it runs in: refused unless `NODE_ENV` is `development` or `test`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
};

export type SeedMemberResult = UseCaseResult<{ readonly seeded: SeededMember }, "not-development" | "no-organization" | "taken" | "invalid-input">;

/** Whether this environment may seed accounts: development and test only. */
export const seedingAllowed = (env: Readonly<Record<string, string | undefined>>): boolean => {
  const mode = env["NODE_ENV"] ?? "development";
  return mode === "development" || mode === "test";
};

/** Seeds an account and its membership of an organization. Development and test only. */
export const seedMember = async (deps: SeedMemberDeps, raw: SeedMemberInput): Promise<SeedMemberResult> => {
  if (!seedingAllowed(deps.env ?? process.env)) {
    return { ok: false, error: "not-development", message: "Seeding a member runs only when NODE_ENV is development or test" };
  }
  const parsed = seedMemberInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "invalid-input", message: "A username, an email, a password and a role" };
  }
  const input = parsed.data;
  const organization =
    input.organizationId === undefined
      ? await deps.db.organization.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } })
      : await deps.db.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
  if (organization === null) {
    return { ok: false, error: "no-organization", message: "The install has no organization yet: start the server once first" };
  }
  const email = input.email.toLowerCase();
  const taken = await deps.db.user.findFirst({ where: { OR: [{ email }, { username: input.username }] }, select: { id: true } });
  if (taken !== null) {
    return { ok: false, error: "taken", message: "That username or email has an account already" };
  }
  const passwordHash = await deps.hashPassword(input.password);
  const now = deps.now?.() ?? new Date();
  const organizationId = organizationIdSchema.parse(organization.id);
  return deps.db.$transaction(async (tx): Promise<SeedMemberResult> => {
    const userId = userIdSchema.parse(randomUUID());
    await createCredentialAccountInTx(tx, { userId, username: input.username, email, passwordHash, instanceRole: null, mustChangePassword: false, now });
    const memberId = memberIdSchema.parse(randomUUID());
    await tx.member.create({ data: { id: memberId, organizationId, userId, role: input.role, createdAt: now } });
    return { ok: true, seeded: { userId, memberId, organizationId } };
  });
};
