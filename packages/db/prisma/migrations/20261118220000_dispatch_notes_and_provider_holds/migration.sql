-- Ticket 26: why a queued task still waits, and a provider's rate-limit hold. Both additive and
-- nullable, so an install upgrades without a backfill (AGENTS.md: add first).

-- AlterTable
ALTER TABLE "model_provider" ADD COLUMN "dispatchHeldUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "task" ADD COLUMN "dispatchNote" TEXT;
