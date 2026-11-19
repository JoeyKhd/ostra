-- Milestone 1's ticket 42 (Q130, F-091): an admin's approval of a pool runner, for a pool that
-- requires approval. Additive: two nullable columns.

-- AlterTable
ALTER TABLE "runner" ADD COLUMN "approvedAt" TIMESTAMP(3),
ADD COLUMN "approvedByMemberId" TEXT;
