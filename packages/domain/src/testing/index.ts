import type { Db } from "@ostra/db";

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
