-- F-001 (2026-11-19): the seeded first admin's default password must be changed at its first
-- sign-in. Additive, with a default, so an install upgrades without a backfill (AGENTS.md: add first).

-- AlterTable
ALTER TABLE "user" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
