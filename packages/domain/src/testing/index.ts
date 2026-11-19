import { randomUUID } from "node:crypto";

import type { Db } from "@ostra/db";
import { organizationIdSchema } from "@ostra/protocol";
import type { OrganizationId } from "@ostra/protocol";

import { seedMember as seedMemberWith } from "../use-cases/seed-member.ts";
import type { SeedMemberInput, SeedMemberResult } from "../use-cases/seed-member.ts";

// @ostra/domain/testing: what tests across packages seed with (spec section 8). Vitest only.

/**
 * A member for a test (spec section 8, Q165): the same code `pnpm dev:seed-member` calls, with a
 * test's hash in place of better-auth's, so it signs in nowhere. A test that signs in passes the
 * real hasher to `seedMember` from `@ostra/domain` instead.
 */
export const seedMember = (db: Db, input: SeedMemberInput): Promise<SeedMemberResult> =>
  seedMemberWith({ db, hashPassword: (password) => Promise.resolve(`test-hash:${String(password.length)}`), env: { NODE_ENV: "test" } }, input);

/** A seeded organization (spec section 8): the second organization of every isolation and access test. */
export type SeededOrganization = { readonly organizationId: OrganizationId; readonly name: string; readonly slug: string };

/**
 * An organization for a test, beside the install's first (spec section 8). One organization per
 * install is v1's product (F-134); a second exists only in fixtures, so isolation stays tested.
 */
export const seedOrganization = async (db: Db, input: { readonly name: string }): Promise<SeededOrganization> => {
  const organizationId = organizationIdSchema.parse(randomUUID());
  const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "org"}-${organizationId.slice(0, 8)}`;
  await db.organization.create({ data: { id: organizationId, name: input.name, slug, createdAt: new Date() } });
  return { organizationId, name: input.name, slug };
};
