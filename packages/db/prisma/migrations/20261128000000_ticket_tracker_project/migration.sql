-- Milestone 6's review (ticket 41, F-011): the tracker's own project on the ticket cache, so an
-- intake rule's filter on it matches. Additive only: two nullable columns, filled by the next read
-- of each ticket (a webhook, a poll or the reconcile); a row not read again yet matches no project.

-- AlterTable
ALTER TABLE "ticket" ADD COLUMN     "trackerProjectId" TEXT,
ADD COLUMN     "trackerProjectName" TEXT;
