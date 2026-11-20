-- Milestone 6's review (ticket 41, F-099): a refine draft's failed "Update ticket" write, so the
-- panel shows the version partly applied with "Retry sync". Additive only: a new enum and two
-- nullable columns; no row is rewritten.

-- CreateEnum
CREATE TYPE "DraftApplyPart" AS ENUM ('images', 'description', 'sub_tickets');

-- AlterTable
ALTER TABLE "refine_draft" ADD COLUMN     "applyFailedAt" TIMESTAMP(3),
ADD COLUMN     "applyFailedPart" "DraftApplyPart";
