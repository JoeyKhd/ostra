-- A proposal's comment (F-111, ADR 0044 amended; milestone 4's ticket 16). Additive only: a
-- "Remember this" proposal keeps the diff comment's ID or the PR comment's URL, so the note it
-- becomes, or the version a merge writes, names the comment as its source. Nothing to backfill.

-- AlterTable
ALTER TABLE "memory_proposal" ADD COLUMN "sourceRef" TEXT;
